const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");      // ✅ use built-in crypto instead of nanoid
const QRCode = require("qrcode");
const db = require("../db");

const router = express.Router();

// Generates a URL-safe token with the requested length (default 24)
function generateToken(len = 24) {
  // 18 random bytes -> base64url => ~24 chars, slice to exact len
  if (Buffer.from("a").toString("base64url")) {
    // Node 16+ supports 'base64url'
    return crypto.randomBytes(Math.ceil((len * 3) / 4)).toString("base64url").slice(0, len);
  }
  // Fallback: standard base64 => strip + / = and slice
  return crypto
    .randomBytes(Math.ceil((len * 3) / 4))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
    .slice(0, len);
}


/* ---------------------- Multer: uploads/ config ---------------------- */
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, "uploads/"); // store all user uploads under /uploads
  },
  filename: function (_req, file, cb) {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});
const upload = multer({ storage });

/* ---------------------- Registration ---------------------- */

// GET /register
router.get("/register", (_req, res) => {
  res.render("register");
});

// POST /register (with profile picture)
router.post("/register", upload.single("profilePicture"), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, constituency, password } = req.body;

    if (!firstName || !lastName || !email || !phone || !constituency || !password) {
      return res.status(400).send("Missing required fields");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const profilePicturePath = req.file ? req.file.path.replace(/\\/g, "/") : null;

    const q = `
      INSERT INTO Citizen
        (First_Name, Last_Name, Email, Phone_Number, Address, Constituency, Password, profile_picture_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      q,
      [firstName, lastName, email, phone, address || null, constituency, hashedPassword, profilePicturePath],
      (err) => {
        if (err) {
          if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).send("Email or phone already exists.");
          }
          console.error("Registration error:", err);
          return res.status(500).send("Error during registration");
        }
        res.redirect("/login");
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).send("Error during registration");
  }
});

/* ---------------------- Login / Logout ---------------------- */

// GET /login
router.get("/login", (req, res) => {
  if (req.query.redirect) {
    req.session.postLoginRedirect = req.query.redirect;
  }
  res.render("login");
});

// POST /login
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  const q = "SELECT * FROM Citizen WHERE Email = ?";
  db.query(q, [email], async (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).send("Invalid email or password");
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.Password);
    if (!isMatch) {
      return res.status(401).send("Invalid email or password");
    }

    // Set session data
    req.session.userId = user.Citizen_ID;
    req.session.userName = `${user.First_Name} ${user.Last_Name}`;
    req.session.userConstituency = user.Constituency;

    const nextUrl = req.session.postLoginRedirect || "/dashboard";
    delete req.session.postLoginRedirect;

    // Save session before redirect to avoid race
    req.session.save((e) => {
      if (e) console.error("session save error:", e);
      res.redirect(nextUrl);
    });
  });
});

// GET /logout
router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.send("Error logging out.");
    res.redirect("/login");
  });
});

/* ---------------------- Report + History page ---------------------- */

// GET /report (form + my active/past issues with timeline)
router.get("/report", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");

  const citizenId = req.session.userId;

  // Include Due_At so SLA badge renders on the page
  const qActive = `
    SELECT Issue_ID, Title, Issue_Type, Description, Location, Image, Govt_Dept, Status, Created_At, Due_At
    FROM Issues
    WHERE Citizen_ID = ? AND Status IN ('Pending','In Progress')
    ORDER BY Created_At DESC
  `;
  const qPast = `
    SELECT Issue_ID, Title, Issue_Type, Description, Location, Image, Govt_Dept, Status, Created_At, Due_At
    FROM Issues
    WHERE Citizen_ID = ? AND Status IN ('Resolved','Closed')
    ORDER BY Created_At DESC
  `;

  db.query(qActive, [citizenId], (e1, activeRows) => {
    if (e1) {
      console.error(e1);
      return res.status(500).send("Failed to load active issues");
    }
    db.query(qPast, [citizenId], (e2, pastRows) => {
      if (e2) {
        console.error(e2);
        return res.status(500).send("Failed to load past issues");
      }

      const all = [...activeRows, ...pastRows];
      const ids = all.map((r) => r.Issue_ID);

      if (ids.length === 0) {
        return res.render("report_and_history", {
          active: [],
          past: [],
          eventsByIssue: {},
          flash: req.query.ok ? "Issue submitted ✅" : null,
          // Provide server-side helper for status badge class (optional if template defines it)
          badgeClass: (s) => {
            if (!s) return "b-pending";
            const k = ("" + s).toLowerCase();
            if (k.includes("progress")) return "b-progress";
            if (k.includes("resolve")) return "b-resolved";
            if (k.includes("close")) return "b-closed";
            return "b-pending";
          },
        });
      }

      // Pull timeline events; if table not present yet, render without it
      const qEvents = `
        SELECT Issue_ID, From_Status, To_Status, Note, Created_At
        FROM Issue_Events
        WHERE Issue_ID IN (${ids.map(() => "?").join(",")})
        ORDER BY Created_At ASC
      `;
      db.query(qEvents, ids, (e3, eventRows) => {
        let eventsByIssue = {};
        if (!e3 && eventRows && eventRows.length) {
          eventRows.forEach((ev) => {
            (eventsByIssue[ev.Issue_ID] ||= []).push(ev);
          });
        } else if (e3 && e3.code !== "ER_NO_SUCH_TABLE") {
          console.error("Issue_Events query error:", e3);
        }

        res.render("report_and_history", {
          active: activeRows,
          past: pastRows,
          eventsByIssue,
          flash: req.query.ok ? "Issue submitted ✅" : null,
          badgeClass: (s) => {
            if (!s) return "b-pending";
            const k = ("" + s).toLowerCase();
            if (k.includes("progress")) return "b-progress";
            if (k.includes("resolve")) return "b-resolved";
            if (k.includes("close")) return "b-closed";
            return "b-pending";
          },
        });
      });
    });
  });
});

/* ---------------------- Submit Issue handler ---------------------- */

// POST /report-issue
router.post("/report-issue", upload.single("image"), (req, res) => {
  if (!req.session.userId) return res.redirect("/login");

  const citizenId = req.session.userId;
  const { title, issueType, description, location, govtDept, lat, lon } = req.body;
  const imagePath = req.file ? req.file.path.replace(/\\/g, "/") : null;
  const status = "Pending";

  // 1) QR token
 // 1) QR token
const token = generateToken(24);

  // 2) Insert issue (without Due_At), then compute Due_At and QR image
  const insert = `
    INSERT INTO Issues
      (Citizen_ID, Title, Issue_Type, Description, Image, Location, Govt_Dept, Status, Lat, Lon, QR_Token)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `;
  db.query(
    insert,
    [
      citizenId,
      title || null,
      issueType,
      description,
      imagePath,
      location,
      govtDept,
      status,
      lat || null,
      lon || null,
      token,
    ],
    (err, result) => {
      if (err) {
        console.error("Error submitting issue:", err);
        return res.status(500).send("Error submitting issue");
      }

      const issueId = result.insertId;

      // 3) Compute Due_At from Issue_SLA
      const slaSql = `
        UPDATE Issues I
        JOIN Issue_SLA S ON S.Dept = I.Govt_Dept AND S.Issue_Type = I.Issue_Type
        SET I.Due_At = DATE_ADD(I.Created_At, INTERVAL S.SLA_Hours HOUR)
        WHERE I.Issue_ID = ?
      `;
      db.query(slaSql, [issueId], () => {
        // Gamification
        db.query("UPDATE citizen SET Points = Points + 5 WHERE Citizen_ID = ?", [citizenId], () => {});
        // Audit seed
        db.query(
          "INSERT INTO Issue_Events (Issue_ID, Actor_Official_ID, From_Status, To_Status, Note) VALUES (?,?,?,?,?)",
          [issueId, null, null, "Pending", "Issue created"],
          () => {}
        );

        // 4) Generate QR sticker PNG
        const qrDir = path.join(process.cwd(), "uploads", "qrs");
        if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

        const scanUrl = `${req.protocol}://${req.get("host")}/scan/${token}`;
        const outPng = path.join(qrDir, `issue_${issueId}.png`);

        QRCode.toFile(outPng, scanUrl, { width: 512 }, (e) => {
          if (e) console.error("QR gen error:", e);
          res.redirect("/report?ok=1");
        });
      });
    }
  );
});

/* ---------------------- Home (profile dashboard) ---------------------- */

router.get("/home", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  const q = "SELECT * FROM Citizen WHERE Citizen_ID = ?";
  db.query(q, [req.session.userId], (err, results) => {
    if (err || results.length === 0) {
      console.error("User not found:", err);
      return res.send("User not found.");
    }
    const user = results[0];
    res.render("home", { user });
  });
});

module.exports = router;

// routes/official.js
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const router = express.Router();

/* ---------- helpers ---------- */
function requireOfficial(req, res, next) {
  if (!req.session || !req.session.officialId) {
    const nextUrl = encodeURIComponent(req.originalUrl || "/official/home");
    return res.redirect(`/official/login?redirect=${nextUrl}`);
  }
  next();
}

/* ---------- login ---------- */

// GET /official/login
router.get("/login", (req, res) => {
  if (req.query.redirect) req.session.postLoginOfficialRedirect = req.query.redirect;
  res.render("officialLogin");
});

// POST /official/login
router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const q = "SELECT * FROM Officials WHERE Email = ?";
  db.query(q, [email], async (err, rows) => {
    if (err || rows.length === 0) return res.status(401).send("Invalid email or password");
    const official = rows[0];
    const ok = await bcrypt.compare(password, official.Password);
    if (!ok) return res.status(401).send("Invalid email or password");

    req.session.officialId = official.Official_ID;
    req.session.officialDept = official.Department;
    req.session.officialConstituency = official.Constituency;
    req.session.officialName = `${official.First_Name} ${official.Last_Name}`;
    const nextUrl = req.session.postLoginOfficialRedirect || "/official/home";
    delete req.session.postLoginOfficialRedirect;

    req.session.save((e) => {
      if (e) console.error("session save error:", e);
      res.redirect(nextUrl);
    });
  });
});

/* ---------- home: issues + announcements ---------- */
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(process.cwd(), "uploads", "closures");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_"))
});
const uploadClosure = multer({ storage });

// ...

router.post("/updateStatus", requireOfficial, uploadClosure.single("closedImage"), (req, res) => {
  const { issueId, newStatus, note, closedLat, closedLon } = req.body;
  const officialId = req.session.officialId;

  db.query("SELECT Status FROM Issues WHERE Issue_ID = ?", [issueId], (e1, rows) => {
    if (e1 || rows.length === 0) return res.status(404).send("Issue not found");
    const oldStatus = rows[0].Status;

    // If moving to Resolved/Closed, require after-photo + GPS
    let closureSet = "";
    const params = [newStatus, issueId];
    if (newStatus === "Resolved" || newStatus === "Closed") {
      if (!req.file || !closedLat || !closedLon) {
        return res.status(400).send("Closure requires a photo and GPS (lat/lon).");
      }
      closureSet = ", Closed_Image=?, Closed_Lat=?, Closed_Lon=?";
      params.unshift(req.file.path.replace(/\\/g, "/")); // will reorder below
      params.splice(2, 0, closedLat, closedLon); // after image
      // Rebuild params = [newStatus, image, lat, lon, issueId]
      params.length = 0; // reset and push in order
      params.push(newStatus, req.file.path.replace(/\\/g, "/"), closedLat, closedLon, issueId);
    }

    const sql = `UPDATE Issues SET Status = ? ${closureSet} WHERE Issue_ID = ?`;
    db.query(sql, params, (e2) => {
      if (e2) { console.error(e2); return res.status(500).send("Update failed"); }

      db.query(
        "INSERT INTO Issue_Events (Issue_ID, Actor_Official_ID, From_Status, To_Status, Note) VALUES (?,?,?,?,?)",
        [issueId, officialId, oldStatus, newStatus, note || null],
        () => res.redirect("/official/home")
      );
    });
  });
});

// GET /official/home
router.get("/home", requireOfficial, (req, res) => {
  const dept = req.session.officialDept;
  const constituency = req.session.officialConstituency;
  const officialId = req.session.officialId;

  // Issues for this dept + constituency (by reporter’s constituency)
  // routes/official.js  (inside router.get("/home"...))
const qIssues = `
  SELECT I.Issue_ID, I.Title, I.Issue_Type, I.Description, I.Location,
         I.Image, I.Govt_Dept, I.Status, I.Created_At,
         I.Due_At, I.QR_Token,           -- ✅ add these
         C.Citizen_ID, C.First_Name, C.Last_Name, C.Constituency
  FROM Issues I
  JOIN citizen C ON C.Citizen_ID = I.Citizen_ID
  WHERE I.Govt_Dept = ? AND C.Constituency = ?
  ORDER BY FIELD(I.Status,'Pending','In Progress','Resolved','Closed'), I.Created_At DESC
  LIMIT 200
`;


  const qAnnouncements = `
    SELECT Announcement_ID, Title, Body, Priority, Department, Constituency,
           Visible_From, Visible_Until, Is_Active, Created_At
    FROM Announcements
    WHERE Official_ID = ?
    ORDER BY Created_At DESC
    LIMIT 30
  `;

  db.query(qIssues, [dept, constituency], (e1, issues) => {
    if (e1) { console.error(e1); return res.status(500).send("Failed to load issues"); }
    db.query(qAnnouncements, [officialId], (e2, anns) => {
      if (e2) { console.error(e2); return res.status(500).send("Failed to load announcements"); }
      res.render("officialHome", {
        me: { name: req.session.officialName, dept, constituency },
        issues,
        announcements: anns
      });
    });
  });
});

/* ---------- status update (with audit + optional notify) ---------- */

// POST /official/updateStatus
router.post("/updateStatus", requireOfficial, (req, res) => {
  const { issueId, newStatus, note } = req.body;
  const officialId = req.session.officialId;

  db.query("SELECT Status FROM Issues WHERE Issue_ID = ?", [issueId], (e1, rows) => {
    if (e1 || rows.length === 0) return res.status(404).send("Issue not found");
    const oldStatus = rows[0].Status;

    db.query("UPDATE Issues SET Status = ? WHERE Issue_ID = ?", [newStatus, issueId], (e2) => {
      if (e2) { console.error(e2); return res.status(500).send("Update failed"); }

      const ev = `
        INSERT INTO Issue_Events (Issue_ID, Actor_Official_ID, From_Status, To_Status, Note)
        VALUES (?,?,?,?,?)
      `;
      db.query(ev, [issueId, officialId, oldStatus, newStatus, note || null], (e3) => {
        if (e3) console.error("Issue_Events insert error:", e3);

        // (Optional) notify the reporter via email: services/notify.notifyOnStatusChange(issueId, newStatus)
        res.redirect("/official/home");
      });
    });
  });
});

/* ---------- announcement create ---------- */

// POST /official/announce
router.post("/announce", requireOfficial, (req, res) => {
  const officialId = req.session.officialId;
  const dept = req.session.officialDept;
  const constituency = req.session.officialConstituency;
  const { title, body, priority, visibleUntil } = req.body;

  const q = `
    INSERT INTO Announcements
      (Official_ID, Title, Body, Priority, Department, Constituency, Visible_Until)
    VALUES (?,?,?,?,?,?,?)
  `;
  db.query(
    q,
    [officialId, title.trim(), body.trim(), (priority || 'info'), dept, constituency, visibleUntil || null],
    (err) => {
      if (err) { console.error("Announcement error:", err); return res.status(500).send("Failed to create announcement"); }
      res.redirect("/official/home");
    }
  );
});

/* ---------- logout ---------- */

router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.send("Error logging out.");
    res.redirect("/official/login");
  });
});

module.exports = router;

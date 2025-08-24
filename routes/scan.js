// routes/scan.js
const express = require("express");
const db = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

const photoDir = path.join(process.cwd(), "uploads", "field");
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, photoDir),
  filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_"))
});
const upload = multer({ storage });

/* GET /scan/:token — show issue + event buttons */
router.get("/:token", (req, res) => {
  const token = req.params.token;
  const sql = `
    SELECT I.Issue_ID, I.Title, I.Issue_Type, I.Location, I.Status, I.QR_Token,
           I.Lat, I.Lon, I.Created_At, I.Due_At
    FROM Issues I WHERE I.QR_Token = ?
  `;
  db.query(sql, [token], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).send("Invalid QR.");
    const issue = rows[0];

    // Recent field events
    db.query("SELECT Event, Lat, Lon, Photo, Created_At FROM Issue_Field_Events WHERE Issue_ID = ? ORDER BY Created_At DESC LIMIT 20",
      [issue.Issue_ID],
      (e2, events) => {
        if (e2) console.error(e2);
        res.render("scan_issue", { issue, events: events || [] });
      }
    );
  });
});

/* POST /scan/:token/event — add crew event (ARRIVED/STARTED/COMPLETED) */
router.post("/:token/event", upload.single("photo"), (req, res) => {
  const token = req.params.token;
  const { event, lat, lon } = req.body;
  if (!['ARRIVED','STARTED','COMPLETED'].includes(event)) {
    return res.status(400).send("Invalid event.");
  }
  db.query("SELECT Issue_ID FROM Issues WHERE QR_Token = ?", [token], (e1, rows) => {
    if (e1 || rows.length === 0) return res.status(404).send("Invalid QR.");
    const issueId = rows[0].Issue_ID;

    const photo = req.file ? req.file.path.replace(/\\/g, "/") : null;
    const ins = `
      INSERT INTO Issue_Field_Events (Issue_ID, Event, Lat, Lon, Photo)
      VALUES (?,?,?,?,?)
    `;
    db.query(ins, [issueId, event, lat || null, lon || null, photo], (e2) => {
      if (e2) { console.error(e2); return res.status(500).send("Failed to save event."); }
      res.redirect(`/scan/${token}`);
    });
  });
});

module.exports = router;

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const db = require("../db");

const router = express.Router();
function token(n=24){
  return crypto.randomBytes(Math.ceil((n*3)/4)).toString("base64url").slice(0,n);
}

// minimal guard (replace with real auth later)
function requireSecret(req, res, next){
  if (req.query.secret !== (process.env.ADMIN_SECRET || "devsecret")) return res.status(403).send("Forbidden");
  next();
}

// Backfill QR tokens & PNGs for issues missing QR_Token
router.post("/backfill-qr", requireSecret, (req, res) => {
  db.query("SELECT Issue_ID FROM Issues WHERE QR_Token IS NULL OR QR_Token = '' LIMIT 500", async (err, rows) => {
    if (err) return res.status(500).send("DB error");
    if (!rows.length) return res.send("Nothing to backfill.");

    const qrsDir = path.join(process.cwd(), "uploads", "qrs");
    if (!fs.existsSync(qrsDir)) fs.mkdirSync(qrsDir, { recursive: true });

    let done = 0, fail = 0;
    for (const r of rows) {
      const tok = token(24);
      try {
        await new Promise((resolve, reject) => {
          db.query("UPDATE Issues SET QR_Token=? WHERE Issue_ID=?", [tok, r.Issue_ID], (e)=> e ? reject(e) : resolve());
        });
        const scanUrl = `${req.protocol}://${req.get("host")}/scan/${tok}`;
        const file = path.join(qrsDir, `issue_${r.Issue_ID}.png`);
        await QRCode.toFile(file, scanUrl, { width: 512 });
        done++;
      } catch (e) { console.error("backfill error", r.Issue_ID, e); fail++; }
    }
    res.send(`Backfill complete. Success=${done}, Fail=${fail}`);
  });
});

module.exports = router;

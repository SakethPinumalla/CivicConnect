// routes/dashboard.js
const express = require("express");
const db = require("../db");

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    const nextUrl = encodeURIComponent(req.originalUrl || "/dashboard");
    return res.redirect(`/login?redirect=${nextUrl}`);
  }
  next();
}

router.get("/", requireLogin, (req, res) => {
  const citizenId = req.session.userId;
  const constituency = req.session.userConstituency || null;

  // 1) Current user points + name
  const qMe = `
    SELECT Citizen_ID, First_Name, Last_Name, Points, Constituency
    FROM citizen
    WHERE Citizen_ID = ?
  `;

  // 2) Active announcements for user’s constituency (or global/null) in visibility window
  const qAnnouncements = `
    SELECT Announcement_ID, Title, Body, Priority, Department, Constituency,
           Visible_From, Visible_Until, Created_At
    FROM Announcements
    WHERE Is_Active = 1
      AND Visible_From <= NOW()
      AND (Visible_Until IS NULL OR Visible_Until >= NOW())
      AND (Constituency = ? OR Constituency IS NULL)
    ORDER BY FIELD(Priority,'urgent','advisory','info'), Created_At DESC
    LIMIT 10
  `;

  // 3) Top issues (24h) — by Issue_Type; scoped to user’s constituency via reporter’s constituency
  const qTopIssues = `
    SELECT I.Issue_Type AS category, COUNT(*) AS count
    FROM Issues I
    JOIN citizen C ON C.Citizen_ID = I.Citizen_ID
    WHERE I.Created_At >= NOW() - INTERVAL 24 HOUR
      ${constituency ? "AND C.Constituency = ?" : ""}
    GROUP BY I.Issue_Type
    ORDER BY count DESC
    LIMIT 5
  `;

  // 4) Leaderboard — top citizens by points (same constituency)
  const qLeaderboard = `
    SELECT Citizen_ID, First_Name, Last_Name, Points
    FROM citizen
    ${constituency ? "WHERE Constituency = ?" : ""}
    ORDER BY Points DESC, Citizen_ID ASC
    LIMIT 10
  `;

  db.query(qMe, [citizenId], (e1, meRows) => {
    if (e1 || meRows.length === 0) {
      console.error("me error:", e1);
      return res.status(500).send("Failed to load dashboard.");
    }
    const me = meRows[0];
    const paramsAnn = [constituency || null];
    const paramsTop = constituency ? [constituency] : [];
    const paramsLb  = constituency ? [constituency] : [];

    db.query(qAnnouncements, paramsAnn, (e2, anns) => {
      if (e2) { console.error("ann err:", e2); return res.status(500).send("Failed to load announcements."); }
      db.query(qTopIssues, paramsTop, (e3, topRows) => {
        if (e3) { console.error("top err:", e3); return res.status(500).send("Failed to load top issues."); }
        db.query(qLeaderboard, paramsLb, (e4, leaders) => {
          if (e4) { console.error("lb err:", e4); return res.status(500).send("Failed to load leaderboard."); }
          res.render("dashboard", {
            me,
            announcements: anns,
            topIssues: topRows,
            leaders,
            constituency: me.Constituency || constituency || null
          });
        });
      });
    });
  });
});

module.exports = router;

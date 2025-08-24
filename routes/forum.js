// routes/forum.js
const express = require("express");
const db = require("../db");

const router = express.Router();

// Guard: must be logged in
function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    const nextUrl = encodeURIComponent(req.originalUrl || "/forum");
    return res.redirect(`/login?redirect=${nextUrl}`);
  }
  return next();
}

/**
 * GET /forum
 * List posts for user's constituency (optional), sortable by top|recent
 * ?sort=top|recent  (default: top)
 * ?all=1            (if provided, ignore constituency filter)
 */
router.get("/", requireLogin, (req, res) => {
  const sort = req.query.sort === "recent" ? "recent" : "top";
  const citizenId = req.session.userId;
  const constituency = req.session.userConstituency || null;
  const filterToMyConstituency = req.query.all ? false : true;

  const params = [];
  let where = "1=1";
  if (filterToMyConstituency && constituency) {
    where = " (p.Constituency = ? OR p.Constituency IS NULL) ";
    params.push(constituency);
  }

  const select = `
    SELECT 
      p.Post_ID, p.Title, p.Content, p.Citizen_ID, p.Constituency, p.Created_At,
      c.First_Name, c.Last_Name,
      IFNULL(uv.cnt, 0) AS upvotes,
      IF(u_me.hasvote IS NULL, 0, 1) AS upvoted
    FROM ForumPosts p
    JOIN citizen c ON c.Citizen_ID = p.Citizen_ID
    LEFT JOIN (
      SELECT Post_ID, COUNT(*) AS cnt FROM ForumUpvotes GROUP BY Post_ID
    ) uv ON uv.Post_ID = p.Post_ID
    LEFT JOIN (
      SELECT Post_ID, 1 AS hasvote FROM ForumUpvotes WHERE Citizen_ID = ?
    ) u_me ON u_me.Post_ID = p.Post_ID
    WHERE ${where}
  `;
  // parameter for the u_me subquery comes first
  params.unshift(citizenId);

  const orderBy =
    sort === "recent"
      ? " ORDER BY p.Created_At DESC "
      : " ORDER BY upvotes DESC, p.Created_At DESC ";

  const sql = select + orderBy + " LIMIT 200";

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("Forum list error:", err);
      return res.status(500).send("Failed to load forum.");
    }
    res.render("forum", {
      posts: rows,
      sort,
      constituency: filterToMyConstituency ? constituency : null,
      showAll: !filterToMyConstituency,
      me: { id: citizenId },
    });
  });
});

/**
 * POST /forum/new
 * Create a new thread (title + content). Optionally attaches user's constituency.
 * Awards +3 points to the author.
 */
router.post("/new", requireLogin, (req, res) => {
  const citizenId = req.session.userId;
  const userConstituency = req.session.userConstituency || null;
  const title = (req.body.title || "").trim();
  const content = (req.body.content || "").trim();

  if (!title || !content) {
    return res.status(400).send("Title and content are required.");
  }

  const sql = `
    INSERT INTO ForumPosts (Citizen_ID, Title, Content, Constituency)
    VALUES (?, ?, ?, ?)
  `;
  db.query(sql, [citizenId, title, content, userConstituency], (err) => {
    if (err) {
      console.error("Create post error:", err);
      return res.status(500).send("Failed to create post.");
    }
    // Gamification: +3 points to author
    db.query(
      "UPDATE citizen SET Points = Points + 3 WHERE Citizen_ID = ?",
      [citizenId],
      () => res.redirect("/forum?sort=recent")
    );
  });
});

/**
 * POST /forum/:postId/upvote
 * Insert IGNORE to enforce one vote per user.
 * Awards points only if a new upvote was inserted:
 *   voter +1, author +2
 */
router.post("/:postId/upvote", requireLogin, (req, res) => {
  const postId = parseInt(req.params.postId, 10);
  const citizenId = req.session.userId;
  if (!Number.isInteger(postId)) return res.status(400).send("Invalid post id.");

  const sql = "INSERT IGNORE INTO ForumUpvotes (Post_ID, Citizen_ID) VALUES (?, ?)";
  db.query(sql, [postId, citizenId], (err, result) => {
    if (err) {
      console.error("Upvote error:", err);
      return res.status(500).send("Failed to upvote.");
    }

    if (result && result.affectedRows === 1) {
      // New upvote → award points
      // +1 to the voter
      db.query("UPDATE citizen SET Points = Points + 1 WHERE Citizen_ID = ?", [citizenId]);

      // +2 to the post author (one-time per unique upvote)
      const authorSql = `
        UPDATE citizen c
        JOIN ForumPosts p ON c.Citizen_ID = p.Citizen_ID
        SET c.Points = c.Points + 2
        WHERE p.Post_ID = ?
      `;
      db.query(authorSql, [postId], () => res.redirect("back"));
    } else {
      // Already upvoted previously; nothing to award
      res.redirect("back");
    }
  });
});

/**
 * POST /forum/:postId/unvote
 * Allow users to remove their upvote.
 * Optionally remove awarded points if the upvote existed:
 *   voter -1, author -2
 */
router.post("/:postId/unvote", requireLogin, (req, res) => {
  const postId = parseInt(req.params.postId, 10);
  const citizenId = req.session.userId;
  if (!Number.isInteger(postId)) return res.status(400).send("Invalid post id.");

  const sql = "DELETE FROM ForumUpvotes WHERE Post_ID = ? AND Citizen_ID = ?";
  db.query(sql, [postId, citizenId], (err, result) => {
    if (err) {
      console.error("Unvote error:", err);
      return res.status(500).send("Failed to remove upvote.");
    }

    if (result && result.affectedRows === 1) {
      // Only adjust points if a row was actually deleted
      db.query("UPDATE citizen SET Points = GREATEST(0, Points - 1) WHERE Citizen_ID = ?", [citizenId]);
      const authorSql = `
        UPDATE citizen c
        JOIN ForumPosts p ON c.Citizen_ID = p.Citizen_ID
        SET c.Points = GREATEST(0, c.Points - 2)
        WHERE p.Post_ID = ?
      `;
      db.query(authorSql, [postId], () => res.redirect("back"));
    } else {
      res.redirect("back");
    }
  });
});

module.exports = router;

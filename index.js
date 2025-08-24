const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const path = require("path");
const session = require("express-session");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Configure session middleware
app.use(
  session({
    secret: "one1to2eight8", // Replace with a secure key
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24, // 1 day
      }, // Set to true if using HTTPS
  })
);

const authRoutes = require("./routes/auth");
const scanRoutes = require("./routes/scan");
app.use("/scan", scanRoutes);
const adminRoutes = require("./routes/admin");
app.use("/admin", adminRoutes);

// then hit POST: http://localhost:3000/admin/backfill-qr?secret=devsecret

app.set("view engine", "ejs"); // Use EJS for templating
app.use(express.static(path.join(__dirname, "public")));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// index.js (additional lines)
const officialRoutes = require("./routes/official");
app.use("/official", officialRoutes);

// index.js (additional line)
const forumRoutes = require("./routes/forum");
app.use("/forum", forumRoutes);

const dashboardRoutes = require("./routes/dashboard");
app.use("/dashboard", dashboardRoutes);

const cron = require("node-cron");
const db = require("./db");

// Recalculate Due_At for open issues in case SLAs changed; also fine if new issues missed earlier.
cron.schedule("*/10 * * * *", () => {
  const sql = `
    UPDATE Issues I
    JOIN Issue_SLA S ON S.Dept = I.Govt_Dept AND S.Issue_Type = I.Issue_Type
    SET I.Due_At = DATE_ADD(I.Created_At, INTERVAL S.SLA_Hours HOUR)
    WHERE I.Status IN ('Pending','In Progress')
      AND (I.Due_At IS NULL OR ABS(TIMESTAMPDIFF(MINUTE, I.Due_At, DATE_ADD(I.Created_At, INTERVAL S.SLA_Hours HOUR))) > 1)
  `;
  db.query(sql, (err) => {
    if (err) console.error("[cron] SLA update error:", err);
  });
});


// Use auth routes
app.use("/", authRoutes);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}/login`);
});

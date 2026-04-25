const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
initSqlJs().then(SQL => {
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  const r1 = db.exec("SELECT COUNT(*) FROM github_notifications WHERE subject_type='PullRequest' AND unread=1 AND subject_url IS NOT NULL");
  console.log('Total PR notifications:', r1[0].values[0][0]);
  const r2 = db.exec("SELECT COUNT(DISTINCT subject_url) FROM github_notifications WHERE subject_type='PullRequest' AND unread=1 AND subject_url IS NOT NULL");
  console.log('Distinct PR URLs:', r2[0].values[0][0]);
  db.close();
});

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  console.log('=== Content of first Royal London page ===');
  const r = db.exec(`
    SELECT c.page_title, LENGTH(c.page_content) as len, SUBSTR(c.page_content, 1, 300) as preview
    FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE g.name = 'Royal London' AND c.page_title LIKE '%Royal London%'
  `);
  
  if (r[0]) {
    const row = r[0].values[0];
    console.log('Title:', row[0]);
    console.log('Content length:', row[1], 'bytes');
    console.log('Content preview:', row[2]);
  }
  
  db.close();
});

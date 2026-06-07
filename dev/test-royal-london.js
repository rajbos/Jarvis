const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  console.log('=== Test: Search "royal london" (two words) ===');
  const r = db.exec(`
    SELECT g.name, c.page_title, c.page_index
    FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE (LOWER(COALESCE(c.page_title,'')) LIKE '%royal%' OR LOWER(COALESCE(c.page_content,'')) LIKE '%royal%')
      AND (LOWER(COALESCE(c.page_title,'')) LIKE '%london%' OR LOWER(COALESCE(c.page_content,'')) LIKE '%london%')
    ORDER BY g.name, c.page_index
  `);
  
  if (r[0]) {
    console.log(`Found ${r[0].values.length} pages with BOTH "royal" AND "london":`);
    r[0].values.forEach(row => {
      console.log('  - "' + row[1] + '" (group: ' + row[0] + ', index: ' + row[2] + ')');
    });
  } else {
    console.log('No pages with both "royal" and "london"');
  }
  
  db.close();
});

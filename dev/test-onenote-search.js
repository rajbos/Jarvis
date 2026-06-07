const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  console.log('=== Test 1: All Royal London pages ===');
  let r = db.exec(`
    SELECT g.name, c.page_title FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE g.name = 'Royal London'
  `);
  if (r[0]) {
    console.log(`Found ${r[0].values.length} pages`);
    r[0].values.forEach(row => console.log('  -', row[1]));
  }
  
  console.log('\n=== Test 2: Search "royal" ===');
  r = db.exec(`
    SELECT g.name, c.page_title FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE LOWER(c.page_title) LIKE '%royal%' OR LOWER(c.page_content) LIKE '%royal%'
  `);
  if (r[0]) {
    console.log(`Found ${r[0].values.length} pages`);
    r[0].values.forEach(row => console.log('  -', row[1], '(group:', row[0], ')'));
  } else {
    console.log('No matches');
  }
  
  console.log('\n=== Test 3: Exact group match ===');
  r = db.exec(`SELECT id, name FROM groups WHERE name = 'Royal London'`);
  if (r[0]) {
    const groupId = r[0].values[0][0];
    console.log(`Royal London group_id: ${groupId}`);
    
    r = db.exec(`
      SELECT COUNT(*) FROM onedrive_customer_folders 
      WHERE group_id = ${groupId}
    `);
    const folderCount = r[0].values[0][0];
    console.log(`Folders linked: ${folderCount}`);
    
    r = db.exec(`
      SELECT COUNT(*) FROM onedrive_onenote_cache c
      JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
      WHERE cf.group_id = ${groupId}
    `);
    const pageCount = r[0].values[0][0];
    console.log(`Pages cached: ${pageCount}`);
  }
  
  db.close();
});

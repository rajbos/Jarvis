const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  console.log('=== ruddr_projects table ===');
  try {
    const schema = db.exec(`PRAGMA table_info(ruddr_projects)`);
    console.log('Columns:');
    schema[0].values.forEach(col => {
      console.log(`  - ${col[1]} (${col[2]})`);
    });
    
    const count = db.exec(`SELECT COUNT(*) FROM ruddr_projects`);
    console.log(`\nTotal rows: ${count[0].values[0][0]}`);
    
    const sample = db.exec(`SELECT * FROM ruddr_projects LIMIT 3`);
    if (sample[0]) {
      console.log('\nSample data:');
      sample[0].values.forEach(row => {
        console.log('  -', row);
      });
    }
  } catch (e) {
    console.log('Error querying ruddr_projects:', e.message);
  }
  
  console.log('\n=== groups table ===');
  try {
    const schema = db.exec(`PRAGMA table_info(groups)`);
    console.log('Columns:');
    schema[0].values.forEach(col => {
      console.log(`  - ${col[1]} (${col[2]})`);
    });
    
    const sample = db.exec(`SELECT * FROM groups LIMIT 5`);
    if (sample[0]) {
      console.log('\nSample data:');
      sample[0].values.forEach(row => {
        console.log('  -', row);
      });
    }
  } catch (e) {
    console.log('Error querying groups:', e.message);
  }
  
  db.close();
});

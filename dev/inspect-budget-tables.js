const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  // Check all tables
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('All tables in database:');
  tables[0].values.forEach(row => console.log('  -', row[0]));
  
  // Look for budget-related tables
  const budgetTables = ['project_budget', 'budget', 'actuals', 'project_actuals', 'financials', 'costs'];
  console.log('\nChecking for budget/actuals tables:');
  budgetTables.forEach(t => {
    try {
      const r = db.exec(`SELECT COUNT(*) FROM ${t}`);
      console.log(`  - ${t}: EXISTS (${r[0].values[0][0]} rows)`);
    } catch {
      console.log(`  - ${t}: not found`);
    }
  });
  
  db.close();
});

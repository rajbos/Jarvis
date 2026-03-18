const initSqlJs = require(require('path').resolve(__dirname, '../../../node_modules/sql.js'));
const fs = require('fs');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
initSqlJs().then(SQL => {
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  const ver = db.exec('PRAGMA user_version')[0].values[0][0];
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const tableNames = tables.length > 0 ? tables[0].values.map(r => r[0]) : [];
  console.log('user_version:', ver);
  console.log('tables:', tableNames.join(', '));
  db.close();
});

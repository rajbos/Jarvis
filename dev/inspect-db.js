const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  console.log('path:', dbPath);
  console.log('user_version:', db.exec('PRAGMA user_version')[0].values[0][0]);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('tables:', tables[0].values.map(r => r[0]).join(', '));
  for (const t of ['github_auth', 'github_orgs', 'github_repos', 'config', 'local_repos', 'local_scan_folders', 'agent_config', 'groups']) {
    try {
      const r = db.exec('SELECT COUNT(*) FROM ' + t);
      console.log(t + ':', r[0].values[0][0]);
    } catch (e) {
      console.log(t + ': MISSING (' + e.message + ')');
    }
  }
});

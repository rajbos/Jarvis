const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Import the searchProjectBudgetForChat function (we'll simulate it here)
initSqlJs().then(SQL => {
  const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  console.log('=== Test 1: Search Royal London ===');
  const groupStmt = db.prepare(`
    SELECT id, name, ruddr_project_name, ruddr_project_paths 
    FROM groups 
    WHERE LOWER(name) LIKE LOWER(?)
  `);
  groupStmt.bind(['%london%']);
  
  if (groupStmt.step()) {
    const group = groupStmt.getAsObject();
    console.log('Found group:', group.name);
    console.log('Ruddr project names:', group.ruddr_project_name);
    
    const projectNames = JSON.parse(group.ruddr_project_name);
    console.log(`Parsing ${projectNames.length} projects:`);
    
    const projectStmt = db.prepare(`
      SELECT name, path
      FROM ruddr_projects
      WHERE name IN (${projectNames.map(() => '?').join(',')})
      ORDER BY name
    `);
    projectStmt.bind(projectNames);
    
    while (projectStmt.step()) {
      const proj = projectStmt.getAsObject();
      console.log(`  - ${proj.name}`);
    }
    projectStmt.free();
  }
  groupStmt.free();
  
  console.log('\n=== Test 2: Search Colruyt ===');
  const stmt2 = db.prepare(`SELECT id, name FROM groups WHERE LOWER(name) LIKE LOWER(?)`);
  stmt2.bind(['%colruyt%']);
  if (stmt2.step()) {
    const group = stmt2.getAsObject();
    console.log('Found group:', group.name, '(id:', group.id, ')');
  }
  stmt2.free();
  
  console.log('\n=== Test 3: Invalid search ===');
  const stmt3 = db.prepare(`SELECT id, name FROM groups WHERE LOWER(name) LIKE LOWER(?)`);
  stmt3.bind(['%nonexistent%']);
  if (stmt3.step()) {
    console.log('Found:', stmt3.getAsObject().name);
  } else {
    console.log('No results (as expected)');
  }
  stmt3.free();
  
  db.close();
});

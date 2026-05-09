const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// We'll modify the groups:set-ruddr-project handler to:
// 1. When setting a project, look up its path from the cache
// 2. Store both name and path in the database

// Find the handler start
const handlerStart = "ipcMain.handle('groups:set-ruddr-project', (_event, groupId: number, projectName: string | null) => {";
const startIdx = content.indexOf(handlerStart);

if (startIdx === -1) {
  console.error('Could not find handler');
  process.exit(1);
}

// Find the end of this handler (the closing }); before groups:remove-ruddr-project)
const nextHandler = content.indexOf("ipcMain.handle('groups:remove-ruddr-project'", startIdx);
if (nextHandler === -1) {
  console.error('Could not find next handler');
  process.exit(1);
}

// Replace the entire handler
const newHandler = `  ipcMain.handle('groups:set-ruddr-project', (_event, groupId: number, projectName: string | null) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    try {
      if (projectName === null || projectName === undefined) {
        // Clear all linked projects
        db.run(
          \`UPDATE groups SET ruddr_project_name = NULL, ruddr_project_paths = NULL, updated_at = datetime('now') WHERE id = ?\`,
          [groupId],
        );
      } else {
        // Look up the project in cache to get its path
        const trimmed = String(projectName).trim();
        let projectPath: string | null = null;
        
        if (ruddrProjectsCache) {
          const entry = ruddrProjectsCache.find((e) => 
            e.name === trimmed || 
            e.name.toLowerCase() === trimmed.toLowerCase() ||
            normalize(e.name) === normalize(trimmed)
          );
          if (entry) {
            projectPath = entry.path;
          }
        }
        
        // Append to existing arrays (no duplicates)
        const stmt = db.prepare('SELECT ruddr_project_name, ruddr_project_paths FROM groups WHERE id = ?');
        stmt.bind([groupId]);
        let currentNames: string[] = [];
        let currentPaths: string[] = [];
        if (stmt.step()) {
          const row = stmt.getAsObject() as { 
            ruddr_project_name: string | null; 
            ruddr_project_paths: string | null 
          };
          currentNames = parseRuddrNames(row.ruddr_project_name);
          currentPaths = parseRuddrPaths(row.ruddr_project_paths);
        }
        stmt.free();
        
        const name = String(projectName).trim();
        if (name && !currentNames.includes(name)) {
          currentNames.push(name);
          if (projectPath) {
            currentPaths.push(projectPath);
          }
        }
        
        db.run(
          \`UPDATE groups SET ruddr_project_name = ?, ruddr_project_paths = ?, updated_at = datetime('now') WHERE id = ?\`,
          [JSON.stringify(currentNames), currentPaths.length ? JSON.stringify(currentPaths) : null, groupId],
        );
      }
      saveDatabase();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

`;

// Replace the handler
const before = content.slice(0, startIdx);
const after = content.slice(nextHandler);
content = before + newHandler + after;

fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('groups:set-ruddr-project handler updated to store paths');

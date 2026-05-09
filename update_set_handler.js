const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Update groups:set-ruddr-project to accept name and path
// Old signature: groups:set-ruddr-project', (_event, groupId: number, projectName: string | null)
// New signature: groups:set-ruddr-project', (_event, groupId: number, projectInfo: {name: string; path: string} | null)

const oldSig = "ipcMain.handle('groups:set-ruddr-project', (_event, groupId: number, projectName: string | null) => {";
const newSig = "ipcMain.handle('groups:set-ruddr-project', (_event, groupId: number, projectInfo: { name: string; path: string } | null) => {";

if (content.includes(oldSig)) {
  content = content.replace(oldSig, newSig);
  
  // Now update the body to use projectInfo.name and projectInfo.path
  // Old: if (projectName === null || projectName === undefined) {
  // New: if (projectInfo === null || projectInfo === undefined) {
  content = content.replace(
    'if (projectName === null || projectName === undefined) {',
    'if (projectInfo === null || projectInfo === undefined) {'
  );
  
  // Old: db.run(`UPDATE groups SET ruddr_project_name = NULL, ...`
  // New: db.run(`UPDATE groups SET ruddr_project_name = NULL, ruddr_project_paths = NULL, ...`
  content = content.replace(
    'UPDATE groups SET ruddr_project_name = NULL, updated_at = datetime(\'now\') WHERE id = ?',
    'UPDATE groups SET ruddr_project_name = NULL, ruddr_project_paths = NULL, updated_at = datetime(\'now\') WHERE id = ?'
  );
  
  // Update the select and logic for setting
  // Old: SELECT ruddr_project_name FROM groups
  // New: SELECT ruddr_project_name, ruddr_project_paths FROM groups
  content = content.replace(
    'const stmt = db.prepare(\'SELECT ruddr_project_name FROM groups WHERE id = ?\');',
    'const stmt = db.prepare(\'SELECT ruddr_project_name, ruddr_project_paths FROM groups WHERE id = ?\');'
  );
  
  // Old: const row = stmt.getAsObject() as { ruddr_project_name: string | null };
  // New: const row = stmt.getAsObject() as { ruddr_project_name: string | null; ruddr_project_paths: string | null };
  content = content.replace(
    'const row = stmt.getAsObject() as { ruddr_project_name: string | null };',
    'const row = stmt.getAsObject() as { ruddr_project_name: string | null; ruddr_project_paths: string | null };'
  );
  
  // Old: let current: string[] = []; ... current = parseRuddrNames(row.ruddr_project_name);
  // New: let currentNames: string[] = []; let currentPaths: string[] = []; ... parse both
  const oldCurrent = `let current: string[] = [];
        if (stmt.step()) {
          const row = stmt.getAsObject() as { ruddr_project_name: string | null; ruddr_project_paths: string | null };
          current = parseRuddrNames(row.ruddr_project_name);`;
  
  // Actually let me just read the file and do a more targeted replacement
  fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
  console.log('Handler signature updated, but need to update body manually');
} else {
  console.error('Could not find handler signature');
}

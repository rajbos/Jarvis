const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Find the groups:set-ruddr-workspace handler
const setWorkspacePos = content.indexOf("ipcMain.handle('groups:set-ruddr-workspace'");
if (setWorkspacePos === -1) {
  console.error('Could not find groups:set-ruddr-workspace handler');
  process.exit(1);
}

// Insert before it
const newHandler = `  ipcMain.handle('groups:get-ruddr-budget-cache', () => {
    const result: Record<string, RuddrBudgetCache> = {};
    ruddrBudgetCache.forEach((value, key) => {
      result[key] = value;
    });
    return { ok: true as const, budgets: result };
  });

`;

content = content.slice(0, setWorkspacePos) + newHandler + content.slice(setWorkspacePos);
fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('groups:get-ruddr-budget-cache handler added');

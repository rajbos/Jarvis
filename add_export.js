const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Add getBudgetFromCache export before IPC handlers comment
const ipcPos = content.indexOf('// ── IPC handlers');
if (ipcPos === -1) {
  console.error('Could not find IPC handlers comment');
  process.exit(1);
}

const newExport = `export function getBudgetFromCache(projectName: string): RuddrBudgetCache | null {
  return ruddrBudgetCache.get(projectName.trim()) ?? null;
}

`;

content = content.slice(0, ipcPos) + newExport + content.slice(ipcPos);
fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('getBudgetFromCache export added');

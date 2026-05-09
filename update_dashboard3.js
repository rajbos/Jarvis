const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/GroupsDashboardPanel.tsx', 'utf8');

// Find and replace the useEffect
const lines = content.split('\n');
const newLines = [];
let inUseEffect = false;
let useEffectStart = -1;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  // Check if this is the start of our useEffect
  if (line.includes('useEffect(() => {') && i > 10 && i < 20) {
    inUseEffect = true;
    useEffectStart = i;
    newLines.push(line);
    continue;
  }
  
  // If we're in the useEffect and find the closing
  if (inUseEffect && line.includes('}, []);')) {
    // Replace the entire useEffect
    newLines.push('    Promise.all([');
    newLines.push('      window.jarvis.groupsList(),');
    newLines.push('      window.jarvis.groupsGetRuddrBudgetCache().catch(() => ({ ok: true, budgets: {} })),');
    newLines.push('    ])');
    newLines.push('      .then(([groupsList, budgetCache]) => {');
    newLines.push('        setGroups(groupsList);');
    newLines.push('        if (budgetCache.ok) {');
    newLines.push('          setBudgetData(budgetCache.budgets);');
    newLines.push('        }');
    newLines.push('      })');
    newLines.push('      .catch((err: unknown) => console.error(\'[GroupsDashboard] Failed to load data:\', err))');
    newLines.push('      .finally(() => setLoading(false));');
    newLines.push(line);
    inUseEffect = false;
    continue;
  }
  
  // If we're in the useEffect, skip the old lines
  if (inUseEffect) {
    // Keep setLoading(true) and the closing brace
    if (line.trim() === 'setLoading(true);' || line.trim().startsWith('},')) {
      // Already handled
    }
    continue;
  }
  
  newLines.push(line);
}

const newContent = newLines.join('\n');
fs.writeFileSync('src/plugins/groups/GroupsDashboardPanel.tsx', newContent, 'utf8');
console.log('GroupsDashboardPanel.tsx updated successfully');

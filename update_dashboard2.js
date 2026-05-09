const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/GroupsDashboardPanel.tsx', 'utf8');

// Replace the useEffect to also load budget cache
// Match the pattern more flexibly
const oldPattern = /useEffect\(\(\) => \{\s+setLoading\(true\);\s+window\.jarvis\.groupsList\(\)\s+\.then\(\(list\) => setGroups\(list\)\)\s+\.catch\(\(err: unknown\) => console\.error\(('[^']+', err\)\)\s+\.finally\(\(\) => setLoading\(false\)\);\s+\}, \[\]\);/;

if (oldPattern.test(content)) {
  const newEffect = `  useEffect(() => {
    setLoading(true);
    Promise.all([
      window.jarvis.groupsList(),
      window.jarvis.groupsGetRuddrBudgetCache().catch(() => ({ ok: true, budgets: {} })),
    ])
      .then(([groupsList, budgetCache]) => {
        setGroups(groupsList);
        if (budgetCache.ok) {
          setBudgetData(budgetCache.budgets);
        }
      })
      .catch((err: unknown) => console.error('[GroupsDashboard] Failed to load data:', err))
      .finally(() => setLoading(false));
  }, []);`;
  
  content = content.replace(oldPattern, newEffect);
  fs.writeFileSync('src/plugins/groups/GroupsDashboardPanel.tsx', content, 'utf8');
  console.log('GroupsDashboardPanel.tsx updated successfully');
} else {
  console.error('Could not find the useEffect pattern');
  // Let's see what we have
  const lines = content.split('\n');
  for (let i = 14; i < 22; i++) {
    console.log(`Line ${i+1}: ${JSON.stringify(lines[i])}`);
  }
  process.exit(1);
}

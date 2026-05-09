const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/GroupsDashboardPanel.tsx', 'utf8');

// Replace the useEffect to also load budget cache
const oldEffect = `  useEffect(() => {
    setLoading(true);
    window.jarvis.groupsList()
      .then((list) => setGroups(list))
      .catch((err: unknown) => console.error('[GroupsDashboard] Failed to load groups:', err))
      .finally(() => setLoading(false));
  }, []);`;

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

if (content.includes(oldEffect)) {
  content = content.replace(oldEffect, newEffect);
  fs.writeFileSync('src/plugins/groups/GroupsDashboardPanel.tsx', content, 'utf8');
  console.log('GroupsDashboardPanel.tsx updated successfully');
} else {
  console.error('Could not find the useEffect to replace');
  process.exit(1);
}

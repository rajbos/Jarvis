const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Find and replace fetchAllLinkedBudgets to use paths
const oldFetchAll = `async function fetchAllLinkedBudgets(db: SqlJsDatabase): Promise<void> {
  // Get all groups with their linked Ruddr projects
  const stmt = db.prepare(\`
    SELECT id, name, ruddr_project_name 
    FROM groups 
    WHERE ruddr_project_name IS NOT NULL
  \`);
  
  const linkedProjects: Set<string> = new Set();
  
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { 
        id: number; 
        name: string; 
        ruddr_project_name: string | null;
      };
      const projectNames = parseRuddrNames(row.ruddr_project_name);
      for (const projName of projectNames) {
        linkedProjects.add(projName);
      }
    }
  } finally {
    stmt.free();
  }
  
  if (linkedProjects.size === 0) {
    console.log('[Groups] No linked Ruddr projects found - skipping budget pre-fetch');
    return;
  }
  
  console.log(\`[Groups] Fetching budget info for \${linkedProjects.size} linked Ruddr project(s)\`);
  
  // Fetch budgets sequentially to avoid overwhelming the browser
  const projectArray = Array.from(linkedProjects);
  for (const projectName of projectArray) {
    try {
      await fetchAndCacheBudget(db, projectName);
      // Small delay between requests to be gentle
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn(\`[Groups] Error fetching budget for \${projectName}:\`, err);
    }
  }
  
  console.log(\`[Groups] Budget pre-fetch complete for \${projectArray.length} project(s)\`);
}`;

const newFetchAll = `async function fetchAllLinkedBudgets(db: SqlJsDatabase): Promise<void> {
  // Get all groups with their linked Ruddr projects and paths
  const stmt = db.prepare(\`
    SELECT id, name, ruddr_project_name, ruddr_project_paths 
    FROM groups 
    WHERE ruddr_project_name IS NOT NULL
  \`);
  
  // Collect unique (name, path) pairs
  const linkedEntries: Array<{ name: string; path: string }> = [];
  
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { 
        id: number; 
        name: string; 
        ruddr_project_name: string | null;
        ruddr_project_paths: string | null;
      };
      const projectNames = parseRuddrNames(row.ruddr_project_name);
      const projectPaths = parseRuddrPaths(row.ruddr_project_paths);
      
      for (let i = 0; i < projectNames.length; i++) {
        linkedEntries.push({
          name: projectNames[i],
          path: projectPaths[i] ?? ''
        });
      }
    }
  } finally {
    stmt.free();
  }
  
  if (linkedEntries.length === 0) {
    console.log('[Groups] No linked Ruddr projects found - skipping budget pre-fetch');
    return;
  }
  
  console.log(\`[Groups] Fetching budget info for \${linkedEntries.length} linked Ruddr project(s)\`);
  
  // Fetch budgets sequentially to avoid overwhelming the browser
  for (const entry of linkedEntries) {
    try {
      await fetchAndCacheBudgetByPath(db, entry.name, entry.path);
      // Small delay between requests to be gentle
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn(\`[Groups] Error fetching budget for \${entry.name}:\`, err);
    }
  }
  
  console.log(\`[Groups] Budget pre-fetch complete for \${linkedEntries.length} project(s)\`);
}

/**
 * Fetches budget info for a project using its stored path (bypasses cache lookup by name).
 */
async function fetchAndCacheBudgetByPath(db: SqlJsDatabase, projectName: string, projectPath: string): Promise<void> {
  const trimmed = projectName.trim();
  const path = projectPath.trim();
  
  if (!path) {
    // Fall back to name-based lookup
    return fetchAndCacheBudget(db, projectName);
  }
  
  const status = getBridgeStatus();
  if (!status.running || status.connectedClients === 0) {
    console.log(\`[Groups] Skipping budget fetch for \${trimmed}: no browser extension\`);
    return;
  }

  const workspace = getRuddrWorkspace(db);
  if (!workspace) {
    console.log(\`[Groups] Skipping budget fetch for \${trimmed}: workspace not configured\`);
    return;
  }

  const overviewUrl = \`https://www.ruddr.io\${path}/overview\`;
  
  try {
    const navResp = await sendCommand({ type: 'navigate', payload: { url: overviewUrl } });
    if (!navResp.ok) {
      console.warn(\`[Groups] Budget fetch navigation failed for \${trimmed}: \${navResp.error ?? 'unknown'}\`);
      return;
    }

    const navData = navResp.data as { url?: string; tabId?: number } | null;
    if ((navData?.url ?? '').includes('/login')) {
      console.warn(\`[Groups] Budget fetch requires login for \${trimmed}\`);
      return;
    }

    const statsResp = await sendCommand({
      type: 'scrape-stats',
      tabId: navData?.tabId,
      payload: { waitMs: 3000 },
    });
    if (!statsResp.ok) {
      console.warn(\`[Groups] Budget scrape failed for \${trimmed}: \${statsResp.error ?? 'unknown'}\`);
      return;
    }

    const raw = statsResp.data as Record<string, string> | null;
    const budgetData: RuddrBudgetCache = {
      actualBillableHours: raw?.['Actual Billable Hours'] ?? null,
      actualNonBillableHours: raw?.['Actual Non-Billable Hours'] ?? null,
      actualTotalHours: raw?.['Actual Total Hours'] ?? null,
      budget: raw?.['Budget'] ?? null,
      budgetLeft: raw?.['Budget Left'] ?? null,
      projectUrl: overviewUrl,
    };
    
    ruddrBudgetCache.set(trimmed, budgetData);
    console.log(\`[Groups] Budget cached for project: \${trimmed}\`);
  } catch (err) {
    console.warn(\`[Groups] Budget fetch error for \${trimmed}:\`, err);
  }
}`;

// Find and replace
const startIdx = content.indexOf('async function fetchAllLinkedBudgets');
if (startIdx === -1) {
  console.error('Could not find fetchAllLinkedBudgets');
  process.exit(1);
}

// Find the end of the function (the closing brace before the next function)
const nextFunc = content.indexOf('export async function prewarmRuddrCache', startIdx);
if (nextFunc === -1) {
  console.error('Could not find next function');
  process.exit(1);
}

const before = content.slice(0, startIdx);
const after = content.slice(nextFunc);
content = before + newFetchAll + '\n\n' + after;

fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('fetchAllLinkedBudgets and fetchAndCacheBudgetByPath updated');

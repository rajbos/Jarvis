const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Add the budget cache interface and map before the prewarmRuddrCache function
const budgetCacheInterface = `
// ── Budget cache (in-memory, per app session) ────────────────────────────────
// Maps project name to its budget info for quick lookup in the dashboard
interface RuddrBudgetCache {
  actualBillableHours: string | null;
  actualNonBillableHours: string | null;
  actualTotalHours: string | null;
  budget: string | null;
  budgetLeft: string | null;
  projectUrl: string | null;
}
let ruddrBudgetCache: Map<string, RuddrBudgetCache> = new Map();

`;

// Insert the budget cache interface right before "// ── Cache pre-warming"
const prewarmPos = content.indexOf('// ── Cache pre-warming');
if (prewarmPos === -1) {
  console.error('Could not find prewarm position');
  process.exit(1);
}

content = content.slice(0, prewarmPos) + budgetCacheInterface + content.slice(prewarmPos);

// Now add the helper functions and update prewarmRuddrCache
const helperFunctions = `
/**
 * Fetches budget info for a single project and caches it.
 */
async function fetchAndCacheBudget(db: SqlJsDatabase, projectName: string): Promise<void> {
  const trimmed = projectName.trim();
  
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

  // Ensure project cache is populated first
  try {
    const cacheErr = await ensureRuddrCache(db);
    if (cacheErr) {
      console.log(\`[Groups] Skipping budget fetch for \${trimmed}: \${cacheErr}\`);
      return;
    }
  } catch (err) {
    console.warn(\`[Groups] Skipping budget fetch for \${trimmed}: cache error\`, err);
    return;
  }

  // Find the project in cache to get its path
  const entry = ruddrProjectsCache?.find((e) => e.name === trimmed)
    ?? ruddrProjectsCache?.find((e) => e.name.toLowerCase() === trimmed.toLowerCase())
    ?? ruddrProjectsCache?.find((e) => normalize(e.name) === normalize(trimmed));
  
  if (!entry?.path) {
    console.warn(\`[Groups] No cache entry found for project "\${trimmed}" when fetching budget\`);
    return;
  }

  const overviewUrl = \`https://www.ruddr.io\${entry.path}/overview\`;
  
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
}

/**
 * Fetches budget info for all linked Ruddr projects across all groups.
 */
async function fetchAllLinkedBudgets(db: SqlJsDatabase): Promise<void> {
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
}

`;

// Insert helper functions before prewarmRuddrCache
const helperPos = content.indexOf('export async function prewarmRuddrCache');
if (helperPos === -1) {
  console.error('Could not find prewarmRuddrCache function');
  process.exit(1);
}

content = content.slice(0, helperPos) + helperFunctions + content.slice(helperPos);

// Now update the prewarmRuddrCache function
const oldPrewarm = `export async function prewarmRuddrCache(db: SqlJsDatabase): Promise<void> {
  // Delay initial attempt to let critical startup settle (5 seconds)
  const STARTUP_DELAY_MS = 5000;
  // Retry once after 30 seconds if first attempt fails
  const RETRY_DELAY_MS = 30000;

  const attemptCache = async (): Promise<void> => {
    try {
      const err = await ensureRuddrCache(db);
      if (err) {
        console.log(\`[Groups] Startup cache pre-warm failed: \${err}\`);
        // Schedule retry
        setTimeout(() => {
          attemptCache().catch(() => { /* silent failure */ });
        }, RETRY_DELAY_MS);
      } else {
        console.log('[Groups] Ruddr projects cache pre-warmed on startup');
      }
    } catch (err) {
      console.warn('[Groups] Startup cache pre-warm error:', err);
      setTimeout(() => {
        attemptCache().catch(() => { /* silent failure */ });
      }, RETRY_DELAY_MS);
    }
  };

  // Start the pre-warming sequence
  setTimeout(() => {
    attemptCache().catch(() => { /* silent failure */ });
  }, STARTUP_DELAY_MS);
}`;

const newPrewarm = `export async function prewarmRuddrCache(db: SqlJsDatabase): Promise<void> {
  // Delay initial attempt to let critical startup settle (5 seconds)
  const STARTUP_DELAY_MS = 5000;
  // Delay before fetching budgets after cache is ready (2 seconds)
  const BUDGET_DELAY_MS = 2000;
  // Retry once after 30 seconds if first attempt fails
  const RETRY_DELAY_MS = 30000;

  const attemptCache = async (): Promise<void> => {
    try {
      const err = await ensureRuddrCache(db);
      if (err) {
        console.log(\`[Groups] Startup cache pre-warm failed: \${err}\`);
        // Schedule retry
        setTimeout(() => {
          attemptCache().catch(() => { /* silent failure */ });
        }, RETRY_DELAY_MS);
      } else {
        console.log('[Groups] Ruddr projects cache pre-warmed on startup');
        
        // After cache is ready, fetch budget info for all linked projects
        setTimeout(() => {
          fetchAllLinkedBudgets(db).catch((e) => {
            console.warn('[Groups] Budget pre-fetch failed:', e);
          });
        }, BUDGET_DELAY_MS);
      }
    } catch (err) {
      console.warn('[Groups] Startup cache pre-warm error:', err);
      setTimeout(() => {
        attemptCache().catch(() => { /* silent failure */ });
      }, RETRY_DELAY_MS);
    }
  };

  // Start the pre-warming sequence
  setTimeout(() => {
    attemptCache().catch(() => { /* silent failure */ });
  }, STARTUP_DELAY_MS);
}

export function getBudgetFromCache(projectName: string): RuddrBudgetCache | null {
  return ruddrBudgetCache.get(projectName.trim()) ?? null;
}`;

content = content.replace(oldPrewarm, newPrewarm);

// Write the file
fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('handler.ts updated successfully');

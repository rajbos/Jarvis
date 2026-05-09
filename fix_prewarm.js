const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Find the prewarmRuddrCache function
const funcStart = 'export async function prewarmRuddrCache(db: SqlJsDatabase): Promise<void> {';
const startIdx = content.indexOf(funcStart);

if (startIdx === -1) {
  console.error('Could not find prewarmRuddrCache function');
  process.exit(1);
}

// Find the end of the function (the closing brace before "// ── IPC handlers")
const ipcHandlersIdx = content.indexOf('// ── IPC handlers', startIdx);
if (ipcHandlersIdx === -1) {
  console.error('Could not find IPC handlers comment');
  process.exit(1);
}

// Build the new function
const newFunc = `export async function prewarmRuddrCache(db: SqlJsDatabase): Promise<void> {
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
}`;

// Replace the function
const before = content.slice(0, startIdx);
const after = content.slice(ipcHandlersIdx);
content = before + newFunc + '\n\n' + after;

fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('prewarmRuddrCache function updated with budget fetch');

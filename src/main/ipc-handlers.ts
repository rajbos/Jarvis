// ── IPC handler registry ──────────────────────────────────────────────────────
// This file is intentionally thin. All handler logic lives in the plugin
// folders under src/plugins/. To add a new feature:
//   1. Create src/plugins/<feature>/handler.ts with a registerHandlers() export
//   2. Import and call it below — that's the only file you touch
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';

import { registerHandlers as registerConfigHandlers } from '../plugins/config/handler';
import { registerHandlers as registerOllamaHandlers } from '../plugins/ollama/handler';
import { registerHandlers as registerChatHandlers } from '../plugins/chat/handler';
import { registerHandlers as registerGitHubAuthHandlers } from '../plugins/github-auth/handler';
import { registerHandlers as registerDiscoveryHandlers } from '../plugins/discovery/handler';
import { registerHandlers as registerOrgsHandlers } from '../plugins/orgs/handler';
import { registerHandlers as registerReposHandlers } from '../plugins/repos/handler';
import { registerHandlers as registerNotificationsHandlers } from '../plugins/notifications/handler';
import { registerHandlers as registerLocalReposHandlers } from '../plugins/local-repos/handler';
import { registerHandlers as registerSecretsHandlers } from '../plugins/secrets/handler';

// Re-export startDiscoveryIfAuthed so src/main/index.ts can call it on startup
export { startDiscoveryIfAuthed } from '../plugins/discovery/handler';
// Re-export scheduleLocalDiscovery so src/main/index.ts can call it on startup
export { scheduleLocalDiscovery } from '../plugins/local-repos/handler';

export function registerIpcHandlers(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): void {
  registerConfigHandlers(db, getWindow);
  registerOllamaHandlers(db, getWindow);
  registerChatHandlers(db, getWindow);
  registerGitHubAuthHandlers(db, getWindow);
  registerDiscoveryHandlers(db, getWindow);
  registerOrgsHandlers(db, getWindow);
  registerReposHandlers(db, getWindow);
  registerNotificationsHandlers(db, getWindow);
  registerLocalReposHandlers(db, getWindow);
  registerSecretsHandlers(db, getWindow);
}

// ── Discovery for the non-primary accounts ───────────────────────────────────
// The primary account is discovered by startDiscoveryIfAuthed. Every other
// account (a second github.com login, a GHE.com PAT or GitHub CLI login) is
// discovered here afterwards, so the repos only it can see end up in the same
// index — each recorded as visible to that account. Starred repos stay the
// primary account's.
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { runDiscovery, runLightweightRefresh } from '../../services/github-discovery';
import { listAccounts, listGhCliAccounts, resolveAccountToken } from '../../services/github-accounts';
import { runWithHost } from '../../services/github-host';
import { getConfigValue, saveDatabase, setConfigValue } from '../../storage/database';
import { logger } from '../../services/logger';
import { lastDiscoveryProgress } from './state';

let running = false;

/** `config` key remembering when an account was last indexed. */
export function accountIndexedKey(accountId: string): string {
  return `github_account_indexed:${accountId.toLowerCase()}`;
}

export async function discoverAdditionalAccounts(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  force: boolean,
): Promise<void> {
  if (running) return;
  running = true;
  try {
    const accounts = listAccounts(db, await listGhCliAccounts()).filter((a) => !a.isPrimary);
    for (const account of accounts) {
      const token = await resolveAccountToken(db, account.id);
      if (!token) {
        logger.debug(`[Discovery] Skipping @${account.id}: no usable credential`);
        continue;
      }
      const firstRun = force || !getConfigValue(db, accountIndexedKey(account.id));
      getWindow()?.webContents.send('app:background-status', `Discovering repos for @${account.id}…`);
      logger.info(`[Discovery] ${firstRun ? 'Full' : 'Lightweight'} discovery for @${account.id}`);
      await runWithHost(
        account.host,
        () => firstRun
          ? runDiscovery(db, token.token, undefined, null, null, { skipStarred: true })
          : runLightweightRefresh(db, token.token, undefined, null, null, { skipStarred: true }),
        account.id,
      );
      setConfigValue(db, accountIndexedKey(account.id), new Date().toISOString());
      saveDatabase();
    }
    if (accounts.length > 0) getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
  } catch (err) {
    logger.error('[Discovery] Additional account discovery failed:', err);
  } finally {
    running = false;
  }
}

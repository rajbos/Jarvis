// ── Ruddr project link IPC handlers ──────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { saveDatabase } from '../../storage/database';
import { listRuddrLinks, addRuddrLink, updateRuddrLink, removeRuddrLink } from '../../services/ruddr';
import { sendCommand } from '../browser-companion/server';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {

  ipcMain.handle('ruddr:list-links', (_event, groupId?: number) => {
    return listRuddrLinks(db, typeof groupId === 'number' ? groupId : undefined);
  });

  ipcMain.handle(
    'ruddr:add-link',
    (_event, groupId: number, workspace: string, projectId: string, projectName: string, projectUrl: string, extractSelector: string) => {
      if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
      if (!workspace?.trim()) return { ok: false, error: 'workspace is required' };
      if (!projectId?.trim()) return { ok: false, error: 'projectId is required' };
      if (!projectName?.trim()) return { ok: false, error: 'projectName is required' };
      if (!projectUrl?.trim()) return { ok: false, error: 'projectUrl is required' };
      try {
        const id = addRuddrLink(db, groupId, workspace.trim(), projectId.trim(), projectName.trim(), projectUrl.trim(), (extractSelector ?? '').trim());
        saveDatabase();
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'ruddr:update-link',
    (_event, id: number, projectName: string, projectUrl: string, extractSelector: string) => {
      if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
      try {
        updateRuddrLink(db, id, projectName.trim(), projectUrl.trim(), (extractSelector ?? '').trim());
        saveDatabase();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('ruddr:remove-link', (_event, id: number) => {
    if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
    try {
      removeRuddrLink(db, id);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Navigate to the project URL and extract state data via the browser extension
  ipcMain.handle('ruddr:fetch-project-state', async (_event, linkId: number) => {
    if (typeof linkId !== 'number') return { ok: false, error: 'Invalid linkId' };
    const links = listRuddrLinks(db);
    const link = links.find((l) => l.id === linkId);
    if (!link) return { ok: false, error: 'Link not found' };
    if (!link.ruddrProjectUrl) return { ok: false, error: 'No project URL configured' };

    try {
      // Navigate to the project page
      await sendCommand({ type: 'navigate', payload: { url: link.ruddrProjectUrl } });

      // Extract data — use configured selector or fall back to full page content
      if (link.extractSelector) {
        const result = await sendCommand({
          type: 'extract',
          payload: { selector: link.extractSelector },
        });
        return { ok: true, data: parseRuddrBudgetData(result.data) };
      } else {
        const result = await sendCommand({
          type: 'get-page-content',
          payload: {},
        });
        return { ok: true, data: result.data };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ── Ruddr budget data parser ──────────────────────────────────────────────────
// The extract command returns the container element's innerText as alternating
// value/label lines (e.g. "77\nActual Billable Hours\n70\nBudget\n-7\nBudget Left").
// This parser groups them into named metrics.

interface RuddrMetric {
  label: string;
  value: number;
}

interface RuddrBudgetData {
  metrics: RuddrMetric[];
  // Convenience fields parsed from common metric names
  actualBillableHours?: number;
  billableBudget?: number;
  billableBudgetLeft?: number;
  actualNonBillableHours?: number;
  actualTotalHours?: number;
  totalBudget?: number;
  totalBudgetLeft?: number;
}

function parseRuddrBudgetData(rawData: unknown): RuddrBudgetData {
  // rawData is an array of extracted elements; we want the first (container) element's text
  const items = rawData as Array<{ text?: string }>;
  const text = items?.[0]?.text ?? '';

  // Split on newlines, strip whitespace, remove empty lines
  const lines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);

  const metrics: RuddrMetric[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const numStr = lines[i];
    const label = lines[i + 1];
    // The value line is always the number (possibly negative)
    const value = parseFloat(numStr.replace(/,/g, ''));
    if (!isNaN(value)) {
      metrics.push({ label, value });
    } else {
      // If the pairing is off, try the other order
      const altValue = parseFloat(label.replace(/,/g, ''));
      if (!isNaN(altValue)) {
        metrics.push({ label: numStr, value: altValue });
      }
    }
  }

  // Build convenience lookup by normalised label
  const byLabel: Record<string, number> = {};
  for (const m of metrics) {
    byLabel[m.label.toLowerCase()] = m.value;
  }

  return {
    metrics,
    actualBillableHours:    byLabel['actual billable hours'],
    billableBudget:         metrics.find((m, i) => m.label === 'Budget' && i < 4)?.value,
    billableBudgetLeft:     metrics.find((m, i) => m.label === 'Budget Left' && i < 6)?.value,
    actualNonBillableHours: byLabel['actual non-billable hours'],
    actualTotalHours:       byLabel['actual total hours'],
    totalBudget:            metrics.filter((m) => m.label === 'Budget').at(-1)?.value,
    totalBudgetLeft:        metrics.filter((m) => m.label === 'Budget Left').at(-1)?.value,
  };
}

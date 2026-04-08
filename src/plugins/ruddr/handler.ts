// ── Ruddr project link IPC handlers ──────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { saveDatabase } from '../../storage/database';
import { listRuddrLinks, addRuddrLink, updateRuddrLink, removeRuddrLink } from '../../services/ruddr';
import { sendCommand } from '../browser-companion/server';

export const DEFAULT_RUDDR_BUDGET_SELECTOR = '#workspace-main section:nth-child(2)';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {

  // ── Workspace config ────────────────────────────────────────────────────────

  ipcMain.handle('ruddr:get-workspace', () => {
    const result = db.exec("SELECT value FROM config WHERE key = 'ruddr_workspace'");
    return (result[0]?.values[0]?.[0] as string) ?? '';
  });

  ipcMain.handle('ruddr:set-workspace', (_event, workspace: string) => {
    if (!workspace?.trim()) return { ok: false, error: 'workspace is required' };
    db.run(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('ruddr_workspace', ?)",
      [workspace.trim()],
    );
    saveDatabase();
    return { ok: true };
  });

  // ── Project discovery ───────────────────────────────────────────────────────

  ipcMain.handle('ruddr:scan-projects', async (_event, workspace: string) => {
    if (!workspace?.trim()) return { ok: false, error: 'workspace is required' };
    try {
      await sendCommand({
        type: 'navigate',
        payload: { url: `https://www.ruddr.io/app/${workspace.trim()}/my-projects` },
      });
      const result = await sendCommand({
        type: 'extract',
        payload: { selector: 'a[href*="/portfolio/projects/"]' },
      });
      const seen = new Set<string>();
      const projects = (result.data as Array<{ text?: string; href?: string }> ?? [])
        .filter((p) => {
          if (!p.href || !p.text?.trim()) return false;
          if (seen.has(p.href)) return false;
          seen.add(p.href);
          return true;
        })
        .map((p) => ({
          name: p.text!.trim().replace(/\s+/g, ' '),
          href: p.href!,
          url: p.href!.startsWith('http') ? p.href! : `https://www.ruddr.io${p.href!}`,
        }));
      return { ok: true, projects };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Navigate to a portfolio URL and return the final URL after page load
  ipcMain.handle('ruddr:resolve-project-url', async (_event, portfolioUrl: string) => {
    if (!portfolioUrl?.trim()) return { ok: false, error: 'url is required' };
    try {
      const navResult = await sendCommand({ type: 'navigate', payload: { url: portfolioUrl } });
      const finalUrl = (navResult.data as { url?: string })?.url ?? portfolioUrl;
      return { ok: true, url: finalUrl };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

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
        // Extract numbers (.sc-kDDYVy) and labels (.sc-gleVhi) separately so
        // that inline <small> elements don't merge with the next number in innerText
        const [valuesResult, labelsResult] = await Promise.all([
          sendCommand({ type: 'extract', payload: { selector: `${link.extractSelector} .sc-kDDYVy` } }),
          sendCommand({ type: 'extract', payload: { selector: `${link.extractSelector} .sc-gleVhi` } }),
        ]);
        return { ok: true, data: parseRuddrBudgetData(valuesResult.data, labelsResult.data) };
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

function parseRuddrBudgetData(valuesData: unknown, labelsData: unknown): RuddrBudgetData {
  const values = (valuesData as Array<{ text?: string }> | null) ?? [];
  const labels = (labelsData as Array<{ text?: string }> | null) ?? [];

  const metrics: RuddrMetric[] = values.map((v, i) => ({
    label: labels[i]?.text?.trim() ?? `Metric ${i + 1}`,
    value: parseFloat((v.text ?? '').replace(/,/g, '')),
  })).filter((m) => !isNaN(m.value));

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

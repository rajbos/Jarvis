/** @jsxImportSource preact */
import { useState, useEffect } from 'preact/hooks';
import type { RuddrHoursSummary, RuddrHoursWeek } from '../types';

// ── RuddrHoursSection ─────────────────────────────────────────────────────────
// The cached Ruddr hours on the Groups dashboard: crawl status, one week at a
// time (project × day) with a reload button, and the projects you logged
// hours on that no group is linked to yet.

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function currentMonday(): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, -((dow + 6) % 7));
}

/** Minutes as Ruddr shows them: "8:00", "0:45". */
export function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function formatWeek(weekStart: string): string {
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(weekStart)} – ${fmt(addDays(weekStart, 6))}, ${addDays(weekStart, 6).slice(0, 4)}`;
}

function formatFetched(sqliteUtc: string | null): string {
  if (!sqliteUtc) return 'never fetched';
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return isNaN(d.getTime()) ? 'unknown' : `fetched ${d.toLocaleString()}`;
}

export function RuddrHoursSection(props: {
  summary: RuddrHoursSummary | null;
  groups: Array<{ id: number; name: string; ruddrProjectNames: string[] }>;
  onChanged: () => void;
}) {
  const { summary, groups, onChanged } = props;
  const [weekStart, setWeekStart] = useState(currentMonday);
  const [week, setWeek] = useState<RuddrHoursWeek | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadWeek = async (ws: string) => {
    const res = await window.jarvis.ruddrHoursWeek(ws);
    if (res.ok) setWeek(res.week);
  };

  useEffect(() => { setReloadError(null); void loadWeek(weekStart); }, [weekStart]);
  // A background run may have just fetched the week on screen.
  useEffect(() => { void loadWeek(weekStart); }, [summary?.status.lastRunAt]);

  const handleReload = async () => {
    setReloading(true);
    setReloadError(null);
    try {
      const res = await window.jarvis.ruddrHoursRefreshWeek(weekStart);
      if (res.ok) {
        setWeek(res.week);
        const reason = (res.result as { reason?: string }).reason;
        if (reason) setReloadError(reason);
      } else {
        setReloadError(res.error);
      }
      onChanged();
    } finally {
      setReloading(false);
    }
  };

  const handleCreateGroup = async (projectName: string, groupName: string) => {
    setCreatingFor(projectName);
    setCreateError(null);
    try {
      // Link to an existing group of the same name instead of failing on the duplicate.
      const existing = groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase());
      if (existing) {
        await window.jarvis.groupsSetRuddrProject(existing.id, projectName);
      } else {
        const created = await window.jarvis.groupsCreate(groupName);
        if (!created.ok || created.id == null) {
          setCreateError(created.error ?? 'Failed to create group');
          return;
        }
        await window.jarvis.groupsSetRuddrProject(created.id, projectName);
      }
      onChanged();
    } finally {
      setCreatingFor(null);
    }
  };

  const status = summary?.status;
  const days = DAY_LABELS.map((_, i) => addDays(weekStart, i));
  const projects = new Map<string, { name: string; client: string | null; byDate: Map<string, number>; total: number }>();
  for (const r of week?.rows ?? []) {
    const p = projects.get(r.projectPath) ?? { name: r.projectName, client: r.clientName, byDate: new Map(), total: 0 };
    p.byDate.set(r.date, (p.byDate.get(r.date) ?? 0) + r.minutes);
    p.total += r.minutes;
    projects.set(r.projectPath, p);
  }
  const dayTotals = days.map((d) => [...projects.values()].reduce((s, p) => s + (p.byDate.get(d) ?? 0), 0));
  const isFuture = weekStart > currentMonday();

  return (
    <section class="ruddr-hours">
      <div class="ruddr-hours-head">
        <h3>⏱ My Ruddr hours</h3>
        {status && (
          <span class="ruddr-hours-status" title={status.lastError ?? undefined}>
            {status.running ? '🔄 fetching… · ' : ''}
            {status.weeksCached} week{status.weeksCached !== 1 ? 's' : ''} cached
            {status.oldestWeek ? ` since ${status.oldestWeek}` : ''}
            {status.backfillDone ? ' · history complete' : ' · still going back in time'}
            {status.erroredWeeks > 0 ? ` · ${status.erroredWeeks} failed` : ''}
          </span>
        )}
      </div>

      {status?.loginRequired && (
        <div class="ruddr-hours-warn">
          🔒 Ruddr wants you to log in — discovery is paused.{' '}
          <button class="ruddr-hours-link" onClick={() => void window.jarvis.shellOpenUrl('https://www.ruddr.io/app')}>Open Ruddr ↗</button>
        </div>
      )}
      {status?.extensionOutdated && (
        <div class="ruddr-hours-warn">
          🧩 Reload the Jarvis browser extension (edge://extensions or chrome://extensions) — it does not know how to read week pages yet.
        </div>
      )}

      <div class="ruddr-hours-weeknav">
        <button class="ruddr-hours-navbtn" onClick={() => setWeekStart(addDays(weekStart, -7))} title="Previous week" aria-label="Previous week">◀</button>
        <span class="ruddr-hours-weeklabel">{formatWeek(weekStart)}</span>
        <button class="ruddr-hours-navbtn" onClick={() => setWeekStart(addDays(weekStart, 7))} disabled={isFuture} title="Next week" aria-label="Next week">▶</button>
        <span class="ruddr-hours-fetched">
          {week?.status === 'error' ? `⚠️ last fetch failed (${week.error}) · ` : ''}
          {formatFetched(week?.fetchedAt ?? null)}
        </span>
        <button class="ruddr-hours-reload" onClick={() => void handleReload()} disabled={reloading || isFuture} title="Fetch this week from Ruddr again">
          {reloading ? '⏳ Reloading…' : '↻ Reload week'}
        </button>
      </div>
      {reloadError && <div class="ruddr-hours-warn">{reloadError}</div>}

      {projects.size === 0 ? (
        <div class="ruddr-hours-empty">{week?.fetchedAt ? 'No hours logged this week.' : 'This week has not been fetched yet.'}</div>
      ) : (
        <div class="ruddr-hours-table-wrap">
          <table class="ruddr-hours-table">
            <thead>
              <tr>
                <th class="ruddr-hours-proj">Project</th>
                {DAY_LABELS.map((d) => <th key={d}>{d}</th>)}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {[...projects.entries()].map(([path, p]) => (
                <tr key={path}>
                  <td class="ruddr-hours-proj" title={p.client ? `${p.client} / ${p.name}` : p.name}>
                    {p.client && <span class="ruddr-hours-client">{p.client} / </span>}{p.name}
                  </td>
                  {days.map((d) => <td key={d}>{p.byDate.get(d) ? formatMinutes(p.byDate.get(d)!) : ''}</td>)}
                  <td class="ruddr-hours-total">{formatMinutes(p.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td class="ruddr-hours-proj">Total</td>
                {dayTotals.map((m, i) => <td key={i}>{formatMinutes(m)}</td>)}
                <td class="ruddr-hours-total">{formatMinutes(dayTotals.reduce((a, b) => a + b, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {summary && summary.unlinked.length > 0 && (
        <div class="ruddr-hours-unlinked">
          <div class="ruddr-hours-subhead">Projects with your hours that are not in a group</div>
          {createError && <div class="ruddr-hours-warn">{createError}</div>}
          {summary.unlinked.map((p) => (
            <div class="ruddr-hours-unlinked-row" key={p.projectPath}>
              <span class="ruddr-hours-unlinked-name" title={p.projectPath}>
                {p.clientName && <span class="ruddr-hours-client">{p.clientName} / </span>}{p.projectName}
              </span>
              <span class="ruddr-hours-unlinked-meta">{formatMinutes(p.totalMinutes)} · last {p.lastDate}</span>
              <button
                class="ruddr-hours-link"
                disabled={creatingFor !== null}
                onClick={() => void handleCreateGroup(p.projectName, p.clientName ?? p.projectName)}
                title={groups.some((g) => g.name.toLowerCase() === (p.clientName ?? p.projectName).toLowerCase())
                  ? `Link to the existing group "${p.clientName ?? p.projectName}"`
                  : `Create group "${p.clientName ?? p.projectName}" linked to this project`}
              >
                {creatingFor === p.projectName ? '…'
                  : groups.some((g) => g.name.toLowerCase() === (p.clientName ?? p.projectName).toLowerCase()) ? '+ Link' : '+ Group'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

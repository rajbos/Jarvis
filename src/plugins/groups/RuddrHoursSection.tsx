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
  const [showHidden, setShowHidden] = useState(false);

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

  const handleSetHidden = async (projectPath: string, hidden: boolean) => {
    await window.jarvis.ruddrHoursSetProjectHidden(projectPath, hidden);
    onChanged();
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
  // One row per project. A project logged on more than one work type (Ruddr's
  // tasks, e.g. Internal Work → Pre-sales and Tech Officer) this week gets a
  // sub-row per work type under its summed row.
  type Hours = { byDate: Map<string, number>; total: number };
  const addHours = (h: Hours, date: string, minutes: number) => {
    h.byDate.set(date, (h.byDate.get(date) ?? 0) + minutes);
    h.total += minutes;
  };
  const projects = new Map<string, Hours & { name: string; client: string | null; workTypes: Map<string, Hours & { name: string | null }> }>();
  for (const r of week?.rows ?? []) {
    const p = projects.get(r.projectPath)
      ?? { name: r.projectName, client: r.clientName, workTypes: new Map(), byDate: new Map(), total: 0 };
    addHours(p, r.date, r.minutes);
    const w = p.workTypes.get(r.taskPath) ?? { name: r.taskName, byDate: new Map(), total: 0 };
    addHours(w, r.date, r.minutes);
    p.workTypes.set(r.taskPath, w);
    projects.set(r.projectPath, p);
  }
  // Alphabetical by "client / project", as the rows read; work types by name.
  const rowLabel = (p: { name: string; client: string | null }) => (p.client ? `${p.client} / ${p.name}` : p.name);
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const sortedProjects = [...projects.entries()].sort(([, a], [, b]) => byName(rowLabel(a), rowLabel(b)));
  const sortedWorkTypes = (p: { workTypes: Map<string, Hours & { name: string | null }> }) =>
    [...p.workTypes.entries()].sort(([, a], [, b]) => byName(a.name ?? '', b.name ?? ''));
  const dayTotals = days.map((d) => [...projects.values()].reduce((s, p) => s + (p.byDate.get(d) ?? 0), 0));

  // The Ruddr entries behind each cell, for note tooltips (keyed per work type
  // and per project, since a project row sums its work types).
  const entriesByCell = new Map<string, Array<{ minutes: number; notes: string | null }>>();
  for (const e of week?.entries ?? []) {
    for (const key of [`${e.projectPath}|${e.taskPath}|${e.date}`, `${e.projectPath}|*|${e.date}`]) {
      const list = entriesByCell.get(key) ?? [];
      list.push({ minutes: e.minutes, notes: e.notes });
      entriesByCell.set(key, list);
    }
  }
  const cell = (key: string, date: string, minutes: number | undefined) => {
    const notes = (entriesByCell.get(`${key}|${date}`) ?? []).filter((e) => e.notes);
    return (
      <td
        key={date}
        class={notes.length > 0 ? 'ruddr-hours-cell--note' : undefined}
        title={notes.length > 0 ? notes.map((e) => `${formatMinutes(e.minutes)} — “${e.notes}”`).join('\n') : undefined}
      >
        {minutes ? formatMinutes(minutes) : ''}
      </td>
    );
  };

  // "Undefined" says nothing on its own, so its hours are broken down by note.
  const isUndefinedWorkType = (name: string | null) => (name ?? '').trim().toLowerCase() === 'undefined';
  const noteRows = (projectPath: string, taskPath: string) => {
    const byNote = new Map<string, { byDate: Map<string, number>; total: number }>();
    for (const e of week?.entries ?? []) {
      if (e.projectPath !== projectPath || e.taskPath !== taskPath) continue;
      const note = e.notes ?? '';
      const n = byNote.get(note) ?? { byDate: new Map(), total: 0 };
      n.byDate.set(e.date, (n.byDate.get(e.date) ?? 0) + e.minutes);
      n.total += e.minutes;
      byNote.set(note, n);
    }
    return [...byNote.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(([note, n]) => (
        <tr key={`${projectPath}|${taskPath}|note:${note}`} class="ruddr-hours-row--note">
          <td class="ruddr-hours-proj" title={note || 'No note'}>
            <span class="ruddr-hours-note">{note ? `“${note}”` : '(no note)'}</span>
          </td>
          {days.map((d) => <td key={d}>{n.byDate.get(d) ? formatMinutes(n.byDate.get(d)!) : ''}</td>)}
          <td>{formatMinutes(n.total)}</td>
        </tr>
      ));
  };
  const isFuture = weekStart > currentMonday();

  // Only projects logged in the week on screen; hidden ones never show.
  const weekMinutesByPath = new Map<string, number>();
  for (const r of week?.rows ?? []) weekMinutesByPath.set(r.projectPath, (weekMinutesByPath.get(r.projectPath) ?? 0) + r.minutes);
  const visibleUnlinked = (summary?.unlinked ?? []).filter((p) => weekMinutesByPath.has(p.projectPath));
  const hiddenCount = summary?.hidden.length ?? 0;

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
      {status?.lastError && !status.loginRequired && !status.extensionOutdated && !status.running && (
        <div class="ruddr-hours-warn">⚠️ Last run: {status.lastError}</div>
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
              {sortedProjects.flatMap(([path, p]) => {
                const workTypes = sortedWorkTypes(p);
                const split = workTypes.length > 1;
                // With one work type, its name sits under the project like on Ruddr.
                const onlyWorkType = !split ? workTypes[0]?.[1].name : null;
                const onlyTaskPath = !split ? workTypes[0]?.[0] ?? '' : '';
                return [
                  <tr key={path} class={split ? 'ruddr-hours-row--parent' : undefined}>
                    <td class="ruddr-hours-proj" title={`${rowLabel(p)}${onlyWorkType ? ` — ${onlyWorkType}` : ''}`}>
                      {p.client && <span class="ruddr-hours-client">{p.client} / </span>}{p.name}
                      {onlyWorkType && <span class="ruddr-hours-task">📄 {onlyWorkType}</span>}
                    </td>
                    {days.map((d) => cell(split ? `${path}|*` : `${path}|${onlyTaskPath}`, d, p.byDate.get(d)))}
                    <td class="ruddr-hours-total">{formatMinutes(p.total)}</td>
                  </tr>,
                  ...(!split && isUndefinedWorkType(onlyWorkType ?? null) ? noteRows(path, onlyTaskPath) : []),
                  ...(split ? workTypes.flatMap(([taskPath, w]) => [
                    <tr key={`${path}|${taskPath}`} class="ruddr-hours-row--worktype">
                      <td class="ruddr-hours-proj" title={`${rowLabel(p)} — ${w.name ?? 'no work type'}`}>
                        <span class="ruddr-hours-worktype">📄 {w.name ?? 'No work type'}</span>
                      </td>
                      {days.map((d) => cell(`${path}|${taskPath}`, d, w.byDate.get(d)))}
                      <td>{formatMinutes(w.total)}</td>
                    </tr>,
                    ...(isUndefinedWorkType(w.name) ? noteRows(path, taskPath) : []),
                  ]) : []),
                ];
              })}
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

      {(visibleUnlinked.length > 0 || hiddenCount > 0) && (
        <div class="ruddr-hours-unlinked">
          {visibleUnlinked.length > 0 && (
            <div class="ruddr-hours-subhead">Projects you logged this week that are not in a group</div>
          )}
          {createError && <div class="ruddr-hours-warn">{createError}</div>}
          {visibleUnlinked.map((p) => (
            <div class="ruddr-hours-unlinked-row" key={p.projectPath}>
              <span class="ruddr-hours-unlinked-name" title={p.projectPath}>
                {p.clientName && <span class="ruddr-hours-client">{p.clientName} / </span>}{p.projectName}
              </span>
              <span class="ruddr-hours-unlinked-meta">
                {formatMinutes(weekMinutesByPath.get(p.projectPath) ?? 0)} this week · {formatMinutes(p.totalMinutes)} total
              </span>
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
              <button
                class="ruddr-hours-link ruddr-hours-hide"
                onClick={() => void handleSetHidden(p.projectPath, true)}
                title="Never list this project here again"
                aria-label={`Hide ${p.projectName}`}
              >Hide</button>
            </div>
          ))}
          {hiddenCount > 0 && (
            <button class="ruddr-hours-hidden-toggle" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? '▾' : '▸'} {hiddenCount} hidden project{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}
          {showHidden && summary?.hidden.map((p) => (
            <div class="ruddr-hours-unlinked-row ruddr-hours-unlinked-row--hidden" key={p.projectPath}>
              <span class="ruddr-hours-unlinked-name" title={p.projectPath}>
                {p.clientName && <span class="ruddr-hours-client">{p.clientName} / </span>}{p.projectName}
              </span>
              <span class="ruddr-hours-unlinked-meta">{formatMinutes(p.totalMinutes)} total · last {p.lastDate}</span>
              <button class="ruddr-hours-link" onClick={() => void handleSetHidden(p.projectPath, false)}>Show again</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

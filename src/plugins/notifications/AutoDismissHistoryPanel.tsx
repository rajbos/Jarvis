// ── Auto-Dismiss History Panel ────────────────────────────────────────────────
// Shows all automatically dismissed notifications with an over-time chart.
import { useState, useEffect } from 'preact/hooks';
import type { AutoDismissLogEntry, AutoDismissStats } from '../types';

type Granularity = 'weekly' | 'monthly';

// ── Reason label helpers ──────────────────────────────────────────────────────

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'recovered_workflow': return 'Recovered workflow';
    case 'closed_pr_dependabot': return 'Dependabot PR';
    case 'closed_pr_merged_me': return 'PR merged by me';
    case 'closed_pr_closed_me': return 'PR closed by me';
    case 'closed_issue_me': return 'Issue closed by me';
    case 'closed_issue_via_pr': return 'Issue closed via PR';
    default: return reason;
  }
}

function reasonIcon(reason: string): string {
  switch (reason) {
    case 'recovered_workflow': return '✓';
    case 'closed_pr_dependabot': return '🤖';
    case 'closed_pr_merged_me': return '🔀';
    case 'closed_pr_closed_me': return '✕';
    case 'closed_issue_me': return '✓';
    case 'closed_issue_via_pr': return '🔀';
    default: return '·';
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso + 'Z');
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatPeriod(period: string, granularity: Granularity): string {
  if (granularity === 'monthly') {
    // "2026-05" → "May 2026"
    const [year, month] = period.split('-');
    const d = new Date(Number(year), Number(month) - 1, 1);
    return d.toLocaleString(undefined, { month: 'short', year: 'numeric' });
  }
  // "2026-W21" — just show as-is; parsing ISO week is complex
  return period;
}

// ── SVG Bar Chart ─────────────────────────────────────────────────────────────

function BarChart({ data, granularity }: {
  data: { period: string; count: number }[];
  granularity: Granularity;
}) {
  if (data.length === 0) {
    return <div class="adh-chart-empty">No data yet.</div>;
  }

  // Show oldest→newest left to right
  const sorted = [...data].reverse();
  const maxCount = Math.max(...sorted.map((d) => d.count), 1);
  const n = sorted.length;

  // Coordinate space (abstract units — viewBox scales this to fill the container)
  const padL = 56;
  const padR = 16;
  const padT = 24;
  const padB = 60;
  const plotW = 800;
  const plotH = 300;
  const svgW = padL + plotW + padR;
  const svgH = padT + plotH + padB;

  // Bars distributed evenly across the plot area
  const barUnit = plotW / n;
  const barW = Math.min(barUnit * 0.7, 100);
  const plotTop = padT;
  const plotBottom = padT + plotH;
  const plotHeight = plotH;

  // Y-axis ticks
  const yTicks = [...new Set([0, Math.round(maxCount / 2), maxCount])];

  return (
    <div class="adh-chart-scroll">
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMinYMin meet"
        class="adh-chart-svg"
      >
        {/* Y-axis grid lines + labels */}
        {yTicks.map((tick) => {
          const y = plotBottom - (tick / maxCount) * plotHeight;
          return (
            <g key={`tick-${tick}`}>
              <line
                x1={padL}
                y1={y}
                x2={padL + plotW}
                y2={y}
                stroke="#1e3a5a"
                stroke-width="1"
                stroke-dasharray={tick === 0 ? undefined : '3 3'}
              />
              <text
                x={padL - 6}
                y={y + 4}
                text-anchor="end"
                font-size="12"
                fill="#3a5a7a"
              >
                {tick}
              </text>
            </g>
          );
        })}

        {sorted.map((d, i) => {
          const barH = Math.max(1, (d.count / maxCount) * plotHeight);
          const x = padL + i * barUnit;
          const y = plotBottom - barH;
          const label = formatPeriod(d.period, granularity);
          return (
            <g key={d.period}>
              <title>{label}: {d.count} dismissed</title>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                fill="#1a7a44"
                rx={3}
              />
              <text
                x={x + barW / 2}
                y={y - 6}
                text-anchor="middle"
                font-size="12"
                fill="#4eca8a"
              >
                {d.count}
              </text>
              <text
                x={x + barW / 2}
                y={plotBottom + 14}
                text-anchor="start"
                dominant-baseline="middle"
                font-size="11"
                fill="#5a7a64"
                transform={`rotate(45, ${x + barW / 2}, ${plotBottom + 14})`}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function AutoDismissHistoryPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<AutoDismissLogEntry[]>([]);
  const [stats, setStats] = useState<AutoDismissStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'chart'>('list');
  const [granularity, setGranularity] = useState<Granularity>('weekly');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      window.jarvis.listAutoDismissLog(),
      window.jarvis.getAutoDismissStats(),
    ])
      .then(([log, s]) => {
        if (cancelled) return;
        setEntries(log);
        setStats(s);
      })
      .catch((err) => {
        console.error('[AutoDismissHistory] Failed to load:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const chartData = stats
    ? (granularity === 'weekly' ? stats.weekly : stats.monthly)
    : [];
  const totalAllTime = chartData.reduce((s, d) => s + d.count, 0);

  return (
    <div class="adh-panel">
      <div class="adh-header">
        <div class="adh-header-left">
          <span class="adh-title">Auto-Dismissed Notifications</span>
          {!loading && (
            <span class="adh-subtitle">
              {entries.length} recent · {totalAllTime} all-time
            </span>
          )}
        </div>
        <div class="adh-header-right">
          <button
            class={`adh-tab${view === 'list' ? ' adh-tab--active' : ''}`}
            onClick={() => setView('list')}
          >List</button>
          <button
            class={`adh-tab${view === 'chart' ? ' adh-tab--active' : ''}`}
            onClick={() => setView('chart')}
          >Chart</button>
          <button class="adh-close" onClick={onClose} title="Close">×</button>
        </div>
      </div>

      {loading ? (
        <div class="adh-loading">Loading history…</div>
      ) : view === 'chart' ? (
        <div class="adh-chart-view">
          <div class="adh-chart-controls">
            <button
              class={`adh-gran-btn${granularity === 'weekly' ? ' adh-gran-btn--active' : ''}`}
              onClick={() => setGranularity('weekly')}
            >Weekly</button>
            <button
              class={`adh-gran-btn${granularity === 'monthly' ? ' adh-gran-btn--active' : ''}`}
              onClick={() => setGranularity('monthly')}
            >Monthly</button>
          </div>
          <BarChart data={chartData} granularity={granularity} />
          <div class="adh-chart-note">
            Showing up to {granularity === 'weekly' ? '52 weeks' : '24 months'} of history
          </div>
        </div>
      ) : (
        <div class="adh-list">
          {entries.length === 0 ? (
            <div class="adh-empty">No auto-dismissed notifications yet.</div>
          ) : (
            entries.map((e) => (
              <div key={e.id} class="adh-entry">
                <span class="adh-entry-icon" title={reasonLabel(e.reason)}>
                  {reasonIcon(e.reason)}
                </span>
                <div class="adh-entry-body">
                  <span class="adh-entry-title">
                    {e.subject_title ?? e.notification_id}
                  </span>
                  <span class="adh-entry-meta">
                    {e.repo_full_name && (
                      <span class="adh-entry-repo">{e.repo_full_name}</span>
                    )}
                    <span class="adh-entry-reason">{reasonLabel(e.reason)}</span>
                    <span class="adh-entry-date">{formatDate(e.dismissed_at)}</span>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

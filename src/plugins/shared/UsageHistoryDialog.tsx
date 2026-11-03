import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { isIpcError, type UsageHistoryMetric, type UsageHistoryPoint, type UsageHistoryRange } from '../types';
import { formatNumber } from './utils';
import { chartY, historyBands, niceCeil, timeTicks } from './usage-history-chart';

const W = 760;
const H = 240;
const PAD_LEFT = 48;
const PAD_BOTTOM = 22;
const PAD_TOP = 8;
const PLOT_W = W - PAD_LEFT;
const PLOT_H = H - PAD_BOTTOM - PAD_TOP;

const HOUR = 60 * 60 * 1000;
const RANGES = [
  { label: '2h', ms: 2 * HOUR },
  { label: '6h', ms: 6 * HOUR },
  { label: '24h', ms: 24 * HOUR },
  { label: '7d', ms: 7 * 24 * HOUR },
  { label: '30d', ms: 30 * 24 * HOUR },
] as const;

export interface UsageHistorySeries {
  key: string;
  label: string;
  color: string;
  /** Off by default (e.g. a quota that swings too fast to read next to the others). */
  hidden?: boolean;
}

interface Props {
  title: string;
  metric: UsageHistoryMetric;
  series: readonly UsageHistorySeries[];
  /**
   * `remaining`: values count down to 0 (rate limits) — the line is each slot's
   * lowest value and the table lists lows. `used`: values count up to the limit
   * (utilization, credits) — the line is each slot's highest and the table lists peaks.
   */
  mode: 'remaining' | 'used';
  /** Formats a value for the axis, tooltip and table; defaults to a plain number. */
  format?: (value: number) => string;
  /** Show values as "value / limit"; off when the value is already a percentage. */
  showLimit?: boolean;
  initialRangeMs?: number;
  footnote?: string;
  onClose: () => void;
}

/** Props that turn a status-bar badge label into the button that opens its history dialog. */
export function historyTriggerProps(open: () => void) {
  return {
    tabIndex: 0,
    role: 'button' as const,
    'aria-haspopup': 'dialog' as const,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    },
  };
}

const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Zoomable history of one stored usage metric. Each line keeps the extreme of
 * every time slot (lowest for `remaining`, highest for `used`) with a faint band
 * to the other extreme, so short dips and spikes stay visible when zoomed out.
 */
export function UsageHistoryDialog({
  title, metric, series, mode, format = formatNumber, showLimit = true, initialRangeMs, footnote, onClose,
}: Props) {
  const [rangeMs, setRangeMs] = useState<number>(initialRangeMs ?? RANGES[0].ms);
  const [data, setData] = useState<UsageHistoryRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>(() => Object.fromEntries(series.map((s) => [s.key, !s.hidden])));
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await window.jarvis.getUsageHistory(metric, rangeMs);
        if (cancelled) return;
        if (isIpcError(res)) setError(res.error);
        else { setData(res); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void load();
    const id = window.setInterval(load, 2 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [metric, rangeMs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const view = data && data.end - data.start > 0 ? data : null;
  const visible = series.filter((s) => shown[s.key]);

  // Series plot as a share of their own limit. When any shown series has none
  // (unlimited Copilot plan), every line switches to raw values on an axis from
  // 0 to a round number above the highest one, so they stay comparable.
  const unlimited = view ? visible.some((s) => view.slots.some((slot) => slot.series[s.key] && slot.series[s.key].limit === null)) : false;
  const scale = view && unlimited
    ? niceCeil(Math.max(0, ...visible.flatMap((s) => view.slots.map((slot) => slot.series[s.key]?.max ?? 0))))
    : null;
  const yOf = (value: number, limit: number | null) => chartY(value, limit, PLOT_H, scale);

  const bands = view
    ? visible.map((s) => ({ s, segments: historyBands(view.slots, s.key, view.start, view.end, PLOT_W, PLOT_H, view.slotMs, scale) }))
    : [];
  const hasLine = bands.some((b) => b.segments.some((seg) => seg.length > 0));
  const extremes: Record<string, UsageHistoryPoint> = view ? (mode === 'remaining' ? view.low : view.high) : {};

  const xOf = (at: number) => (view ? ((at - view.start) / (view.end - view.start)) * PLOT_W : 0);

  const onMove = (e: MouseEvent) => {
    if (!view || view.slots.length === 0 || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W - PAD_LEFT;
    const at = view.start + (x / PLOT_W) * (view.end - view.start);
    const mid = (i: number) => (view.slots[i].from + view.slots[i].to) / 2;
    let best = 0;
    view.slots.forEach((_, i) => { if (Math.abs(mid(i) - at) < Math.abs(mid(best) - at)) best = i; });
    // Only snap when the cursor is near data, not across a gap of hours.
    setHover(Math.abs(mid(best) - at) <= Math.max(view.slotMs * 2, (view.end - view.start) / 60) ? best : null);
  };

  const hoverSlot = view && hover !== null ? view.slots[hover] : null;
  const hoverX = hoverSlot ? xOf((hoverSlot.from + hoverSlot.to) / 2) : 0;
  const withLimit = (value: number, limit: number | null) => (showLimit && limit !== null ? `${format(value)} / ${format(limit)}` : format(value));

  return createPortal(
    <div class="bg-copilot-raw-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="bg-copilot-raw bg-rlh" role="dialog" aria-label={title}>
        <div class="bg-copilot-raw-head">
          <strong>{title}</strong>
          <div class="bg-rlh-ranges" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                type="button"
                key={r.label}
                class={`bg-rlh-range${r.ms === rangeMs ? ' bg-rlh-range--active' : ''}`}
                aria-pressed={r.ms === rangeMs}
                onClick={() => { setRangeMs(r.ms); setHover(null); }}
              >
                {r.label}
              </button>
            ))}
            <button type="button" class="bg-status-claude-action" onClick={onClose}>Close</button>
          </div>
        </div>

        <div class="bg-copilot-raw-body">
          {error && <div class="bg-status-claude-error">Could not load history: {error}</div>}

          <div class="bg-rlh-chart" onMouseLeave={() => setHover(null)}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              width="100%"
              role="img"
              aria-label={`${title}: ${mode === 'remaining' ? 'lowest remaining' : 'highest used'} per time slot`}
              onMouseMove={onMove}
            >
              <g transform={`translate(${PAD_LEFT}, ${PAD_TOP})`}>
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <g key={f}>
                    <line class="bg-ratelimit-grid" x1={0} x2={PLOT_W} y1={(1 - f) * PLOT_H} y2={(1 - f) * PLOT_H} />
                    <text class="bg-rlh-ylabel" x={-6} y={(1 - f) * PLOT_H + 4}>
                      {scale !== null ? format(f * scale) : `${f * 100}%`}
                    </text>
                  </g>
                ))}
                {view && timeTicks(view.start, view.end, 6).map((t, i, all) => (
                  <text
                    key={t.at}
                    class="bg-rlh-xlabel"
                    x={xOf(t.at)}
                    y={PLOT_H + 16}
                    text-anchor={i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}
                  >
                    {t.label}
                  </text>
                ))}

                {bands.map(({ s, segments }) => (
                  <g key={s.key}>
                    {segments.map((seg, i) => {
                      const lineY = (p: (typeof seg)[number]) => (mode === 'remaining' ? p.yMin : p.yMax);
                      return (
                        <g key={i}>
                          {seg.length > 1 && (
                            <polygon
                              points={[...seg.map((p) => `${p.x},${p.yMax}`), ...seg.slice().reverse().map((p) => `${p.x},${p.yMin}`)].join(' ')}
                              fill={s.color}
                              fill-opacity={0.15}
                            />
                          )}
                          <polyline
                            points={seg.map((p) => `${p.x},${lineY(p)}`).join(' ')}
                            fill="none"
                            stroke={s.color}
                            stroke-width={2}
                            stroke-linejoin="round"
                            stroke-linecap="round"
                          />
                          {seg.length === 1 && <circle cx={seg[0].x} cy={lineY(seg[0])} r={2.5} fill={s.color} />}
                        </g>
                      );
                    })}
                  </g>
                ))}

                {view && visible.map((s) => {
                  const p = extremes[s.key];
                  if (!p) return null;
                  const x = xOf(p.at);
                  const y = yOf(p.value, p.limit);
                  const anchor = x > PLOT_W * 0.8 ? 'end' : x < PLOT_W * 0.2 ? 'start' : 'middle';
                  return (
                    <g key={`ext-${s.key}`} class="bg-rlh-low">
                      <circle cx={x} cy={y} r={4} fill="none" stroke={s.color} stroke-width={2} />
                      <text x={x} y={y > PLOT_H - 14 ? y - 8 : y + 16} text-anchor={anchor} fill={s.color}>
                        {mode === 'remaining' ? 'low' : 'peak'} {format(p.value)}
                      </text>
                    </g>
                  );
                })}

                {hoverSlot && <line class="bg-rlh-cursor" x1={hoverX} x2={hoverX} y1={0} y2={PLOT_H} />}
              </g>
            </svg>

            {view && !hasLine && (
              <div class="bg-rlh-empty">
                {view.sampleCount === 0 ? 'No samples recorded in this range yet.' : 'Only one sample in this range so far.'}
              </div>
            )}

            {hoverSlot && (
              <div
                class="bg-rlh-tip"
                style={{
                  left: `${((hoverX + PAD_LEFT) / W) * 100}%`,
                  transform: hoverX > PLOT_W / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
                }}
              >
                <div class="bg-rlh-tip-time">
                  {when(hoverSlot.from)}
                  {view!.slotMs > 3 * 60 * 1000 ? ` – ${new Date(hoverSlot.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                </div>
                {series.map((s) => {
                  const v = hoverSlot.series[s.key];
                  if (!v) return null;
                  return (
                    <div key={s.key} class="bg-rlh-tip-row">
                      <i style={{ background: s.color }} />
                      <span>{s.label}</span>
                      <span>
                        {v.min === v.max ? withLimit(v.min, v.limit) : withLimit(v.min, null) + '–' + withLimit(v.max, v.limit)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div class="bg-ratelimit-legend bg-rlh-legend">
            {series.map((s) => (
              <label key={s.key}>
                <input type="checkbox" checked={shown[s.key]} onChange={() => setShown((v) => ({ ...v, [s.key]: !v[s.key] }))} />
                <i style={{ background: s.color }} />{s.label}
              </label>
            ))}
            <span class="bg-rlh-legend-note">
              Line = {mode === 'remaining' ? 'lowest remaining' : 'highest used'} · band = range within each slot
            </span>
          </div>

          {view && (
            <table class="bg-rlh-table">
              <thead>
                <tr><th>Series</th><th>{mode === 'remaining' ? 'Lowest' : 'Highest'} in range</th><th>When</th></tr>
              </thead>
              <tbody>
                {series.map((s) => {
                  const p = extremes[s.key];
                  return (
                    <tr key={s.key}>
                      <td>{s.label}</td>
                      <td>
                        {p ? withLimit(p.value, p.limit) : '–'}
                        {p && p.limit && showLimit ? ` (${Math.round((p.value / p.limit) * 100)}%)` : ''}
                      </td>
                      <td>{p ? when(p.at) : '–'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {view && (
            <div class="bg-status-claude-checked bg-rlh-foot">
              {formatNumber(view.sampleCount)} samples in range
              {view.oldestAt ? ` · history since ${new Date(view.oldestAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
              {' · '}{footnote ?? 'recorded at every check while Jarvis runs'}, kept for 30 days.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

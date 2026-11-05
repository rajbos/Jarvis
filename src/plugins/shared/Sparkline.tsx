import { useEffect, useState } from 'preact/hooks';
import { isIpcError, type UsageHistoryMetric, type UsageHistoryRange } from '../types';
import { historyBands } from './usage-history-chart';

const W = 280;
const H = 26;
const PAD = 2;

/** Loads stored usage history for a status-bar flyout and refreshes it every 2 minutes. */
export function useUsageHistory(metric: UsageHistoryMetric, rangeMs: () => number): UsageHistoryRange | null {
  const [data, setData] = useState<UsageHistoryRange | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await window.jarvis.getUsageHistory(metric, rangeMs());
        if (!cancelled && !isIpcError(res)) setData(res);
      } catch {
        // A missing sparkline is fine; the flyout still shows the current numbers.
      }
    };
    void load();
    const id = window.setInterval(load, 2 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric]);
  return data;
}

interface SparklineProps {
  history: UsageHistoryRange | null;
  series: string;
  color: string;
  /**
   * `remaining`: line follows each slot's lowest value, as a share of its limit (0–100%).
   * `used`: line follows each slot's highest raw value, scaled to the highest value seen,
   * so the limit never flattens the curve.
   */
  mode: 'remaining' | 'used';
  /** Short caption on the left, e.g. "48h". */
  caption: string;
  title: string;
}

/** Tiny history chart for one series, sized to sit under a flyout row. */
export function Sparkline({ history, series, color, mode, caption, title }: SparklineProps) {
  const slots = history?.slots ?? [];
  const scale = mode === 'used'
    ? Math.max(1, ...slots.map((s) => s.series[series]?.max ?? 0))
    : null;
  const segments = history
    ? historyBands(slots, series, history.start, history.end, W - 2 * PAD, H - 2 * PAD, history.slotMs, scale)
    : [];
  const hasLine = segments.some((seg) => seg.length > 0);
  const y = (p: { yMin: number; yMax: number }) => (mode === 'remaining' ? p.yMin : p.yMax) + PAD;

  return (
    <div class="bg-sparkline" title={title}>
      <span class="bg-sparkline-caption">{caption}</span>
      {hasLine ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title}>
          <line class="bg-ratelimit-grid" x1={0} x2={W} y1={H - PAD} y2={H - PAD} />
          {segments.map((seg, i) => (
            seg.length === 1
              ? <circle key={i} cx={seg[0].x + PAD} cy={y(seg[0])} r={2} fill={color} />
              : (
                <polyline
                  key={i}
                  points={seg.map((p) => `${p.x + PAD},${y(p)}`).join(' ')}
                  fill="none"
                  stroke={color}
                  stroke-width={1.5}
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  vector-effect="non-scaling-stroke"
                />
              )
          ))}
        </svg>
      ) : (
        <span class="bg-sparkline-empty">{history ? 'collecting data…' : ''}</span>
      )}
    </div>
  );
}

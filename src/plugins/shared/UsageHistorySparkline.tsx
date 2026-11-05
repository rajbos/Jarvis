import { useEffect, useState } from 'preact/hooks';
import { isIpcError, type UsageHistoryMetric, type UsageHistoryRange } from '../types';
import { historyBands } from './usage-history-chart';

const W = 320;
const H = 72;
const HOUR = 60 * 60 * 1000;

export interface SparklineSeries {
  key: string;
  label: string;
  color: string;
}

interface Props {
  metric: UsageHistoryMetric;
  series: readonly SparklineSeries[];
  /** Changes whenever a new reading was stored, so the chart reloads with it. */
  refreshKey?: number;
  rangeMs?: number;
  /** Text for the legend after each label, e.g. "% used". */
  legendSuffix?: string;
}

/**
 * Compact hover chart of the stored history of one usage metric, for the
 * status-bar popovers. Lines are the highest value per slot, plotted as a share
 * of the series' limit (top = full). The click-through dialog shows the rest.
 */
export function UsageHistorySparkline({ metric, series, refreshKey, rangeMs = 2 * HOUR, legendSuffix = '' }: Props) {
  const [data, setData] = useState<UsageHistoryRange | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.jarvis.getUsageHistory(metric, rangeMs)
      .then((res) => { if (!cancelled && !isIpcError(res)) setData(res); })
      .catch(() => { /* the chart just stays empty */ });
    return () => { cancelled = true; };
  }, [metric, rangeMs, refreshKey]);

  const lines = data
    ? series.map((s) => ({
        s,
        segments: historyBands(data.slots, s.key, data.start, data.end, W, H, data.slotMs),
      }))
    : [];
  const hasLine = lines.some((l) => l.segments.some((seg) => seg.length > 1));
  const hours = Math.round(rangeMs / HOUR);

  return (
    <div class="bg-ratelimit-chart">
      {hasLine ? (
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Usage over the last ${hours} hours`}>
          {[0, 0.5, 1].map((f) => (
            <line key={f} class="bg-ratelimit-grid" x1={0} x2={W} y1={f * H} y2={f * H} />
          ))}
          {lines.map(({ s, segments }) => (
            <g key={s.key}>
              {segments.map((seg, i) => (
                <g key={i}>
                  <polyline
                    points={seg.map((p) => `${p.x},${p.yMax}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    stroke-width={2}
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                  {i === segments.length - 1 && (
                    <circle cx={seg[seg.length - 1].x} cy={seg[seg.length - 1].yMax} r={3} fill={s.color} />
                  )}
                </g>
              ))}
            </g>
          ))}
        </svg>
      ) : (
        <div class="bg-ratelimit-empty">Collecting data, with one sample every 2 minutes…</div>
      )}
      <div class="bg-ratelimit-axis">
        <span>−{hours}h</span><span>−{hours / 2}h</span><span>now</span>
      </div>
      <div class="bg-ratelimit-legend">
        {series.map((s) => (
          <span key={s.key}><i style={{ background: s.color }} />{s.label}{legendSuffix}</span>
        ))}
      </div>
    </div>
  );
}

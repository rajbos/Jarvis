import type { UsageHistoryPoint, UsageHistoryRange, UsageHistorySample, UsageHistorySlot } from '../types';

/** Most slots a history query returns; longer ranges are downsampled to this. */
export const USAGE_HISTORY_MAX_SLOTS = 360;

/** Share of the limit, or the raw value when there is no limit. Used to rank lows and highs. */
const share = (value: number, limit: number | null) => (limit && limit > 0 ? value / limit : value);

/**
 * Fold samples into at most `maxSlots` equal time slots. Each slot keeps the
 * lowest and highest value per series, so a dip or spike between two polls
 * never disappears when zoomed out.
 */
export function downsampleUsageHistory(
  samples: UsageHistorySample[],
  start: number,
  end: number,
  maxSlots: number = USAGE_HISTORY_MAX_SLOTS,
): Pick<UsageHistoryRange, 'slotMs' | 'slots' | 'low' | 'high'> {
  // A slot should hold at least one 2-minute poll, or short ranges turn into
  // a row of empty slots that look like gaps.
  const slotMs = Math.max(2 * 60 * 1000, Math.ceil((end - start) / maxSlots));
  const slots: UsageHistorySlot[] = [];
  const low: Record<string, UsageHistoryPoint> = {};
  const high: Record<string, UsageHistoryPoint> = {};
  let current: UsageHistorySlot | null = null;

  for (const sample of samples) {
    if (sample.at < start || sample.at > end) continue;
    const from = start + Math.floor((sample.at - start) / slotMs) * slotMs;
    if (!current || current.from !== from) {
      current = { from, to: Math.min(from + slotMs, end), series: {} };
      slots.push(current);
    }
    for (const [name, { value, limit }] of Object.entries(sample.series)) {
      if (limit !== null && limit <= 0) continue;
      const agg = current.series[name];
      if (!agg) {
        current.series[name] = { min: value, max: value, last: value, limit };
      } else {
        agg.min = Math.min(agg.min, value);
        agg.max = Math.max(agg.max, value);
        agg.last = value;
        agg.limit = limit;
      }
      const s = share(value, limit);
      if (!low[name] || s < share(low[name].value, low[name].limit)) low[name] = { value, limit, at: sample.at };
      if (!high[name] || s > share(high[name].value, high[name].limit)) high[name] = { value, limit, at: sample.at };
    }
  }
  return { slotMs, slots, low, high };
}

/** One point of a history band: y of the lowest and highest value in a slot. */
export interface BandPoint {
  x: number;
  yMin: number;
  yMax: number;
  slotIndex: number;
}

/**
 * Map downsampled slots to SVG coordinates, split into segments wherever no
 * samples were recorded for a while (the app was closed), so the line does not
 * bridge a gap it knows nothing about. `scale` is the value at the top of the
 * chart when a series has no limit of its own.
 */
export function historyBands(
  slots: UsageHistorySlot[],
  series: string,
  start: number,
  end: number,
  width: number,
  height: number,
  slotMs: number,
  scale: number = 1,
): BandPoint[][] {
  const span = Math.max(1, end - start);
  // Long ranges bridge overnight gaps; otherwise a month of history reads as a dashed line.
  const maxGap = Math.max(slotMs * 2, 6 * 60 * 1000, span / 40);
  const segments: BandPoint[][] = [];
  let segment: BandPoint[] = [];
  let prevTo: number | null = null;
  slots.forEach((slot, slotIndex) => {
    const v = slot.series[series];
    if (!v) return;
    if (prevTo !== null && slot.from - prevTo > maxGap && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
    prevTo = slot.to;
    const mid = Math.min(end, (slot.from + slot.to) / 2);
    segment.push({
      x: round(((mid - start) / span) * width),
      yMin: round(chartY(v.min, v.limit, height, scale)),
      yMax: round(chartY(v.max, v.limit, height, scale)),
      slotIndex,
    });
  });
  if (segment.length > 0) segments.push(segment);
  return segments;
}

/** y for a value: its share of the limit (or of `scale` without one), top = full. */
export function chartY(value: number, limit: number | null, height: number, scale: number = 1): number {
  const ratio = limit && limit > 0 ? value / limit : scale > 0 ? value / scale : 0;
  return (1 - Math.min(1, Math.max(0, ratio))) * height;
}

/** A round number at or above `n`, for the top of an unlimited series' axis. */
export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= n) ?? 10;
  return step * mag;
}

/** Evenly spaced time ticks across [start, end], labelled to suit the range. */
export function timeTicks(start: number, end: number, count: number): { at: number; label: string }[] {
  const span = end - start;
  const opts: Intl.DateTimeFormatOptions = span <= 24 * 60 * 60 * 1000
    ? { hour: '2-digit', minute: '2-digit' }
    : span <= 3 * 24 * 60 * 60 * 1000
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' };
  return Array.from({ length: count }, (_, i) => {
    const at = start + (span * i) / (count - 1);
    return { at, label: new Date(at).toLocaleString([], opts) };
  });
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

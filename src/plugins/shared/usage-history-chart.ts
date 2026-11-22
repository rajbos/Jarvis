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
 * bridge a gap it knows nothing about. `scale` null plots each series as a
 * share of its own limit; a number plots raw values against that axis maximum.
 */
export function historyBands(
  slots: UsageHistorySlot[],
  series: string,
  start: number,
  end: number,
  width: number,
  height: number,
  slotMs: number,
  scale: AxisDomain | null = null,
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

/** A raw-value y axis: `min` at the bottom, `max` at the top. */
export interface AxisDomain {
  min: number;
  max: number;
}

/** y for a value: its position in `scale` when one is given, else its share of the limit; top = full. */
export function chartY(value: number, limit: number | null, height: number, scale: AxisDomain | null = null): number {
  const lo = scale?.min ?? 0;
  const hi = scale?.max ?? limit;
  const ratio = hi && hi > lo ? (value - lo) / (hi - lo) : 0;
  return (1 - Math.min(1, Math.max(0, ratio))) * height;
}

/**
 * Axis that fits the data: from 0 to a round number above the highest value, or,
 * when every value sits in a narrow high band (e.g. a counter creeping up late in
 * the month), zoomed in on that band so the progression stays readable.
 * Always 4 equal intervals of a round step. Usage counters are never negative, so
 * negative or non-finite input is clamped; a flat series (lo == hi) is not zoomed,
 * since a ±1% window around one value reads as noise.
 */
export function fitAxisDomain(lo: number, hi: number): AxisDomain {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > 0)) return { min: 0, max: 1 };
  lo = Math.min(Math.max(0, lo), hi);
  const span = hi - lo;
  const zoom = lo > 0 && span > 0 && span < hi * 0.6;
  const pad = zoom ? Math.max(span * 0.15, hi * 0.01) : hi * 0.08;
  const bottom = zoom ? Math.max(0, lo - pad) : 0;
  const step = niceStep((hi + pad - bottom) / 4);
  const min = zoom ? Math.floor(bottom / step) * step : 0;
  const stepFinal = zoom ? niceStep((hi + pad - min) / 4) : step;
  return { min: clean(min), max: clean(min + stepFinal * 4) };
}

/**
 * y axis for the history dialog. Series plot as a share of their own limit
 * (null). When any visible series has no limit in some slot (unlimited Copilot
 * plan), or `absolute` is set, every line switches to raw values on an axis
 * fitted to the visible series' lows and highs, so they stay comparable.
 * Hidden series do not count: hiding one rescales the axis to the rest.
 */
export function historyAxisScale(slots: UsageHistorySlot[], visibleKeys: readonly string[], absolute: boolean): AxisDomain | null {
  const unlimited = visibleKeys.some((key) => slots.some((slot) => slot.series[key] && slot.series[key].limit === null));
  if (!unlimited && !absolute) return null;
  const vals = visibleKeys.flatMap((key) => slots.flatMap((slot) => (slot.series[key] ? [slot.series[key].min, slot.series[key].max] : [])));
  return vals.length > 0 ? fitAxisDomain(Math.min(...vals), Math.max(...vals)) : { min: 0, max: 1 };
}

/**
 * Percent-of-limit suffix for the tooltip and table, e.g. " (42%)". Only shown on
 * a raw-value (`absolute`) chart: on a share-of-limit chart the axis already is
 * the percentage. Empty when there is no (positive) limit or limits are hidden.
 */
export function limitPercentSuffix(value: number, limit: number | null, absolute: boolean, showLimit: boolean): string {
  return absolute && showLimit && limit ? ` (${Math.round((value / limit) * 100)}%)` : '';
}

/**
 * y axis for a sparkline. `used` plots raw values from 0 to the highest value
 * seen (at least 1), so the limit never flattens the curve; `remaining` plots a
 * share of the limit (null).
 */
export function sparklineScale(slots: UsageHistorySlot[], series: string, mode: 'remaining' | 'used'): AxisDomain | null {
  return mode === 'used'
    ? { min: 0, max: Math.max(1, ...slots.map((s) => s.series[series]?.max ?? 0)) }
    : null;
}

/** Drops floating-point residue (4.800000000000001) so tick labels stay round. */
const clean = (n: number): number => Number(n.toPrecision(12));

/** A round number at or above `n`, for the top of an unlimited series' axis. */
export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= n) ?? 10;
  return step * mag;
}

/** A round grid step at or above `n` (finer than niceCeil, so axes don't overshoot the data). */
function niceStep(n: number): number {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 10].find((m) => m * mag >= n) ?? 10) * mag;
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

// Presets for the flyout's "Try an endpoint" tool. Electron-free so it can be unit tested.
export interface ProbePreset {
  label: string;
  endpoint: string;
}

interface PresetInput {
  login: string;
  now?: Date;
}

/**
 * Endpoints worth comparing: the seat quota's `credits_used` against what the
 * user billing report itemises. Organization and enterprise reports are left
 * out: they answer 404 unless the token belongs to an org/enterprise admin, so
 * they stay reachable only by typing the path.
 */
export function buildProbePresets({ login, now = new Date() }: PresetInput): ProbePreset[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const period = `year=${year}&month=${month}`;
  const user = encodeURIComponent(login);
  return [
    { label: 'Seat quota (credits_used)', endpoint: '/copilot_internal/user' },
    { label: 'User report: this month', endpoint: `/users/${user}/settings/billing/ai_credit/usage?${period}` },
    { label: 'User report: today', endpoint: `/users/${user}/settings/billing/ai_credit/usage?${period}&day=${day}` },
  ];
}

/** Sum of `grossQuantity` over a billing report's `usageItems`; null when the body is not such a report. */
export function sumUsageItems(body: unknown): number | null {
  const items = (body as { usageItems?: unknown } | null)?.usageItems;
  if (!Array.isArray(items)) return null;
  const total = items.reduce((sum: number, item: { grossQuantity?: unknown }) => sum + (Number(item?.grossQuantity) || 0), 0);
  return Math.round(total * 100) / 100;
}

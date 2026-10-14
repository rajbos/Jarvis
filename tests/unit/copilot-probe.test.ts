import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProbeRequest, probeEndpoint, summarizeProbeResponse } from '../../src/services/copilot-probe';
import { buildProbePresets, sumUsageItems } from '../../src/plugins/copilot-usage/probe-presets';

describe('parseProbeRequest', () => {
  it.each([
    '/copilot_internal/user',
    '/users/octocat/settings/billing/ai_credit/usage?year=2026&month=10',
    '/organizations/my-org/settings/billing/ai_credit/usage?year=2026&month=10&day=14&user=octocat',
    '/organizations/my-org/settings/billing/premium_request/usage',
    '/enterprises/my-ent/settings/billing/ai_credit/usage?model=Auto%3A%20GPT-5.6%20Sol',
    '/organizations/my-org/settings/billing/usage/summary',
  ])('accepts %s', (endpoint) => {
    expect(parseProbeRequest(endpoint)).toEqual({ ok: true, endpoint: expect.stringContaining(endpoint.split('?')[0]) });
  });

  it.each([
    '/user',
    '/repos/a/b/issues',
    '/users/../settings/billing/usage',
    '/users/octocat/settings/billing/ai_credit/usage/../../x',
    '//evil.example/users/a/settings/billing/usage',
    'https://api.github.com/copilot_internal/user',
    '/orgs/my-org/settings/billing/usage?foo=bar',
    '/users/octocat/settings/billing/usage?user=a&user=<script>',
  ])('rejects %s', (endpoint) => {
    expect(parseProbeRequest(endpoint).ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(parseProbeRequest(42).ok).toBe(false);
  });
});

describe('probeEndpoint', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a bearer token and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ usageItems: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const raw = await probeEndpoint('tok', '/organizations/o/settings/billing/ai_credit/usage');
    expect(raw).toEqual({ endpoint: '/organizations/o/settings/billing/ai_credit/usage', status: 200, body: { usageItems: [] } });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.github.com/organizations/o/settings/billing/ai_credit/usage');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await probeEndpoint('tok', '/copilot_internal/user')).toEqual({ endpoint: '/copilot_internal/user', status: 0, body: 'offline' });
  });
});

describe('probe presets', () => {
  it('summarises a usage report for the log without the raw body', () => {
    const line = summarizeProbeResponse({
      endpoint: '/organizations/o/settings/billing/ai_credit/usage?year=2026',
      status: 200,
      body: { usageItems: [{ model: 'A', grossQuantity: 5 }, { model: 'B', grossQuantity: 10.5 }, { model: 'A', grossQuantity: 1 }] },
    });
    expect(line).toBe('GET /organizations/o/settings/billing/ai_credit/usage?year=2026 -> 200: 3 items, gross 16.5 AIC (top: B=10.5, A=6)');
  });

  it('summarises the quota answer without leaking tracking ids', () => {
    const line = summarizeProbeResponse({
      endpoint: '/copilot_internal/user',
      status: 200,
      body: {
        analytics_tracking_id: 'secret-id',
        copilot_plan: 'enterprise',
        organization_login_list: ['org-a'],
        quota_snapshots: { premium_interactions: { credits_used: 10, entitlement: 100, remaining: 90 } },
      },
    });
    expect(line).toContain('credits_used=10 entitlement=100 remaining=90 orgs=org-a');
    expect(line).not.toContain('secret-id');
  });

  it('summarises errors', () => {
    expect(summarizeProbeResponse({ endpoint: '/x', status: 403, body: { message: 'Forbidden' } })).toBe('GET /x -> 403: Forbidden');
    expect(summarizeProbeResponse({ endpoint: '/x', status: 0, body: 'offline' })).toBe('GET /x -> no response: offline');
  });

  it('offers the seat quota and user reports, and every endpoint passes validation', () => {
    const presets = buildProbePresets({ login: 'octocat', now: new Date('2026-10-14T12:00:00Z') });
    expect(presets.map((p) => p.endpoint)).toEqual([
      '/copilot_internal/user',
      '/users/octocat/settings/billing/ai_credit/usage?year=2026&month=10',
      '/users/octocat/settings/billing/ai_credit/usage?year=2026&month=10&day=14',
    ]);
    for (const p of presets) expect(parseProbeRequest(p.endpoint).ok, p.endpoint).toBe(true);
  });

  it('sums the gross quantity of a usage report', () => {
    expect(sumUsageItems({ usageItems: [{ grossQuantity: 1.25 }, { grossQuantity: 2 }] })).toBe(3.25);
    expect(sumUsageItems({ nope: true })).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchRelayEvents,
  pollWebhookRelay,
  resetWebhookRelayState,
  summarizeWebhookEvent,
  takeChangedPrs,
  type RelayEnvelope,
} from '../../src/services/webhook-relay';

const repository = { full_name: 'acme/rocket' };

function envelope(event: string, payload: Record<string, unknown>, id = 'e1'): RelayEnvelope {
  return { id, event, receivedAt: '2026-03-01T00:00:00Z', payload: { repository, ...payload } };
}

describe('summarizeWebhookEvent', () => {
  it('maps pull_request and review events to the PR and head sha', () => {
    const pr = envelope('pull_request', { action: 'synchronize', pull_request: { number: 7, head: { sha: 'abc' } } });
    expect(summarizeWebhookEvent(pr)).toMatchObject({ repoFullName: 'acme/rocket', prNumbers: [7], headSha: 'abc', summary: 'pull_request synchronize' });
    const review = envelope('pull_request_review', { action: 'submitted', pull_request: { number: 7 } });
    expect(summarizeWebhookEvent(review)).toMatchObject({ prNumbers: [7], headSha: null });
  });

  it('maps check and workflow events through their pull_requests list', () => {
    const run = envelope('check_run', { action: 'completed', check_run: { name: 'build', head_sha: 'abc', conclusion: 'failure', pull_requests: [{ number: 7 }, { number: 9 }] } });
    expect(summarizeWebhookEvent(run)).toMatchObject({ prNumbers: [7, 9], headSha: 'abc', summary: 'check_run build failure' });
    const wf = envelope('workflow_run', { workflow_run: { name: 'CI', head_sha: 'def', status: 'in_progress', pull_requests: [] } });
    expect(summarizeWebhookEvent(wf)).toMatchObject({ prNumbers: [], headSha: 'def', summary: 'workflow CI in_progress' });
  });

  it('keeps PR comments, drops issue comments and unrelated events', () => {
    expect(summarizeWebhookEvent(envelope('issue_comment', { action: 'created', issue: { number: 3, pull_request: {} } }))).toMatchObject({ prNumbers: [3] });
    expect(summarizeWebhookEvent(envelope('issue_comment', { action: 'created', issue: { number: 3 } }))).toBeNull();
    expect(summarizeWebhookEvent(envelope('push', { ref: 'refs/heads/main' }))).toBeNull();
    expect(summarizeWebhookEvent({ id: 'x', event: 'pull_request', receivedAt: '', payload: {} })).toBeNull();
  });
});

describe('fetchRelayEvents / pollWebhookRelay', () => {
  beforeEach(() => resetWebhookRelayState());

  it('asks the relay for events after the cursor with the bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [], cursor: null }), { status: 200 }));
    const result = await fetchRelayEvents({ url: 'https://relay.example/api', token: 'secret' }, '41', fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, events: [], cursor: '41' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://relay.example/api/events?after=41&limit=200');
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  it('reports HTTP and network failures without throwing', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 401 }));
    expect(await fetchRelayEvents({ url: 'https://relay.example', token: 't' }, null, bad as unknown as typeof fetch)).toMatchObject({ ok: false, status: 401 });
    const down = vi.fn(async () => { throw new Error('offline'); });
    expect(await fetchRelayEvents({ url: 'https://relay.example', token: 't' }, null, down as unknown as typeof fetch)).toMatchObject({ ok: false, status: 0, error: 'offline' });
  });

  it('marks the PRs that changed and advances the cursor', async () => {
    const events: RelayEnvelope[] = [
      envelope('pull_request', { action: 'opened', pull_request: { number: 7, head: { sha: 'a' } } }, '1'),
      envelope('push', {}, '2'),
      envelope('check_suite', { check_suite: { head_sha: 'a', conclusion: 'success', pull_requests: [{ number: 7 }] } }, '3'),
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events }), { status: 200 }));
    const result = await pollWebhookRelay({ url: 'https://relay.example', token: 't' }, fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ fetched: 3, relevant: 2, cursor: '3' });
    const changed = takeChangedPrs();
    expect([...changed.keys()]).toEqual(['acme/rocket#7']);
    expect(changed.get('acme/rocket#7')?.summary).toBe('check_suite success');
    expect(takeChangedPrs().size).toBe(0);

    await pollWebhookRelay({ url: 'https://relay.example', token: 't' }, fetchMock as unknown as typeof fetch);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain('after=3');
  });
});

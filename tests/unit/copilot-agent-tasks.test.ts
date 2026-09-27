import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  cloudStateToActivity,
  fetchRepoFullNameById,
  isTaskRelevant,
  listCopilotAgentTasks,
  type CloudAgentTask,
} from '../../src/services/copilot-agent-tasks';

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listCopilotAgentTasks', () => {
  it('calls the agent tasks API with the versioned header and maps artifacts', async () => {
    const fetchMock = vi.fn(async () => mockResponse({
      tasks: [
        {
          id: 't1',
          name: 'Fix flaky test',
          state: 'in_progress',
          created_at: '2026-03-01T10:00:00Z',
          updated_at: '2026-03-01T11:00:00Z',
          repository: { id: 123 },
          artifacts: [
            { type: 'branch', data: { head_ref: 'copilot/fix-flaky', base_ref: 'main' } },
            { type: 'pull', data: { global_id: 'PR_kw1' } },
          ],
        },
        { id: 't2', state: 'completed', repository: { id: 0 }, artifacts: [] },
        { id: 't3', state: 'completed', archived_at: '2026-03-01T00:00:00Z' },
        { name: 'no id' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listCopilotAgentTasks('tok', { since: '2026-02-28T00:00:00.000Z' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('https://api.github.com/agents/tasks?');
    expect(url).toContain('is_archived=false');
    expect(url).toContain('since=2026-02-28T00%3A00%3A00.000Z');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2026-03-10');
    expect(init.headers.Authorization).toBe('Bearer tok');

    expect(result).toEqual({
      ok: true,
      tasks: [
        {
          id: 't1',
          name: 'Fix flaky test',
          state: 'in_progress',
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-01T11:00:00Z',
          repositoryId: 123,
          pullRequestNodeIds: ['PR_kw1'],
          headRef: 'copilot/fix-flaky',
          baseRef: 'main',
        },
        {
          id: 't2',
          name: null,
          state: 'completed',
          createdAt: null,
          updatedAt: null,
          repositoryId: null,
          pullRequestNodeIds: [],
          headRef: null,
          baseRef: null,
        },
      ],
    });
  });

  it('returns a descriptive error on auth failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ message: 'Forbidden' }, 403)));
    const result = await listCopilotAgentTasks('tok');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain('token may lack access');
    }
  });

  it('returns status 0 on network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await listCopilotAgentTasks('tok')).toEqual({ ok: false, status: 0, error: 'offline' });
  });
});

describe('isTaskRelevant', () => {
  const NOW = Date.parse('2026-03-02T00:00:00Z');
  const task = (state: string, updatedAt: string | null, prs: string[] = []): CloudAgentTask => ({
    id: 'x', name: null, state, createdAt: null, updatedAt, repositoryId: 1, pullRequestNodeIds: prs, headRef: null, baseRef: null,
  });

  it('keeps every active task', () => {
    for (const state of ['queued', 'in_progress', 'idle', 'waiting_for_user']) {
      expect(isTaskRelevant(task(state, null), NOW)).toBe(true);
    }
  });

  it('keeps recently finished tasks only when they produced a PR', () => {
    expect(isTaskRelevant(task('completed', '2026-03-01T12:00:00Z', ['PR_1']), NOW)).toBe(true);
    expect(isTaskRelevant(task('completed', '2026-03-01T12:00:00Z'), NOW)).toBe(false);
    expect(isTaskRelevant(task('completed', '2026-02-20T00:00:00Z', ['PR_1']), NOW)).toBe(false);
  });
});

describe('cloudStateToActivity', () => {
  it('maps documented states', () => {
    expect(cloudStateToActivity('queued')).toBe('queued');
    expect(cloudStateToActivity('in_progress')).toBe('working');
    expect(cloudStateToActivity('waiting_for_user')).toBe('waiting_for_user');
    expect(cloudStateToActivity('idle')).toBe('idle');
    expect(cloudStateToActivity('completed')).toBe('completed');
    expect(cloudStateToActivity('timed_out')).toBe('failed');
    expect(cloudStateToActivity('cancelled')).toBe('failed');
    expect(cloudStateToActivity('something-new')).toBe('unknown');
  });
});

describe('fetchRepoFullNameById', () => {
  it('returns full_name, or null when inaccessible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ full_name: 'o/r' })));
    expect(await fetchRepoFullNameById('tok', 1)).toBe('o/r');
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({}, 404)));
    expect(await fetchRepoFullNameById('tok', 1)).toBeNull();
  });
});

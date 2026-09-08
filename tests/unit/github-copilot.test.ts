import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkCopilotAssignable, assignCopilotToIssue } from '../../src/services/github-copilot';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('checkCopilotAssignable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns available with the bot id when copilot-swe-agent is a suggested actor', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: {
          repository: {
            suggestedActors: {
              nodes: [
                { login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_kwDOtest' },
                { login: 'octocat', __typename: 'User', id: 'U_1' },
              ],
            },
          },
        },
      }),
    );

    const result = await checkCopilotAssignable('token', 'owner/repo');
    expect(result).toEqual({ available: true, botId: 'BOT_kwDOtest' });
  });

  it('returns not_enabled_or_no_seat when copilot-swe-agent is absent from suggestedActors', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: { repository: { suggestedActors: { nodes: [{ login: 'octocat', __typename: 'User', id: 'U_1' }] } } },
      }),
    );

    const result = await checkCopilotAssignable('token', 'owner/repo');
    expect(result).toEqual({ available: false, reason: 'not_enabled_or_no_seat' });
  });

  it('returns repo_not_found_or_no_access on a GraphQL NOT_FOUND error', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }),
    );

    const result = await checkCopilotAssignable('token', 'owner/repo');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('repo_not_found_or_no_access');
  });

  it('returns api_error on other GraphQL errors (e.g. insufficient scope)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] }),
    );

    const result = await checkCopilotAssignable('token', 'owner/repo');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('api_error');
    expect(result.detail).toContain('not accessible');
  });

  it('returns api_error on a non-OK HTTP response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));

    const result = await checkCopilotAssignable('token', 'owner/repo');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('api_error');
  });

  it('returns api_error for a malformed repo full name', async () => {
    const result = await checkCopilotAssignable('token', 'not-a-repo-name');
    expect(result).toEqual({ available: false, reason: 'api_error', detail: expect.stringContaining('Invalid repo full name') });
  });
});

describe('assignCopilotToIssue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves the bot id and calls the replaceActorsForAssignable mutation', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('suggestedActors')) {
        return jsonResponse({
          data: { repository: { suggestedActors: { nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_1' }] } } },
        });
      }
      return jsonResponse({ data: { replaceActorsForAssignable: { clientMutationId: null } } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(assignCopilotToIssue('token', 'owner/repo', 'I_issueNode')).resolves.toBeUndefined();

    const mutationCall = fetchMock.mock.calls.find(([, init]) =>
      JSON.parse(String((init as RequestInit).body)).query.includes('replaceActorsForAssignable'),
    );
    expect(mutationCall).toBeDefined();
    const mutationBody = JSON.parse(String((mutationCall![1] as RequestInit).body)) as { variables: Record<string, unknown> };
    expect(mutationBody.variables).toEqual({ assignableId: 'I_issueNode', actorIds: ['BOT_1'] });
  });

  it('throws a descriptive error when Copilot is not assignable, without calling the mutation', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { repository: { suggestedActors: { nodes: [] } } } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(assignCopilotToIssue('token', 'owner/repo', 'I_issueNode')).rejects.toThrow(
      /not assignable for owner\/repo/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the suggestedActors lookup, no mutation
  });

  it('throws when the mutation itself returns GraphQL errors', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('suggestedActors')) {
        return jsonResponse({
          data: { repository: { suggestedActors: { nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_1' }] } } },
        });
      }
      return jsonResponse({ errors: [{ message: 'Assignable is not assignable' }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(assignCopilotToIssue('token', 'owner/repo', 'I_issueNode')).rejects.toThrow(
      /Failed to assign Copilot coding agent/,
    );
  });
});

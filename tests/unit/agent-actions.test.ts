import { describe, it, expect } from 'vitest';
import type { ActiveAgentSession, ActiveSessionEntry, PrReadiness } from '../../src/plugins/types';
import { actionUnavailableReason, buildAgentPrompt, planAgentAction } from '../../src/services/agent-actions';

const stage = { light: 'green' as const, label: 'ok', detail: 'ok', blocking: false };

function pr(overrides: Partial<PrReadiness> = {}): PrReadiness {
  return {
    repoFullName: 'acme/rocket',
    prNumber: 77,
    title: 'Brakes',
    url: 'https://github.com/acme/rocket/pull/77',
    state: 'OPEN',
    isDraft: false,
    headSha: 'abc',
    headRef: 'copilot/brakes',
    baseRef: 'main',
    mergeable: 'MERGEABLE',
    checks: { ...stage, total: 3, pending: 0, failed: 0, passed: 3 },
    copilotReview: { ...stage, status: 'completed' },
    ready: true,
    waitingOn: [],
    checkedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function session(overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession {
  return {
    key: 'local:claude:s1',
    provider: 'claude',
    origin: 'local',
    client: 'Claude Code',
    sessionId: 's1',
    title: null,
    cwd: 'C:\\src\\rocket',
    repoFullName: 'acme/rocket',
    branch: 'copilot/brakes',
    activity: 'idle',
    startedAt: null,
    updatedAt: null,
    pid: 1,
    ...overrides,
  };
}

function entry(s: Partial<ActiveAgentSession>, p: PrReadiness | null): ActiveSessionEntry {
  return { session: session(s), agent: stage, pr: p, verdict: p ? 'ready' : 'no_pr', verdictLabel: '' };
}

const failing = pr({ checks: { ...stage, light: 'red', total: 3, pending: 0, failed: 2, passed: 1, failedNames: ['build', 'lint'] } });
const conflicting = pr({ mergeable: 'CONFLICTING' });

describe('actionUnavailableReason / buildAgentPrompt', () => {
  it('only offers fix_checks when all checks finished and some failed', () => {
    expect(actionUnavailableReason('fix_checks', null)).toMatch(/No pull request/);
    expect(actionUnavailableReason('fix_checks', pr())).toBe('No failing checks.');
    expect(actionUnavailableReason('fix_checks', pr({ checks: { ...stage, total: 3, pending: 1, failed: 1, passed: 1 } }))).toBe('Checks are still running.');
    expect(actionUnavailableReason('fix_checks', pr({ state: 'MERGED' }))).toBe('The PR is merged.');
    expect(actionUnavailableReason('fix_checks', failing)).toBeNull();
  });

  it('only offers resolve_conflicts for a conflicting open PR', () => {
    expect(actionUnavailableReason('resolve_conflicts', pr())).toBe('No merge conflicts.');
    expect(actionUnavailableReason('resolve_conflicts', pr({ mergeable: 'UNKNOWN' }))).toBe('No merge conflicts.');
    expect(actionUnavailableReason('resolve_conflicts', conflicting)).toBeNull();
    expect(actionUnavailableReason('open', null)).toBeNull();
  });

  it('writes a single-line prompt naming the PR, branch and failing checks', () => {
    const prompt = buildAgentPrompt('fix_checks', entry({}, failing))!;
    expect(prompt).toContain('https://github.com/acme/rocket/pull/77');
    expect(prompt).toContain('2 of 3 failed: build, lint');
    expect(prompt).toContain('push the fix to `copilot/brakes`');
    expect(prompt).not.toMatch(/\n/);
    expect(buildAgentPrompt('open', entry({}, failing))).toBeNull();
    expect(buildAgentPrompt('fix_checks', entry({}, pr()))).toBeNull();
  });

  it('writes a conflict prompt naming the base branch', () => {
    const prompt = buildAgentPrompt('resolve_conflicts', entry({}, conflicting))!;
    expect(prompt).toContain('merge conflicts with its base branch `main`');
    expect(prompt).toContain('merge `origin/main` into `copilot/brakes`');
  });
});

describe('planAgentAction', () => {
  it('resumes a Claude Code terminal session, passing the prompt as the initial message', () => {
    expect(planAgentAction('open', entry({}, null))).toMatchObject({ kind: 'terminal', file: 'claude', args: ['--resume', 's1'], cwd: 'C:\\src\\rocket' });
    const plan = planAgentAction('fix_checks', entry({}, failing));
    expect(plan.kind).toBe('terminal');
    if (plan.kind !== 'terminal') throw new Error('unreachable');
    expect(plan.args.slice(0, 2)).toEqual(['--resume', 's1']);
    expect(plan.args[2]).toContain('build, lint');
  });

  it('opens a new Claude Code session via claude://code/new for desktop-app sessions', () => {
    const plan = planAgentAction('resolve_conflicts', entry({ entrypoint: 'claude-desktop' }, conflicting));
    expect(plan.kind).toBe('deep-link');
    if (plan.kind !== 'deep-link') throw new Error('unreachable');
    const url = new URL(plan.url);
    expect(url.protocol).toBe('claude:');
    expect(url.host + url.pathname).toBe('code/new');
    expect(url.searchParams.get('folder')).toBe('C:\\src\\rocket');
    expect(url.searchParams.get('q')).toContain('merge conflicts');
    expect(plan.copyPrompt).toBe(false);
    expect(planAgentAction('open', entry({ entrypoint: 'claude-desktop', cwd: null }, null)).kind).toBe('unsupported');
  });

  it('opens Copilot app sessions by id and starts a new PR session for a prompt', () => {
    const app = { provider: 'copilot' as const, client: 'Copilot app', sessionId: 'app-1', key: 'local:copilot:app-1' };
    expect(planAgentAction('open', entry(app, failing))).toMatchObject({ kind: 'deep-link', url: 'ghapp://sessions/app-1' });
    const plan = planAgentAction('fix_checks', entry(app, failing));
    if (plan.kind !== 'deep-link') throw new Error('unreachable');
    const url = new URL(plan.url);
    expect(url.host + url.pathname).toBe('session/new');
    expect(url.searchParams.get('repo')).toBe('acme/rocket');
    expect(url.searchParams.get('pr')).toBe('77');
    expect(url.searchParams.get('mode')).toBe('interactive');
    expect(url.searchParams.get('prompt')).toContain('build, lint');
  });

  it('resumes Copilot CLI sessions with -i for a prompt', () => {
    const cli = { provider: 'copilot' as const, client: 'Copilot CLI', sessionId: 'cli-1' };
    expect(planAgentAction('open', entry(cli, null))).toMatchObject({ kind: 'terminal', file: 'copilot', args: ['--resume', 'cli-1'] });
    const plan = planAgentAction('resolve_conflicts', entry(cli, conflicting));
    if (plan.kind !== 'terminal') throw new Error('unreachable');
    expect(plan.args.slice(0, 3)).toEqual(['--resume', 'cli-1', '-i']);
    expect(plan.args[3]).toContain('origin/main');
  });

  it('opens cloud tasks in the Copilot app and triggers them through a PR comment', () => {
    const cloud = { provider: 'copilot' as const, origin: 'cloud' as const, client: 'Copilot cloud agent', sessionId: 't1', cloudTaskId: 't1', cwd: null };
    expect(planAgentAction('open', entry(cloud, failing))).toMatchObject({ kind: 'deep-link', url: 'ghapp://github.com/acme/rocket/tasks/t1' });
    expect(planAgentAction('open', entry({ ...cloud, repoFullName: null }, failing))).toMatchObject({ kind: 'deep-link', url: failing.url });
    expect(planAgentAction('open', entry({ ...cloud, repoFullName: null }, null)).kind).toBe('unsupported');
    const plan = planAgentAction('fix_checks', entry(cloud, failing));
    expect(plan).toMatchObject({ kind: 'pr-comment', repoFullName: 'acme/rocket', prNumber: 77 });
    if (plan.kind !== 'pr-comment') throw new Error('unreachable');
    expect(plan.body.startsWith('@copilot The pull request')).toBe(true);
  });

  it('reports why a prompt action is unavailable', () => {
    expect(planAgentAction('fix_checks', entry({}, pr()))).toEqual({ kind: 'unsupported', description: 'No failing checks.', prompt: null });
  });
});

import { describe, it, expect } from 'vitest';
import type { ActiveAgentSession } from '../../src/plugins/types';
import {
  attachLocalSessionUsage,
  toLocalSessionUsage,
  type ParsedSessionUsage,
} from '../../src/services/local-session-usage';

const parsed = (overrides: Partial<ParsedSessionUsage> = {}): ParsedSessionUsage => ({
  models: ['claude-haiku-5-5', 'claude-opus-5-5'],
  modelUsage: {
    'claude-haiku-5-5': { inputTokens: 1_000, outputTokens: 100 },
    'claude-opus-5-5': { inputTokens: 50_000, outputTokens: 2_000 },
  },
  totalTokens: 53_100,
  copilotCredits: null,
  estimatedCostUsd: { provider: 1.25, copilot: 0.9 },
  ...overrides,
});

const session = (overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession => ({
  key: 'local:claude:s1',
  provider: 'claude',
  origin: 'local',
  client: 'Claude Code',
  sessionId: 's1',
  title: null,
  cwd: null,
  repoFullName: null,
  branch: null,
  activity: 'idle',
  startedAt: null,
  updatedAt: null,
  sessionFile: '/tmp/s1.jsonl',
  ...overrides,
});

describe('toLocalSessionUsage', () => {
  it('picks the model with the most tokens and prices Claude at provider rates', () => {
    expect(toLocalSessionUsage('claude', parsed())).toEqual({
      primaryModel: 'claude-opus-5-5',
      models: ['claude-haiku-5-5', 'claude-opus-5-5'],
      totalTokens: 53_100,
      credits: null,
      estimatedUsd: 1.25,
    });
  });

  it('keeps exact Copilot credits and prices Copilot at Copilot rates', () => {
    const usage = toLocalSessionUsage('copilot', parsed({ copilotCredits: 18.2 }));
    expect(usage.credits).toBe(18.2);
    expect(usage.estimatedUsd).toBe(0.9);
  });

  it('has no primary model when the parser saw none', () => {
    expect(toLocalSessionUsage('claude', parsed({ models: [], modelUsage: {} })).primaryModel).toBeNull();
  });
});

describe('attachLocalSessionUsage', () => {
  it('fills usage for local sessions with a session file and skips the rest', async () => {
    const seen: string[] = [];
    const sessions = [
      session(),
      session({ key: 'local:claude:nofile', sessionFile: null }),
      session({ key: 'cloud:copilot:t1', origin: 'cloud', provider: 'copilot', sessionFile: '/tmp/cloud.jsonl' }),
    ];
    await attachLocalSessionUsage(sessions, async (file) => {
      seen.push(file);
      return parsed();
    });
    expect(seen).toEqual(['/tmp/s1.jsonl']);
    expect(sessions[0].localUsage?.estimatedUsd).toBe(1.25);
    expect(sessions[1].localUsage).toBeUndefined();
    expect(sessions[2].localUsage).toBeUndefined();
  });

  it('leaves a session without usage when its parse fails or finds nothing', async () => {
    const sessions = [session({ key: 'a', sessionFile: 'a' }), session({ key: 'b', sessionFile: 'b' })];
    await attachLocalSessionUsage(sessions, async (file) => {
      if (file === 'a') throw new Error('boom');
      return null;
    });
    expect(sessions.map((s) => s.localUsage)).toEqual([null, null]);
  });

  it('does nothing when no parser is available', async () => {
    const sessions = [session()];
    await attachLocalSessionUsage(sessions, null);
    expect(sessions[0].localUsage).toBeUndefined();
  });
});

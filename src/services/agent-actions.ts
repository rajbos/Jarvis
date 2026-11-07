// ── Agent session actions ─────────────────────────────────────────────────────
// Turns an agent session row into something the user can act on: bring the
// right application forward for the session, or hand the agent a follow-up
// prompt (failing checks, merge conflicts). Everything here is pure planning;
// `src/plugins/active-sessions/handler.ts` executes a plan (deep link,
// terminal, PR comment, clipboard).
//
// What each client supports:
//   Copilot app      ghapp://sessions/<id> opens the session; a prompt starts a
//                    new session on the PR (ghapp://session/new?repo&pr&prompt).
//   Copilot CLI      `copilot --resume <id>` in a terminal, `-i <prompt>` to
//                    continue with a prompt.
//   Copilot cloud    ghapp://github.com/<owner>/<repo>/tasks/<id>; a prompt is a
//                    PR comment mentioning @copilot, which the cloud agent picks up.
//   Claude Code CLI  `claude --resume <id> [prompt]` in a terminal.
//   Claude desktop   No per-session link exists; claude://code/new?folder&q opens
//                    a new Claude Code session in the same folder with the prompt
//                    prefilled (the user presses Enter).

import type { ActiveSessionEntry, AgentActionKind, PrReadiness } from '../plugins/types';

export type { AgentActionKind };

export const AGENT_ACTION_KINDS: readonly AgentActionKind[] = ['open', 'fix_checks', 'resolve_conflicts'];

export type AgentActionPlan =
  | { kind: 'deep-link'; url: string; description: string; prompt: string | null; copyPrompt: boolean }
  | { kind: 'terminal'; file: string; args: string[]; cwd: string | null; description: string; prompt: string | null }
  | { kind: 'pr-comment'; repoFullName: string; prNumber: number; body: string; description: string; prompt: string }
  | { kind: 'unsupported'; description: string; prompt: string | null };

/** Deep-link schemes the handler is allowed to open. */
export const AGENT_DEEP_LINK_SCHEMES = ['ghapp:', 'claude:', 'claude-cli:'];

const MAX_PROMPT_CHARS = 4000;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS);
}

/** Why a prompt action is not available right now, or null when it is. */
export function actionUnavailableReason(kind: AgentActionKind, pr: PrReadiness | null): string | null {
  if (kind === 'open') return null;
  if (!pr) return 'No pull request linked yet.';
  if (pr.state !== 'OPEN') return `The PR is ${pr.state.toLowerCase()}.`;
  if (kind === 'fix_checks') {
    if (pr.checks.pending > 0) return 'Checks are still running.';
    if (pr.checks.failed === 0) return 'No failing checks.';
    return null;
  }
  if (pr.mergeable !== 'CONFLICTING') return 'No merge conflicts.';
  return null;
}

/** Follow-up prompt for the agent; null when the action does not apply. */
export function buildAgentPrompt(kind: AgentActionKind, entry: ActiveSessionEntry): string | null {
  const pr = entry.pr;
  if (kind === 'open' || !pr || actionUnavailableReason(kind, pr)) return null;
  const ref = `${pr.repoFullName}#${pr.prNumber}`;
  if (kind === 'fix_checks') {
    const names = pr.checks.failedNames?.length ? pr.checks.failedNames.join(', ') : 'see the PR checks';
    return oneLine(`The pull request ${pr.url} (${ref}, branch \`${pr.headRef}\`) has finished its checks and ${pr.checks.failed} of ${pr.checks.total} failed: ${names}. Look at the failing logs (\`gh pr checks ${pr.prNumber} --repo ${pr.repoFullName}\` lists the runs, \`gh run view <run-id> --repo ${pr.repoFullName} --log-failed\` shows the failing steps), find the root cause, fix it on this branch, run the relevant tests locally, then commit and push the fix to \`${pr.headRef}\`.`);
  }
  const base = pr.baseRef ?? 'the base branch';
  return oneLine(`The pull request ${pr.url} (${ref}) has merge conflicts with its base branch \`${base}\`. Fetch origin, merge \`origin/${base}\` into \`${pr.headRef}\` (rebase only if that is this repository's convention), resolve every conflict keeping the intent of both sides, make sure the build and the tests pass, then push \`${pr.headRef}\` so the PR becomes mergeable again.`);
}

function isCopilotApp(entry: ActiveSessionEntry): boolean {
  return entry.session.client.startsWith('Copilot app');
}

function unsupported(description: string, prompt: string | null): AgentActionPlan {
  return { kind: 'unsupported', description, prompt };
}

/**
 * How to surface the session (and, with a prompt, continue it). Pure; the
 * caller executes the returned plan.
 */
export function planAgentAction(kind: AgentActionKind, entry: ActiveSessionEntry): AgentActionPlan {
  const { session, pr } = entry;
  const prompt = buildAgentPrompt(kind, entry);
  if (kind !== 'open' && !prompt) {
    return unsupported(actionUnavailableReason(kind, pr) ?? 'Action not available.', null);
  }

  // ── Copilot cloud agent ────────────────────────────────────────────────────
  if (session.origin === 'cloud') {
    if (prompt && pr) {
      return {
        kind: 'pr-comment',
        repoFullName: pr.repoFullName,
        prNumber: pr.prNumber,
        body: `@copilot ${prompt}`,
        description: `Comment on ${pr.repoFullName}#${pr.prNumber} asking @copilot to continue`,
        prompt,
      };
    }
    if (session.repoFullName && session.cloudTaskId) {
      return {
        kind: 'deep-link',
        url: `ghapp://github.com/${session.repoFullName}/tasks/${encodeURIComponent(session.cloudTaskId)}`,
        description: 'Open the task in the GitHub Copilot app',
        prompt: null,
        copyPrompt: false,
      };
    }
    if (pr) return { kind: 'deep-link', url: pr.url, description: 'Open the pull request on GitHub', prompt: null, copyPrompt: false };
    return unsupported('This cloud task has no repository or PR to open.', null);
  }

  // ── Copilot app ────────────────────────────────────────────────────────────
  if (session.provider === 'copilot' && isCopilotApp(entry)) {
    if (prompt) {
      const repo = pr?.repoFullName ?? session.repoFullName;
      if (repo) {
        const params = new URLSearchParams({ repo, mode: 'interactive', prompt });
        if (pr) params.set('pr', String(pr.prNumber));
        return {
          kind: 'deep-link',
          url: `ghapp://session/new?${params.toString()}`,
          description: `Start a new Copilot app session on ${repo}${pr ? `#${pr.prNumber}` : ''} with the prompt`,
          prompt,
          copyPrompt: false,
        };
      }
      return {
        kind: 'deep-link',
        url: `ghapp://sessions/${encodeURIComponent(session.sessionId)}`,
        description: 'Open the session in the Copilot app — the prompt is on your clipboard, paste it there',
        prompt,
        copyPrompt: true,
      };
    }
    return {
      kind: 'deep-link',
      url: `ghapp://sessions/${encodeURIComponent(session.sessionId)}`,
      description: 'Open the session in the GitHub Copilot app',
      prompt: null,
      copyPrompt: false,
    };
  }

  // ── Copilot CLI ────────────────────────────────────────────────────────────
  if (session.provider === 'copilot') {
    const args = ['--resume', session.sessionId];
    if (prompt) args.push('-i', prompt);
    return {
      kind: 'terminal',
      file: 'copilot',
      args,
      cwd: session.cwd,
      description: prompt ? 'Resume the Copilot CLI session in a terminal with the prompt' : 'Resume the Copilot CLI session in a terminal',
      prompt,
    };
  }

  // ── Claude Code (desktop app) ──────────────────────────────────────────────
  if (session.entrypoint === 'claude-desktop') {
    if (!session.cwd) return unsupported('Claude Desktop has no link to an existing session and this one has no folder.', prompt);
    const params = new URLSearchParams({ folder: session.cwd });
    if (prompt) params.set('q', prompt);
    return {
      kind: 'deep-link',
      url: `claude://code/new?${params.toString()}`,
      description: prompt
        ? 'Claude Desktop cannot resume a session by link — opens a new Claude Code session in the same folder with the prompt prefilled'
        : 'Claude Desktop cannot bring a session forward by link — opens a new Claude Code session in the same folder',
      prompt,
      copyPrompt: false,
    };
  }

  // ── Claude Code (terminal) ─────────────────────────────────────────────────
  const args = ['--resume', session.sessionId];
  if (prompt) args.push(prompt);
  return {
    kind: 'terminal',
    file: 'claude',
    args,
    cwd: session.cwd,
    description: prompt ? 'Resume the Claude Code session in a terminal with the prompt' : 'Resume the Claude Code session in a terminal',
    prompt,
  };
}

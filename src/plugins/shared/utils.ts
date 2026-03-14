// ── Shared renderer utility helpers ──────────────────────────────────────────

/** Returns a human-readable relative time label (e.g. "3h ago", "2d ago"). */
export function relativeAge(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/** Returns a short description of a notification reason/type combination. */
export function notifDescription(type: string, reason: string): string {
  if (reason === 'assign') return type === 'PullRequest' ? 'PR assigned to you' : 'Issue assigned to you';
  if (reason === 'review_requested') return 'PR review requested';
  if (reason === 'mention') return `@mentioned in ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'team_mention') return `Team @mentioned in ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'author') return `Your ${type === 'PullRequest' ? 'PR' : type.toLowerCase()} has activity`;
  if (reason === 'comment') return `Comment on ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'subscribed') return `Watched ${type === 'PullRequest' ? 'PR' : type.toLowerCase()} updated`;
  if (reason === 'state_change') return `${type === 'PullRequest' ? 'PR' : type} state changed`;
  if (reason === 'ci_activity') return 'CI activity';
  if (reason === 'security_alert') return '\u26A0\uFE0F Security alert';
  return `${type} \u2014 ${reason}`;
}

/** Returns true if the notification reason involves the user directly. */
export function isDirect(reason: string): boolean {
  return ['assign', 'review_requested', 'mention', 'team_mention', 'author', 'security_alert'].includes(reason);
}

/** Lightweight Markdown → HTML renderer (no external dependency). */
export function renderChatMarkdown(text: string): string {
  let out = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_: string, code: string) =>
    `<pre class="ec-code-block"><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`,
  );
  out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<span class="ec-inline-code">$1</span>');
  out = out.replace(/^###\s+(.+)$/gm, '<h5 class="ec-heading">$1</h5>');
  out = out.replace(/^##\s+(.+)$/gm, '<h4 class="ec-heading">$1</h4>');
  out = out.replace(/^#\s+(.+)$/gm, '<h3 class="ec-heading">$1</h3>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

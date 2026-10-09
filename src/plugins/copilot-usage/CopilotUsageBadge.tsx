import { useCallback, useLayoutEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { CopilotUsage, GitHubAccountUsage } from '../types';
import { formatNumber, formatDurationUntil } from '../shared/utils';
import { copilotBudgetLevel, copilotUsageLimit, type CopilotBudgetLevel } from './budget-level';
import { CopilotIcon } from '../shared/BrandIcons';

const LEVEL_COLOR: Record<CopilotBudgetLevel, string> = {
  unknown: '#888',
  available: '#4caf50',
  warning: '#ff9800',
  limited: '#f44336',
};

const credits = (n: number) => formatNumber(Math.round(n));

const SOURCE_LABEL: Record<NonNullable<CopilotUsage['source']>, string> = {
  'gh-cli': 'GitHub CLI',
  oauth: 'GitHub OAuth',
  pat: 'PAT',
};

interface CopilotUsageBadgeProps {
  usage: CopilotUsage;
  /** Usage of the other tracked accounts, stacked below the primary one in the flyout. */
  otherAccounts?: GitHubAccountUsage[];
  /** Opens the Settings window, where GitHub sign-in / re-authorization lives. */
  onOpenSettings?: () => void;
  /** Re-runs the usage check. */
  onRefresh?: () => void;
}

function AccountHeader({ login, host, level }: { login?: string; host?: string; level: CopilotBudgetLevel }) {
  return (
    <div class="bg-status-claude-account-head">
      <span class="bg-status-claude-account-dot" style={{ background: LEVEL_COLOR[level] }} />
      <span>@{login ?? 'account'}</span>
      {host && host !== 'github.com' && <span class="bg-status-claude-account-host">{host}</span>}
    </div>
  );
}

interface UsageRowsProps {
  usage: CopilotUsage;
  /** Per-model rows: only the primary block shows them, to keep the stacked flyout short. */
  showModels?: boolean;
}

function Row({ label, value, note, valueClass = '' }: { label: string; value: string; note?: string; valueClass?: string }) {
  return (
    <div class="bg-status-claude-row">
      <span class="bg-status-claude-label">{label}</span>
      <span class={`bg-status-claude-state${valueClass ? ` ${valueClass}` : ''}`}>{value}</span>
      <span class="bg-status-claude-reset">{note ?? ''}</span>
    </div>
  );
}

/** One account's usage: a headline total with a meter, the credit breakdown, and the per-model split. */
function UsageRows({ usage, showModels = true }: UsageRowsProps) {
  const level = copilotBudgetLevel(usage);
  const budget = usage.budgetCredits;
  const entitlement = usage.entitlementCredits ?? null;
  // Budget wins; otherwise the plan's included credits (quota endpoint) act as the ceiling.
  const limit = copilotUsageLimit(usage);
  const pct = limit ? Math.round((usage.creditsUsed / limit) * 100) : null;
  const monthLabel = new Date(Date.UTC(usage.year, usage.month - 1, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const models = showModels ? usage.byModel.slice(0, 6) : [];
  // When the plan covers everything so far, Included / Billed only repeat the headline.
  const showSplit = !entitlement || usage.billedCredits > 0;

  return (
    <>
      <div class="bg-copilot-hero">
        <div class="bg-copilot-hero-top">
          <span>{monthLabel}{usage.plan ? <span class="bg-copilot-plan">{usage.plan}</span> : null}</span>
          <span>{formatDurationUntil(usage.resetsAt)}</span>
        </div>
        {usage.error ? (
          <div class="bg-copilot-hero-value bg-status-claude-state--unknown">No data</div>
        ) : (
          <div class={`bg-copilot-hero-value bg-status-claude-state--${level}`}>
            {credits(usage.creditsUsed)}
            <span class="bg-copilot-hero-unit">{limit ? ` / ${credits(limit)} AIC` : ' AIC'}</span>
            {pct !== null && <span class="bg-copilot-hero-pct">{pct}%</span>}
          </div>
        )}
        {!usage.error && limit !== null && (
          <div class="bg-copilot-meter">
            <span style={{ width: `${Math.min(100, pct ?? 0)}%`, background: LEVEL_COLOR[level] }} />
          </div>
        )}
      </div>
      {!usage.error && (
        <div class="bg-copilot-section">
          {limit !== null && (
            <Row
              label="Remaining"
              value={`${credits(Math.max(0, limit - usage.creditsUsed))} AIC`}
              note={budget ? 'of your budget' : undefined}
            />
          )}
          {showSplit && (
            <>
              <Row label="Included" value={`${credits(usage.includedCreditsUsed)} AIC`} note="covered by the plan" />
              <Row label="Billed" value={`${credits(usage.billedCredits)} AIC`} note={`$${usage.billedAmountUsd.toFixed(2)} overage`} />
            </>
          )}
          {usage.projectedCredits !== null && (
            <Row
              label="Projected"
              value={`${credits(usage.projectedCredits)} AIC`}
              valueClass={limit && usage.projectedCredits > limit ? 'bg-status-claude-state--warning' : ''}
              note={limit
                ? `${Math.round((usage.projectedCredits / limit) * 100)}% of ${budget ? 'budget' : 'plan'}`
                : 'at current pace'}
            />
          )}
          {/* With a detected plan entitlement and no budget of our own, the Budget row is just noise. */}
          {(budget || !entitlement) && (
            <Row
              label="Budget"
              value={budget ? `${credits(budget)} AIC` : 'Not set'}
              note={budget ? `$${(budget * 0.01).toFixed(2)} / month` : 'set it in Settings'}
            />
          )}
        </div>
      )}
      {models.length > 0 && (
        <div class="bg-copilot-section">
          <div class="bg-copilot-section-title">By model</div>
          {models.map((m) => {
            const share = usage.creditsUsed > 0 ? Math.round((m.credits / usage.creditsUsed) * 100) : 0;
            return (
              <div class="bg-copilot-model" key={m.model} title={m.model}>
                <span class="bg-copilot-model-name">{m.model}</span>
                <span class="bg-copilot-model-credits">{credits(m.credits)} AIC</span>
                <span class="bg-copilot-model-pct">{share}%</span>
                <span class="bg-copilot-model-bar"><span style={{ width: `${share}%` }} /></span>
              </div>
            );
          })}
        </div>
      )}
      {usage.error && (
        <div class="bg-status-claude-error">
          Check failed: {usage.error}
        </div>
      )}
    </>
  );
}

/** Full-window view of the raw GitHub API answers behind each account's usage. */
function RawResponsesDialog({ accounts, onClose }: { accounts: Array<{ login: string; usage: CopilotUsage }>; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  // Layout effect: the Esc listener must be live as soon as the dialog shows, not after the next paint.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return createPortal(
    <div class="bg-copilot-raw-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="bg-copilot-raw" role="dialog" aria-label="Copilot usage raw responses">
        <div class="bg-copilot-raw-head">
          <strong>Copilot usage: raw API responses</strong>
          <button type="button" class="bg-status-claude-action" onClick={onClose}>Close</button>
        </div>
        <div class="bg-copilot-raw-body">
          {accounts.map(({ login, usage }) => (
            <section key={login}>
              <h3>@{login} <span>fetched {new Date(usage.fetchedAt).toLocaleTimeString()}</span></h3>
              {(usage.rawResponses ?? []).length === 0 && (
                <p class="bg-copilot-raw-empty">No API response recorded for this check.</p>
              )}
              {(usage.rawResponses ?? []).map((r, i) => {
                const key = `${login}:${i}`;
                const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
                return (
                  <div class="bg-copilot-raw-entry" key={key}>
                    <div class="bg-copilot-raw-entry-head">
                      <code>GET {r.endpoint}</code>
                      <span class={r.status >= 200 && r.status < 300 ? 'bg-status-claude-state--available' : 'bg-status-claude-state--warning'}>
                        {r.status || 'no response'}
                      </span>
                      <button type="button" class="bg-status-claude-action" onClick={() => copy(key, text)}>
                        {copied === key ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <pre>{text}</pre>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const LEVEL_RANK: Record<CopilotBudgetLevel, number> = { unknown: 0, available: 1, warning: 2, limited: 3 };

/** Status-bar badge with a hover popup showing Copilot AI credit usage vs the monthly budget / plan entitlement. */
export function CopilotUsageBadge({ usage, otherAccounts = [], onOpenSettings, onRefresh }: CopilotUsageBadgeProps) {
  const limit = copilotUsageLimit(usage);
  const primaryLogin = usage.login?.toLowerCase();
  const configuredOthers = otherAccounts.filter(
    (a) => a.usage.configured && a.account.login.toLowerCase() !== primaryLogin,
  );

  // The badge turns as alarming as the worst account, so a nearly-spent second account is not hidden.
  const level = [usage, ...configuredOthers.map((a) => a.usage)]
    .map(copilotBudgetLevel)
    .reduce((worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst), copilotBudgetLevel(usage));

  const label = (usage.error
    ? 'Copilot –'
    : limit
      ? `Copilot ${credits(usage.creditsUsed)}/${credits(limit)} AIC`
      : `Copilot ${credits(usage.creditsUsed)} AIC`) + (configuredOthers.length > 0 ? ` +${configuredOthers.length}` : '');

  const stacked = configuredOthers.length > 0;
  const [showRaw, setShowRaw] = useState(false);
  const closeRaw = useCallback(() => setShowRaw(false), []);
  const rawAccounts = [
    { login: usage.login ?? 'account', usage },
    ...configuredOthers.map((a) => ({ login: a.account.login, usage: a.usage })),
  ];

  return (
    <span class="bg-status-claude bg-status-copilot">
      <span class="bg-status-rate-limit" style={{ color: LEVEL_COLOR[level] }}>
        <CopilotIcon size={13} class="bg-status-brand-icon" />
        {label}
      </span>
      <div class="bg-status-claude-pop">
        {stacked && <AccountHeader login={usage.login} host={undefined} level={copilotBudgetLevel(usage)} />}
        <UsageRows usage={usage} />
        {configuredOthers.map(({ account, usage: other }) => (
          <div class="bg-status-claude-account" key={account.id}>
            <AccountHeader login={account.login} host={account.host} level={copilotBudgetLevel(other)} />
            <UsageRows usage={other} showModels={false} />
          </div>
        ))}
        {(usage.error || !usage.configured) && (onOpenSettings || onRefresh) && (
          <div class="bg-status-claude-actions">
            {onOpenSettings && (
              <button type="button" class="bg-status-claude-action" onClick={onOpenSettings}>
                {usage.configured && usage.oauthHasUserScope === false
                  ? 'Re-authorize in Settings'
                  : !usage.configured || (usage.missingScope && usage.oauthHasUserScope === undefined)
                    ? 'Sign in to GitHub in Settings'
                    : 'Open Settings'}
              </button>
            )}
            {onRefresh && (
              <button type="button" class="bg-status-claude-action" onClick={onRefresh}>Check again</button>
            )}
          </div>
        )}
        <div class="bg-status-claude-checked bg-copilot-footer">
          <span>
            Last checked {new Date(usage.fetchedAt).toLocaleTimeString()}
            {usage.source ? ` via ${SOURCE_LABEL[usage.source]}` : ''}
          </span>
          {usage.configured && (
            <button type="button" class="bg-status-claude-action" onClick={(e) => { e.currentTarget.blur(); setShowRaw(true); }} title="Show the raw JSON GitHub returned">
              Raw JSON
            </button>
          )}
        </div>
      </div>
      {showRaw && <RawResponsesDialog accounts={rawAccounts} onClose={closeRaw} />}
    </span>
  );
}

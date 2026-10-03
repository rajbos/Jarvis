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

/** The month / budget / included / projected rows for one account. */
function UsageRows({ usage, showModels = true }: UsageRowsProps) {
  const level = copilotBudgetLevel(usage);
  const budget = usage.budgetCredits;
  const entitlement = usage.entitlementCredits ?? null;
  // Budget wins; otherwise the plan's included credits (quota endpoint) act as the ceiling.
  const limit = copilotUsageLimit(usage);
  const pct = limit ? Math.round((usage.creditsUsed / limit) * 100) : null;
  const monthLabel = new Date(Date.UTC(usage.year, usage.month - 1, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <>
      <div class="bg-status-claude-row">
        <span class="bg-status-claude-label">{monthLabel}</span>
        {usage.error ? (
          <span class="bg-status-claude-state bg-status-claude-state--unknown">No data</span>
        ) : (
          <span class={`bg-status-claude-state bg-status-claude-state--${level}`}>
            {credits(usage.creditsUsed)}{limit ? ` / ${credits(limit)}` : ''} AIC{pct !== null ? ` · ${pct}%` : ''}
          </span>
        )}
        <span class="bg-status-claude-reset">
          {formatDurationUntil(usage.resetsAt)} · {new Date(usage.resetsAt * 1000).toLocaleDateString()}
        </span>
      </div>
      {!usage.error && (
        <>
          {/* With a detected plan entitlement and no budget of our own, the Budget row is just noise. */}
          {(budget || !entitlement) && (
            <div class="bg-status-claude-row">
              <span class="bg-status-claude-label">Budget</span>
              <span class="bg-status-claude-state">
                {budget ? `${credits(Math.max(0, budget - usage.creditsUsed))} AIC left` : 'Not set'}
              </span>
              <span class="bg-status-claude-reset">
                {budget ? `$${(budget * 0.01).toFixed(2)} / month` : 'Set it in Settings'}
              </span>
            </div>
          )}
          <div class="bg-status-claude-row">
            <span class="bg-status-claude-label">Included</span>
            <span class="bg-status-claude-state">
              {credits(usage.includedCreditsUsed)}{entitlement ? ` / ${credits(entitlement)}` : ''} AIC
            </span>
            <span class="bg-status-claude-reset">
              {entitlement
                ? `${credits(Math.max(0, entitlement - usage.creditsUsed))} left on ${usage.plan ?? 'plan'}`
                : `billed ${credits(usage.billedCredits)} AIC · $${usage.billedAmountUsd.toFixed(2)}`}
            </span>
          </div>
          {usage.projectedCredits !== null && (
            <div class="bg-status-claude-row">
              <span class="bg-status-claude-label">Projected</span>
              <span class={`bg-status-claude-state${budget && usage.projectedCredits > budget ? ' bg-status-claude-state--warning' : ''}`}>
                {credits(usage.projectedCredits)} AIC
              </span>
              <span class="bg-status-claude-reset">by month end at current pace</span>
            </div>
          )}
          {showModels && usage.byModel.slice(0, 4).map((m) => (
            <div class="bg-status-claude-row" key={m.model}>
              <span class="bg-status-claude-label">{m.model}</span>
              <span class="bg-status-claude-state">{credits(m.credits)} AIC</span>
              <span class="bg-status-claude-reset">
                {usage.creditsUsed > 0 ? `${Math.round((m.credits / usage.creditsUsed) * 100)}%` : ''}
              </span>
            </div>
          ))}
        </>
      )}
      {usage.error && (
        <div class="bg-status-claude-error">
          Check failed: {usage.error}
        </div>
      )}
    </>
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
        <div class="bg-status-claude-checked">
          Last checked {new Date(usage.fetchedAt).toLocaleTimeString()}
          {usage.source ? ` via ${SOURCE_LABEL[usage.source]}` : ''}
        </div>
      </div>
    </span>
  );
}

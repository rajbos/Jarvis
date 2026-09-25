import type { CopilotUsage } from '../types';
import { formatNumber, formatDurationUntil } from '../shared/utils';
import { copilotBudgetLevel, type CopilotBudgetLevel } from './budget-level';

const LEVEL_COLOR: Record<CopilotBudgetLevel, string> = {
  unknown: '#888',
  available: '#4caf50',
  warning: '#ff9800',
  limited: '#f44336',
};

const credits = (n: number) => formatNumber(Math.round(n));

/** Status-bar badge with a hover popup showing Copilot AI credit usage vs the monthly budget. */
export function CopilotUsageBadge({ usage }: { usage: CopilotUsage }) {
  const level = copilotBudgetLevel(usage);
  const budget = usage.budgetCredits;
  const pct = budget ? Math.round((usage.creditsUsed / budget) * 100) : null;
  const monthLabel = new Date(Date.UTC(usage.year, usage.month - 1, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const label = usage.error
    ? '◈ Copilot –'
    : budget
      ? `◈ Copilot ${credits(usage.creditsUsed)}/${credits(budget)} AIC`
      : `◈ Copilot ${credits(usage.creditsUsed)} AIC`;

  return (
    <span class="bg-status-claude bg-status-copilot">
      <span class="bg-status-rate-limit" style={{ color: LEVEL_COLOR[level] }}>{label}</span>
      <div class="bg-status-claude-pop">
        <div class="bg-status-claude-row">
          <span class="bg-status-claude-label">{monthLabel}</span>
          {usage.error ? (
            <span class="bg-status-claude-state bg-status-claude-state--unknown">No data</span>
          ) : (
            <span class={`bg-status-claude-state bg-status-claude-state--${level}`}>
              {credits(usage.creditsUsed)}{budget ? ` / ${credits(budget)}` : ''} AIC{pct !== null ? ` · ${pct}%` : ''}
            </span>
          )}
          <span class="bg-status-claude-reset">
            {formatDurationUntil(usage.resetsAt)} · {new Date(usage.resetsAt * 1000).toLocaleDateString()}
          </span>
        </div>
        {!usage.error && (
          <>
            <div class="bg-status-claude-row">
              <span class="bg-status-claude-label">Budget</span>
              <span class="bg-status-claude-state">
                {budget ? `${credits(Math.max(0, budget - usage.creditsUsed))} AIC left` : 'Not set'}
              </span>
              <span class="bg-status-claude-reset">
                {budget ? `$${(budget * 0.01).toFixed(2)} / month` : 'Set it in Settings'}
              </span>
            </div>
            <div class="bg-status-claude-row">
              <span class="bg-status-claude-label">Included</span>
              <span class="bg-status-claude-state">{credits(usage.includedCreditsUsed)} AIC</span>
              <span class="bg-status-claude-reset">
                billed {credits(usage.billedCredits)} AIC · ${usage.billedAmountUsd.toFixed(2)}
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
            {usage.byModel.slice(0, 4).map((m) => (
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
        <div class="bg-status-claude-checked">
          Last checked {new Date(usage.fetchedAt).toLocaleTimeString()}
          {usage.source ? ` via ${usage.source === 'oauth' ? 'GitHub OAuth' : 'PAT'}` : ''}
        </div>
      </div>
    </span>
  );
}

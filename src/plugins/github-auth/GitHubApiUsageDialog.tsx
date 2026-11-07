/**
 * One dialog for the whole GitHub API picture: what is left of each token's
 * quota (OAuth and PAT side by side, as in the status bar) and what Jarvis
 * itself has been asking for — calls per credential over time, per feature,
 * and the busiest URL shapes — so a draining budget can be traced to the
 * feature and the token behind it.
 */
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { GitHubRateLimit, GitHubRateLimitSource } from '../types';
import { formatDurationUntil, formatNumber } from '../shared/utils';
import { Sparkline, useUsageHistory } from '../shared/Sparkline';
import { UsageHistoryDialog } from '../shared/UsageHistoryDialog';
import { formatSince, purposeRows, tokenColumns, tokenLabel } from './api-usage';

const HOUR = 60 * 60 * 1000;
const BUCKET_LABEL: Record<string, string> = { core: 'REST', graphql: 'GraphQL', search: 'Search' };
const BUCKET_COLOR: Record<string, string> = { core: '#64b5f6', graphql: '#ce93d8', search: '#ffb74d' };
const TOKEN_COLOR: Record<string, string> = { oauth: '#64b5f6', pat: '#ffb74d', other: '#9e9e9e', none: '#616161' };
const RATE_LIMIT_SERIES = [
  { key: 'core', label: 'REST', color: BUCKET_COLOR.core },
  { key: 'graphql', label: 'GraphQL', color: BUCKET_COLOR.graphql },
  { key: 'search', label: 'Search', color: BUCKET_COLOR.search, hidden: true },
] as const;

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function tokenColor(token: string): string {
  return TOKEN_COLOR[token] ?? '#81c784';
}

function TokenColumn({ label, metric, source, calls, onHistory }: {
  label: 'OAuth' | 'PAT';
  metric: 'github-oauth' | 'github-pat';
  source: GitHubRateLimitSource;
  calls: number | null;
  onHistory: () => void;
}) {
  const trend = useUsageHistory(metric, () => 48 * HOUR);
  const now = Date.now();
  const buckets = ['core', 'graphql', 'search']
    .map((name) => [name, source.resources?.[name] ?? (name === 'core' ? source.resource : null)] as const)
    .filter((entry): entry is readonly [string, NonNullable<typeof entry[1]>] => entry[1] != null);

  return (
    <div class="bg-apiu-token">
      <div class="bg-apiu-token-head">
        <strong>{label}</strong>
        {source.configured ? (
          <button type="button" class="bg-status-claude-action" onClick={onHistory}>30-day history</button>
        ) : (
          <span class="bg-apiu-muted">not configured</span>
        )}
      </div>
      {source.configured && source.tokenExpired && <div class="bg-status-claude-error">Token expired or revoked.</div>}
      {source.configured && !source.tokenExpired && source.error && <div class="bg-status-claude-error">Check failed: {source.error}</div>}
      {buckets.map(([name, r]) => (
        <div key={name} class="bg-apiu-bucket">
          <div class="bg-status-claude-row">
            <span class="bg-status-claude-label">{BUCKET_LABEL[name]}</span>
            <span class={`bg-status-claude-state ${r.remaining === 0 ? 'bg-status-claude-state--limited' : r.remaining / r.limit < 0.2 ? 'bg-status-claude-state--warning' : 'bg-status-claude-state--available'}`}>
              {formatNumber(r.remaining)} / {formatNumber(r.limit)}
            </span>
            <span class="bg-status-claude-reset">{formatDurationUntil(r.reset, now)} · {clock(r.reset)}</span>
          </div>
          <Sparkline history={trend} series={name} color={BUCKET_COLOR[name]} mode="remaining" caption="48h" title={`${BUCKET_LABEL[name]} % remaining, last 48 hours`} />
        </div>
      ))}
      {source.configured && (
        <div class="bg-apiu-token-calls">
          Calls by Jarvis with this token: <strong>{calls === null ? '–' : formatNumber(calls)}</strong>
        </div>
      )}
    </div>
  );
}

interface Props {
  rateLimit: GitHubRateLimit;
  onClose: () => void;
}

export function GitHubApiUsageDialog({ rateLimit, onClose }: Props) {
  const [history, setHistory] = useState<'oauth' | 'pat' | null>(null);
  const callHistory = useUsageHistory('github-api-calls', () => 24 * HOUR);
  const stats = rateLimit.apiCalls ?? null;
  const now = Date.now();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (history) setHistory(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, history]);

  const tokens = stats?.byToken ?? [];
  const callsFor = (token: string): number | null => (stats ? tokens.find((t) => t.token === token)?.count ?? 0 : null);
  const columns = tokenColumns(stats);
  const rows = stats ? purposeRows(stats) : [];
  const patterns = stats ? stats.byPattern.slice(0, 15) : [];

  return createPortal(
    <div class="bg-copilot-raw-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="bg-copilot-raw bg-apiu" role="dialog" aria-label="GitHub API usage">
        <div class="bg-copilot-raw-head">
          <strong>GitHub API usage</strong>
          <button type="button" class="bg-status-claude-action" onClick={onClose}>Close</button>
        </div>
        <div class="bg-copilot-raw-body">
          <h3>Quota left per token <span>· checked {new Date(rateLimit.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></h3>
          <div class="bg-apiu-tokens">
            <TokenColumn label="OAuth" metric="github-oauth" source={rateLimit.oauth} calls={callsFor('oauth')} onHistory={() => setHistory('oauth')} />
            <TokenColumn label="PAT" metric="github-pat" source={rateLimit.pat} calls={callsFor('pat')} onHistory={() => setHistory('pat')} />
          </div>

          <h3>
            Calls made by Jarvis
            {stats && <span> · {formatNumber(stats.total)} in the last {formatSince(stats.since, now)} (since the app started)</span>}
          </h3>
          {!stats || stats.total === 0 ? (
            <div class="bg-copilot-raw-empty">No calls recorded yet in this run.</div>
          ) : (
            <>
              <div class="bg-apiu-sparks">
                {columns.map((token) => (
                  <div key={token} class="bg-apiu-spark">
                    <span class="bg-apiu-spark-label"><i style={{ background: tokenColor(token) }} />{tokenLabel(token)} <strong>{formatNumber(callsFor(token) ?? 0)}</strong></span>
                    <Sparkline history={callHistory} series={token} color={tokenColor(token)} mode="used" caption="24h" title={`Calls per 10-minute window with the ${tokenLabel(token)} token, last 24 hours`} />
                  </div>
                ))}
              </div>

              <table class="bg-rlh-table bg-apiu-table">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th class="bg-apiu-num">Calls</th>
                    {columns.map((t) => <th key={t} class="bg-apiu-num">{tokenLabel(t)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.purpose}>
                      <td class="bg-apiu-mono">{row.purpose}</td>
                      <td class="bg-apiu-num">{formatNumber(row.total)}</td>
                      {columns.map((t) => <td key={t} class="bg-apiu-num">{row.byToken[t] ? formatNumber(row.byToken[t]) : '·'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3>Busiest requests</h3>
              <table class="bg-rlh-table bg-apiu-table">
                <thead>
                  <tr><th class="bg-apiu-num">Calls</th><th>Request</th><th>Feature</th><th>Token</th><th>Last</th></tr>
                </thead>
                <tbody>
                  {patterns.map((p) => (
                    <tr key={`${p.purpose}|${p.token}|${p.method}|${p.pattern}`}>
                      <td class="bg-apiu-num">{formatNumber(p.count)}</td>
                      <td class="bg-apiu-mono" title={p.lastUrl}>{p.method} {p.pattern}</td>
                      <td class="bg-apiu-mono">{p.purpose}</td>
                      <td>{tokenLabel(p.token)}</td>
                      <td class="bg-apiu-mono bg-apiu-url" title={p.lastUrl}>{p.lastUrl.replace(/^https:\/\/api\.github\.com/, '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div class="bg-status-claude-checked bg-rlh-foot">
            Counts restart with the app; calls per token are stored every 10 minutes and kept for 30 days.
            GraphQL and search have their own quotas, so a REST drain and a GraphQL drain are different features.
          </div>
        </div>
      </div>
      {history && (
        <UsageHistoryDialog
          title={`${history === 'oauth' ? 'OAuth' : 'PAT'} rate-limit history`}
          metric={history === 'oauth' ? 'github-oauth' : 'github-pat'}
          series={RATE_LIMIT_SERIES}
          mode="remaining"
          footnote="sampled every 2 minutes while Jarvis runs"
          onClose={() => setHistory(null)}
        />
      )}
    </div>,
    document.body,
  );
}

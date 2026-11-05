import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Sparkline, useUsageHistory } from '../shared/Sparkline';
import type { GitHubRateLimitSource } from '../types';
import { formatNumber, formatDurationUntil } from '../shared/utils';
import { CHART_BUCKETS, rateLimitSeries, tightestBucket, type ChartBucket } from './rate-limit-chart';
import { UsageHistoryDialog, historyTriggerProps } from '../shared/UsageHistoryDialog';

const CHART_W = 320;
const CHART_H = 72;

const BUCKET_LABEL: Record<string, string> = { core: 'REST', graphql: 'GraphQL', search: 'Search' };
const BUCKET_COLOR: Record<ChartBucket, string> = { core: '#64b5f6', graphql: '#ce93d8' };

const SPARK_COLOR: Record<string, string> = { core: '#64b5f6', graphql: '#ce93d8', search: '#ffb74d' };
const TREND_RANGE = () => 48 * 60 * 60 * 1000;

const HISTORY_SERIES = [
  { key: 'core', label: 'REST', color: BUCKET_COLOR.core },
  { key: 'graphql', label: 'GraphQL', color: BUCKET_COLOR.graphql },
  // Search's 30-per-minute quota swings constantly and would drown the others.
  { key: 'search', label: 'Search', color: '#ffb74d', hidden: true },
] as const;

function rateLimitColor(remaining: number): string {
  if (remaining < 100) return '#f44336';
  if (remaining < 1000) return '#ff9800';
  return '#4caf50';
}

function stateClass(remaining: number, limit: number): string {
  if (remaining === 0) return 'bg-status-claude-state--limited';
  if (remaining / limit < 0.2) return 'bg-status-claude-state--warning';
  return 'bg-status-claude-state--available';
}

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface Props {
  label: 'OAuth' | 'PAT';
  source: GitHubRateLimitSource;
}

/**
 * Status-bar rate-limit badge with a hover popover charting the last 2 hours.
 * Clicking it opens the stored history, zoomable out to 30 days.
 */
export function GitHubRateLimitBadge({ label, source }: Props) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const trend = useUsageHistory(label === 'OAuth' ? 'github-oauth' : 'github-pat', TREND_RANGE);
  const tight = tightestBucket(source);
  const now = Date.now();
  const history = source.history ?? [];

  let text: string;
  let color: string;
  if (source.tokenExpired) {
    text = `⚡ ${label} expired`;
    color = '#ff6b81';
  } else if (source.error || !tight) {
    text = `⚡ ${label} –`;
    color = '#888';
  } else {
    const r = tight.resource;
    text = `⚡ ${label} ${formatNumber(r.remaining)}/${formatNumber(r.limit)}`
      + (tight.name !== 'core' ? ` ${BUCKET_LABEL[tight.name]}` : '')
      + (r.remaining < 500 ? ` · ${formatDurationUntil(r.reset)}` : '');
    color = rateLimitColor(r.remaining);
  }

  const buckets = ['core', 'graphql', 'search']
    .map((name) => [name, source.resources?.[name] ?? (name === 'core' ? source.resource : null)] as const)
    .filter((entry): entry is readonly [string, NonNullable<typeof entry[1]>] => entry[1] != null);

  const series = CHART_BUCKETS.map((b) => ({ bucket: b, points: rateLimitSeries(history, b, now, CHART_W, CHART_H) }))
    .filter((s) => s.points.length > 0);

  return (
    <span class={`bg-status-claude bg-status-ratelimit${historyOpen ? ' bg-status-claude--dialog-open' : ''}`}>
      <span
        class="bg-status-rate-limit bg-status-rate-limit--clickable"
        style={{ color }}
        {...historyTriggerProps(() => setHistoryOpen(true))}
      >
        {text}
      </span>
      <div class="bg-status-claude-pop" role="tooltip">
        <div class="bg-ratelimit-head">
          {tight ? (
            <>
              <span class="bg-ratelimit-head-title">{label} resets at {clock(tight.resource.reset)}</span>
              <span class="bg-ratelimit-head-sub">
                {formatDurationUntil(tight.resource.reset, now)} · {BUCKET_LABEL[tight.name]} quota
              </span>
            </>
          ) : (
            <span class="bg-ratelimit-head-title">{label} rate limit unavailable</span>
          )}
        </div>

        <div class="bg-ratelimit-chart">
          {series.some((s) => s.points.length > 1) ? (
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              width={CHART_W}
              height={CHART_H}
              role="img"
              aria-label={`${label} remaining rate limit over the last 2 hours`}
            >
              {[0, 0.5, 1].map((f) => (
                <line class="bg-ratelimit-grid" x1={0} x2={CHART_W} y1={f * CHART_H} y2={f * CHART_H} />
              ))}
              {series.map(({ bucket, points }) => {
                const last = points[points.length - 1];
                return (
                  <g key={bucket}>
                    <polyline
                      points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke={BUCKET_COLOR[bucket]}
                      stroke-width={2}
                      stroke-linejoin="round"
                      stroke-linecap="round"
                    />
                    <circle cx={last.x} cy={last.y} r={3} fill={BUCKET_COLOR[bucket]} />
                  </g>
                );
              })}
            </svg>
          ) : (
            <div class="bg-ratelimit-empty">Collecting data, with one sample every 2 minutes…</div>
          )}
          <div class="bg-ratelimit-axis">
            <span>−2h</span><span>−1h</span><span>now</span>
          </div>
          <div class="bg-ratelimit-legend">
            {CHART_BUCKETS.map((b) => (
              <span><i style={{ background: BUCKET_COLOR[b] }} />{BUCKET_LABEL[b]} % remaining</span>
            ))}
          </div>
        </div>

        {buckets.map(([name, r]) => (
          <Fragment key={name}>
            <div class="bg-status-claude-row">
              <span class="bg-status-claude-label">{BUCKET_LABEL[name]}</span>
              <span class={`bg-status-claude-state ${stateClass(r.remaining, r.limit)}`}>
                {formatNumber(r.remaining)} / {formatNumber(r.limit)}
              </span>
              <span class="bg-status-claude-reset">{formatDurationUntil(r.reset, now)} · {clock(r.reset)}</span>
            </div>
            <Sparkline
              history={trend}
              series={name}
              color={SPARK_COLOR[name] ?? '#64b5f6'}
              mode="remaining"
              caption="48h"
              title={`${BUCKET_LABEL[name]} % remaining, last 48 hours (lowest per time slot)`}
            />
          </Fragment>
        ))}

        {source.tokenExpired && (
          <div class="bg-status-claude-error">PAT expired or revoked. Open Settings → GitHub Access to enter a new token.</div>
        )}
        {!source.tokenExpired && source.error && (
          <div class="bg-status-claude-error">Check failed: {source.error}</div>
        )}
        <div class="bg-status-claude-checked">
          Click the badge for the full history.
          Secondary (abuse) limits have no counter and don't show here.
          {source.tokenExpiresAt ? ` Token expires ${source.tokenExpiresAt}.` : ''}
        </div>
      </div>
      {historyOpen && (
        <UsageHistoryDialog
          title={`${label} rate-limit history`}
          metric={label === 'OAuth' ? 'github-oauth' : 'github-pat'}
          series={HISTORY_SERIES}
          mode="remaining"
          footnote="sampled every 2 minutes while Jarvis runs"
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </span>
  );
}

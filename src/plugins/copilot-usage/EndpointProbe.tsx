import { useState } from 'preact/hooks';
import type { CopilotRawResponse, CopilotUsage } from '../types';
import { formatNumber } from '../shared/utils';
import { buildProbePresets, sumUsageItems, type ProbePreset } from './probe-presets';

type ProbeSource = 'gh-cli' | 'oauth' | 'pat';

const SOURCE_OPTIONS: Array<{ value: ProbeSource; label: string }> = [
  { value: 'gh-cli', label: 'GitHub CLI token' },
  { value: 'oauth', label: 'Jarvis sign-in token' },
  { value: 'pat', label: 'PAT' },
];

export interface ProbeAccount {
  login: string;
  usage: CopilotUsage;
}

interface AccountProbeState {
  source: ProbeSource;
  endpoint: string;
  running: boolean;
  error: string | null;
  results: CopilotRawResponse[];
}

/** Starts on the user report, the one report a personal token can usually read. */
function initialProbeState(usage: CopilotUsage, presets: ProbePreset[]): AccountProbeState {
  const preferred = presets[1] ?? presets[0];
  return { source: usage.source ?? 'gh-cli', endpoint: preferred?.endpoint ?? '', running: false, error: null, results: [] };
}

/** One raw API answer: request line, status, copy button and the pretty-printed body. */
export function RawEntry({ response, quotaCredits }: { response: CopilotRawResponse; quotaCredits?: number }) {
  const [copied, setCopied] = useState(false);
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body, null, 2);
  const itemsTotal = sumUsageItems(response.body);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div class="bg-copilot-raw-entry">
      <div class="bg-copilot-raw-entry-head">
        <code>GET {response.endpoint}</code>
        <span class={response.status >= 200 && response.status < 300 ? 'bg-status-claude-state--available' : 'bg-status-claude-state--warning'}>
          {response.status || 'no response'}
        </span>
        <button type="button" class="bg-status-claude-action" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {itemsTotal !== null && (
        <div class="bg-copilot-raw-sum">
          Σ usageItems grossQuantity: <strong>{formatNumber(itemsTotal)} AIC</strong>
          {quotaCredits !== undefined && quotaCredits > 0 && itemsTotal > 0 && (
            <> · seat quota says {formatNumber(Math.round(quotaCredits))} AIC ({(quotaCredits / itemsTotal).toFixed(1)}×)</>
          )}
        </div>
      )}
      <pre>{text}</pre>
    </div>
  );
}

/**
 * Lets the user run the other usage endpoints (org / enterprise reports, a single day) as this
 * account, to see which one accounts for the credits the seat quota reports.
 */
export function EndpointProbe({ accounts }: { accounts: ProbeAccount[] }) {
  const [selected, setSelected] = useState(accounts[0]?.login ?? '');
  const [states, setStates] = useState<Record<string, AccountProbeState>>({});

  const account = accounts.find((a) => a.login === selected) ?? accounts[0];
  if (!account) return <p class="bg-copilot-raw-empty">No account to try endpoints with.</p>;
  const { login, usage } = account;

  const presets = buildProbePresets({ login });
  const state = states[login] ?? initialProbeState(usage, presets);
  const update = (patch: Partial<AccountProbeState>) =>
    setStates((prev) => ({ ...prev, [login]: { ...(prev[login] ?? initialProbeState(usage, presets)), ...patch } }));

  const run = async () => {
    const { source, endpoint } = state;
    update({ running: true, error: null });
    try {
      const res = await window.jarvis.probeCopilotEndpoint(login, source, endpoint);
      setStates((prev) => {
        const cur = prev[login] ?? initialProbeState(usage, presets);
        return { ...prev, [login]: 'response' in res
          ? { ...cur, running: false, results: [res.response, ...cur.results] }
          : { ...cur, running: false, error: res.error } };
      });
    } catch (err) {
      update({ running: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div class="bg-copilot-probe">
      <p class="bg-copilot-raw-empty">
        The user report only lists usage billed to a personal plan. For a seat managed by an organization or enterprise
        the matching report answers 404 unless the token belongs to an admin there; you can still type that path below.
      </p>
      <div class="bg-copilot-probe-accounts" role="group" aria-label="Account to use">
        <span>Account</span>
        {accounts.map((a) => (
          <button
            type="button"
            key={a.login}
            class={`bg-status-claude-action${a.login === login ? ' bg-copilot-probe-account--on' : ''}`}
            aria-pressed={a.login === login}
            onClick={() => setSelected(a.login)}
          >
            @{a.login}
          </button>
        ))}
      </div>
      <div class="bg-copilot-probe-row">
        <select
          aria-label="Example endpoints"
          value=""
          onChange={(e) => { if (e.currentTarget.value) update({ endpoint: e.currentTarget.value }); }}
        >
          <option value="">Examples…</option>
          {presets.map((p) => <option key={p.endpoint} value={p.endpoint}>{p.label}</option>)}
        </select>
        <select aria-label="Token" value={state.source} onChange={(e) => update({ source: e.currentTarget.value as ProbeSource })}>
          {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div class="bg-copilot-probe-row">
        <input
          type="text"
          spellcheck={false}
          aria-label="Endpoint"
          value={state.endpoint}
          onInput={(e) => update({ endpoint: e.currentTarget.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && !state.running) void run(); }}
        />
        <button type="button" class="bg-status-claude-action" disabled={state.running || !state.endpoint.trim()} onClick={() => void run()}>
          {state.running ? 'Running…' : 'Run'}
        </button>
      </div>
      {state.error && <div class="bg-status-claude-error">{state.error}</div>}
      {state.results.map((r, i) => <RawEntry key={`${login}:${i}:${r.endpoint}`} response={r} quotaCredits={usage.creditsUsed} />)}
    </div>
  );
}

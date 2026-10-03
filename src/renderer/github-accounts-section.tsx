// ── Settings: multiple GitHub accounts ───────────────────────────────────────
import { useState, useEffect } from 'preact/hooks';
import {
  isIpcError,
  type GitHubAccountAssignment,
  type GitHubAccountInfo,
  type GitHubAccountUsage,
} from '../plugins/types';

const SOURCE_LABEL: Record<GitHubAccountInfo['sources'][number], string> = {
  oauth: 'Jarvis sign-in',
  pat: 'PAT',
  'gh-cli': 'GitHub CLI',
};

const accountLabel = (a: GitHubAccountInfo) => (a.host === 'github.com' ? a.login : `${a.login} (${a.host})`);

function usageLine(entry: GitHubAccountUsage | undefined): string {
  if (!entry) return 'Checking usage…';
  const u = entry.usage;
  if (!u.configured) return 'No credentials to read Copilot usage.';
  if (u.error) return u.error;
  const used = Math.round(u.creditsUsed).toLocaleString();
  const of = u.budgetCredits !== null ? ` of ${u.budgetCredits.toLocaleString()} budget` : '';
  const plan = u.plan ? ` · ${u.plan} plan` : '';
  return `${used} AI credits used this month${of}${plan}`;
}

function AccountRow({
  usage, account, onChanged,
}: { account: GitHubAccountInfo; usage: GitHubAccountUsage | undefined; onChanged: () => void }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const budget = usage?.usage.budgetCredits ?? null;
  useEffect(() => { setDraft(budget !== null ? String(budget) : ''); }, [budget]);

  const draftValue = draft.trim() === '' ? null : Number(draft);
  const draftValid = draftValue === null || (Number.isFinite(draftValue) && draftValue >= 0);
  const hasJarvisSignIn = account.sources.includes('oauth') || account.sources.includes('pat');

  const saveBudget = async () => {
    setSaving(true);
    try {
      const res = await window.jarvis.setGitHubAccountBudget(account.id, draftValue);
      if (isIpcError(res)) alert('Error: ' + res.error);
      else onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="account-row">
      <div class="account-head">
        {account.avatarUrl && <img class="user-avatar" src={account.avatarUrl} alt="" />}
        <strong>@{account.login}</strong>
        {account.host !== 'github.com' && <span class="account-tag">{account.host}</span>}
        {account.isPrimary && <span class="account-tag primary">primary</span>}
        {account.sources.map((s) => <span key={s} class="account-tag">{SOURCE_LABEL[s]}</span>)}
        <div style={{ flex: 1 }} />
        {!account.isPrimary && account.sources.includes('oauth') && (
          <button
            class="btn-secondary"
            title="Notifications, agents, discovery and the status bar use the primary account"
            onClick={async () => {
              const res = await window.jarvis.setPrimaryGitHubAccount(account.id);
              if (isIpcError(res)) alert('Error: ' + res.error);
              else onChanged();
            }}
          >
            Make primary
          </button>
        )}
        {hasJarvisSignIn && (
          <button
            class="btn-danger"
            onClick={async () => {
              if (!confirm(`Remove @${account.login} from Jarvis? Its stored sign-in and PAT are deleted.`)) return;
              const res = await window.jarvis.removeGitHubAccount(account.id);
              if (isIpcError(res)) alert('Error: ' + res.error);
              else onChanged();
            }}
          >
            Remove
          </button>
        )}
      </div>
      <p class="hint account-usage" style={usage?.usage.error ? { color: '#ffb74d' } : undefined}>{usageLine(usage)}</p>
      <div class="btn-row" style={{ alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
        <input
          type="number"
          min="0"
          step="100"
          placeholder="Monthly budget (AI credits)"
          aria-label={`Monthly Copilot budget for ${account.id}`}
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' && draftValid) void saveBudget(); }}
        />
        <button class="btn-save" onClick={() => void saveBudget()} disabled={saving || !draftValid || draftValue === budget}>
          {saving ? 'Saving…' : 'Save budget'}
        </button>
      </div>
    </div>
  );
}

function AssignmentRow({
  assignment, accounts, onChanged,
}: { assignment: GitHubAccountAssignment; accounts: GitHubAccountInfo[]; onChanged: (a: GitHubAccountAssignment[]) => void }) {
  const known = accounts.some((a) => a.id.toLowerCase() === assignment.login.toLowerCase());
  const update = async (login: string | null) => {
    const res = await window.jarvis.setGitHubAccountAssignment(assignment.scope, assignment.key, login);
    if (isIpcError(res)) alert('Error: ' + res.error);
    else onChanged(res.assignments);
  };
  return (
    <div class="assignment-row">
      <code>{assignment.key}</code>
      <span class="account-tag">{assignment.scope}</span>
      <select
        aria-label={`Account for ${assignment.key}`}
        value={assignment.login}
        onChange={(e) => void update((e.target as HTMLSelectElement).value)}
      >
        {!known && <option value={assignment.login}>{assignment.login} (not signed in)</option>}
        {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
      </select>
      <span class="hint" style={{ margin: 0 }}>{assignment.source === 'git-config' ? 'from git config' : 'set by you'}</span>
      <button class="btn-secondary" aria-label={`Remove assignment for ${assignment.key}`} onClick={() => void update(null)}>×</button>
    </div>
  );
}

export function GitHubAccountsSection() {
  const [accounts, setAccounts] = useState<GitHubAccountInfo[]>([]);
  const [assignments, setAssignments] = useState<GitHubAccountAssignment[]>([]);
  const [usage, setUsage] = useState<GitHubAccountUsage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [signIn, setSignIn] = useState<{ userCode?: string; verificationUri?: string; error?: string } | null>(null);
  const [syncMsg, setSyncMsg] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [gheHost, setGheHost] = useState('');
  const [ghePat, setGhePat] = useState('');
  const [gheBusy, setGheBusy] = useState(false);
  const [gheMsg, setGheMsg] = useState<{ error?: string; ok?: string } | null>(null);

  const loadAccounts = async () => {
    try {
      const res = await window.jarvis.listGitHubAccounts();
      if (!isIpcError(res)) {
        setAccounts(res.accounts);
        setAssignments(res.assignments);
      }
    } finally {
      setLoading(false);
    }
  };
  const loadUsage = async () => {
    setChecking(true);
    try {
      const res = await window.jarvis.getGitHubAccountsUsage();
      if (!isIpcError(res)) setUsage(res.usage);
    } finally {
      setChecking(false);
    }
  };
  const reload = () => { void loadAccounts().then(loadUsage); };

  useEffect(() => {
    reload();
    return window.jarvis.onOAuthComplete((result) => {
      setSignIn(result.error ? { error: result.error } : null);
      reload();
    });
  }, []);

  const addAccount = async () => {
    setSignIn({});
    const res = await window.jarvis.startGitHubOAuth({ additional: true });
    setSignIn(res.error ? { error: res.error } : { userCode: res.userCode, verificationUri: res.verificationUri });
  };

  const addHostAccount = async () => {
    setGheBusy(true);
    setGheMsg(null);
    try {
      const res = await window.jarvis.addGitHubHostAccount(gheHost.trim(), ghePat.trim());
      if (isIpcError(res)) {
        setGheMsg({ error: res.error });
        return;
      }
      setGheMsg({ ok: `Added @${res.login} on ${gheHost.trim().toLowerCase()}.` });
      setGheHost('');
      setGhePat('');
      reload();
    } finally {
      setGheBusy(false);
    }
  };

  const syncGitConfig = async () => {
    const res = await window.jarvis.syncGitHubAccountsFromGitConfig();
    if (isIpcError(res)) {
      setSyncMsg('Import failed: ' + res.error);
      return;
    }
    setAssignments(res.assignments);
    setSyncMsg(`Imported ${res.imported} assignment${res.imported === 1 ? '' : 's'} from git config` +
      (res.keptManual > 0 ? ` (${res.keptManual} you set yourself kept).` : '.'));
  };

  const addOwner = async () => {
    const owner = newOwner.trim().replace(/^@/, '');
    const login = accounts.find((a) => a.isPrimary)?.id ?? accounts[0]?.id;
    if (!owner || !login) return;
    // `owner`, `owner/repo`, or with a GHE.com host in front: `corp.ghe.com/owner[/repo]`.
    const parts = owner.split('/').filter(Boolean);
    const rest = /\.ghe\.com$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
    const scope = rest.length >= 2 ? 'repo' : 'owner';
    const res = await window.jarvis.setGitHubAccountAssignment(scope, owner, login);
    if (isIpcError(res)) alert('Error: ' + res.error);
    else {
      setAssignments(res.assignments);
      setNewOwner('');
    }
  };

  const signingIn = signIn !== null && !signIn.error;
  return (
    <div class="section">
      <h2>GitHub Accounts</h2>
      <p class="hint">
        Track several GitHub accounts and check each one's Copilot usage against its own monthly budget. Accounts come from
        Jarvis sign-ins and from the GitHub CLI (<code>gh auth login</code> — also what lets Jarvis read org-billed Copilot
        quota). The primary account is used by everything that works with a single account.
      </p>

      {loading && <p class="hint">Loading accounts…</p>}
      {!loading && accounts.length === 0 && (
        <p class="hint">No accounts yet — sign in below or log in to the GitHub CLI.</p>
      )}
      {accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          usage={usage?.find((u) => u.account.id === account.id)}
          onChanged={reload}
        />
      ))}

      <div class="btn-row">
        <button class="btn-save" onClick={() => void addAccount()} disabled={signingIn}>
          {signingIn ? 'Waiting for GitHub…' : 'Add GitHub account'}
        </button>
        <button class="btn-secondary" onClick={() => void loadUsage()} disabled={checking}>
          {checking ? 'Checking…' : 'Check all accounts'}
        </button>
      </div>
      <h2 style={{ marginTop: '1rem' }}>GHE.com account</h2>
      <p class="hint">
        An account on GitHub Enterprise Cloud with data residency (<code>your-company.ghe.com</code>). Jarvis' sign-in app only
        exists on github.com, so use either the GitHub CLI — <code>gh auth login --hostname your-company.ghe.com</code>, which
        also lets Jarvis read that account's Copilot quota — or add a personal access token here.
      </p>
      <div class="btn-row">
        <input
          type="text"
          placeholder="your-company.ghe.com"
          aria-label="GHE.com host"
          value={gheHost}
          onInput={(e) => setGheHost((e.target as HTMLInputElement).value)}
        />
        <input
          type="password"
          placeholder="Personal access token"
          aria-label="GHE.com personal access token"
          value={ghePat}
          onInput={(e) => setGhePat((e.target as HTMLInputElement).value)}
        />
        <button class="btn-secondary" onClick={() => void addHostAccount()} disabled={gheBusy || !gheHost.trim() || !ghePat.trim()}>
          {gheBusy ? 'Checking…' : 'Add GHE.com account'}
        </button>
      </div>
      {gheMsg && (
        <p class="hint" style={{ marginTop: '0.4rem' }}>
          {gheMsg.error ? <span style={{ color: '#ff8080' }}>{gheMsg.error}</span> : gheMsg.ok}
        </p>
      )}

      {signIn && (
        <p class="hint" style={{ marginTop: '0.4rem' }}>
          {signIn.error
            ? <span style={{ color: '#ff8080' }}>Sign-in failed: {signIn.error}</span>
            : signIn.userCode
              ? <>A browser tab was opened at <code>{signIn.verificationUri}</code> — sign in to the account you want to add,
                  enter code <strong><code>{signIn.userCode}</code></strong> and click <strong>Authorize</strong>.</>
              : 'Starting GitHub sign-in…'}
        </p>
      )}

      <h2 style={{ marginTop: '1rem' }}>Account per owner / repo</h2>
      <p class="hint">
        Choose which account Jarvis uses for discovery and notifications of an owner (organization or user) or a single
        <code>owner/repo</code>. A repo setting beats its owner's; anything unassigned goes to the account that discovered
        it (the primary account when it can see the repo too). Git already knows this for your clones:
        import it from <code>credential.https://github.com/&lt;owner&gt;.username</code> in your git config.
      </p>
      {assignments.map((a) => (
        <AssignmentRow key={`${a.scope}:${a.key}`} assignment={a} accounts={accounts} onChanged={setAssignments} />
      ))}
      <div class="btn-row">
        <input
          type="text"
          placeholder="owner, owner/repo or corp.ghe.com/owner"
          aria-label="Owner or repository to assign an account to"
          value={newOwner}
          onInput={(e) => setNewOwner((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void addOwner(); }}
        />
        <button class="btn-secondary" onClick={() => void addOwner()} disabled={!newOwner.trim() || accounts.length === 0}>
          Add
        </button>
        <button class="btn-secondary" onClick={() => void syncGitConfig()}>Import from git config</button>
      </div>
      {syncMsg && <p class="hint" style={{ marginTop: '0.4rem' }}>{syncMsg}</p>}
    </div>
  );
}

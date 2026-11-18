import { useState, useEffect, useCallback } from 'preact/hooks';
import { isIpcError } from '../types';
import type { FireBrief, BriefItem } from '../../services/fire-brief';

type BriefTab = NonNullable<BriefItem['tab']>;

/**
 * Dashboard card for the "what's on fire" brief. The structured list comes
 * from the main process and works without Ollama; `brief.summary` is optional prose on top.
 */
export function FireBriefCard({ onOpenTab }: { onOpenTab?: (tab: BriefTab) => void }) {
  const [brief, setBrief] = useState<FireBrief | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.jarvis.getFireBrief().then((b) => { if (!cancelled && !isIpcError(b)) setBrief(b); }).catch(() => { /* card stays hidden */ });
    const off = window.jarvis.onFireBrief(({ brief: b }) => setBrief(b));
    return () => { cancelled = true; off(); };
  }, []);

  const acknowledge = useCallback(async () => {
    setBusy(true);
    try {
      const b = await window.jarvis.acknowledgeFireBrief();
      if (!isIpcError(b)) setBrief(b);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!brief) return null;

  if (brief.allClear) {
    return (
      <div class="fire-brief fire-brief--clear" data-testid="fire-brief">
        <span class="fire-brief-title">✅ Nothing on fire since {new Date(brief.since).toLocaleString()}</span>
      </div>
    );
  }

  return (
    <div class="fire-brief" data-testid="fire-brief">
      <div class="fire-brief-head">
        <span class="fire-brief-title">🔥 What's on fire ({brief.totalItems})</span>
        <button class="dash-refresh-btn" onClick={() => void acknowledge()} disabled={busy} title="Mark this brief as read; failures older than now are hidden next time">
          Mark as read
        </button>
      </div>
      {brief.summary && <p class="fire-brief-summary">{brief.summary}</p>}
      {brief.sections.map((s) => (
        <div class="fire-brief-section" key={s.id}>
          <div class="fire-brief-section-title">{s.title} · {s.total}</div>
          <ul class="fire-brief-list">
            {s.items.map((item) => (
              <li key={item.id} class={`fire-brief-item fire-brief-item--${item.severity}`}>
                {item.url
                  ? <a href={item.url} target="_blank" rel="noreferrer">{item.text}</a>
                  : <span>{item.text}</span>}
                {!item.url && item.tab && onOpenTab && (
                  <button class="fire-brief-open" onClick={() => onOpenTab(item.tab as BriefTab)}>Open</button>
                )}
              </li>
            ))}
            {s.total > s.items.length && <li class="fire-brief-more">…and {s.total - s.items.length} more</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

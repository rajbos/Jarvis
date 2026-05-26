import { useState, useEffect } from 'preact/hooks';
import type { OneNoteGroupCachePage } from '../types';

// ── OneNoteCachePanel ─────────────────────────────────────────────────────────
// Sanity-check view of all cached OneNote pages for a group.
// Shows section name, page hierarchy, title, and last-modified date.
// Opens as a sub-panel to the right of GroupsPanel.

interface Props {
  groupId: number;
  groupName: string;
  onClose: () => void;
}

export function OneNoteCachePanel({ groupId, groupName, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState<OneNoteGroupCachePage[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    setPages([]);
    window.jarvis.onedriveGetOneNoteCacheForGroup(groupId)
      .then(r => { setPages(r.pages); })
      .catch((err: unknown) => { setError(String(err)); })
      .finally(() => { setLoading(false); });
  }, [groupId]);

  // Group pages by section file
  const sections = groupBySectionFile(pages);

  const totalPages = pages.length;
  const withDate = pages.filter(p => p.pageLastModified).length;
  const comPages = pages.filter(p => p.readSource === 'com').length;

  return (
    <div class="org-panel onenote-cache-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>📋 OneNote cache — {groupName}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      {loading && (
        <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.5rem 0' }}>Loading…</div>
      )}

      {!loading && error && (
        <div style={{ color: '#f88', fontSize: '0.82rem', padding: '0.5rem 0', wordBreak: 'break-word' }}>{error}</div>
      )}

      {!loading && !error && totalPages === 0 && (
        <div style={{ fontSize: '0.8rem', color: '#667', fontStyle: 'italic' }}>
          No pages cached yet. Use "Cache OneNote files" in the group panel first.
        </div>
      )}

      {!loading && totalPages > 0 && (
        <>
          {/* Summary bar */}
          <div style={{ fontSize: '0.73rem', color: '#778', marginBottom: '0.65rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>{totalPages} page{totalPages !== 1 ? 's' : ''}</span>
            <span>{sections.length} section{sections.length !== 1 ? 's' : ''}</span>
            <span style={{ color: withDate < totalPages ? '#fa8' : '#6a9' }}>
              {withDate}/{totalPages} with date
            </span>
            {comPages > 0 && (
              <span style={{ color: '#88d' }}>
                {comPages} via COM
              </span>
            )}
          </div>

          {sections.map(section => (
            <SectionBlock key={section.relativePath} section={section} />
          ))}
        </>
      )}
    </div>
  );
}

// ── SectionBlock ──────────────────────────────────────────────────────────────

interface SectionGroup {
  relativePath: string;
  sectionName: string;
  pages: OneNoteGroupCachePage[];
  cachedAt: string;
}

function groupBySectionFile(pages: OneNoteGroupCachePage[]): SectionGroup[] {
  const map = new Map<string, SectionGroup>();
  for (const p of pages) {
    let g = map.get(p.relativePath);
    if (!g) {
      g = { relativePath: p.relativePath, sectionName: p.sectionName || p.relativePath, pages: [], cachedAt: p.cachedAt };
      map.set(p.relativePath, g);
    }
    g.pages.push(p);
  }
  return [...map.values()];
}

function SectionBlock({ section }: { section: SectionGroup }) {
  const [collapsed, setCollapsed] = useState(false);
  const cachedDate = section.cachedAt ? new Date(section.cachedAt).toLocaleDateString() : '—';

  return (
    <div style={{ marginBottom: '0.55rem', borderRadius: '5px', background: '#1a1a26', border: '1px solid #232340', overflow: 'hidden' }}>
      {/* Section header row */}
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0.5rem', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setCollapsed(c => !c)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
          <span style={{ fontSize: '0.78rem' }}>📓</span>
          <span style={{ fontSize: '0.82rem', color: '#ccd', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {section.sectionName}
          </span>
          <span style={{ fontSize: '0.7rem', color: '#556', flexShrink: 0 }}>
            {section.pages.length}p
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          <span style={{ fontSize: '0.68rem', color: '#556' }}>cached {cachedDate}</span>
          <span style={{ fontSize: '0.7rem', color: '#556' }}>{collapsed ? '▶' : '▼'}</span>
        </div>
      </div>

      {!collapsed && (
        <div style={{ borderTop: '1px solid #1e1e2e' }}>
          {section.pages.map(p => (
            <PageRow key={p.pageIndex} page={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── PageRow ───────────────────────────────────────────────────────────────────

function PageRow({ page }: { page: OneNoteGroupCachePage }) {
  const indent = (page.pageLevel - 1) * 14;
  const hasDate = !!page.pageLastModified;
  const displayDate = hasDate ? page.pageLastModified.slice(0, 10) : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.18rem 0.5rem',
        borderBottom: '1px solid #1a1a28',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', minWidth: 0, paddingLeft: `${indent}px` }}>
        {page.pageLevel > 1 && (
          <span style={{ color: '#445', fontSize: '0.72rem', flexShrink: 0 }}>↳</span>
        )}
        <span
          style={{
            fontSize: '0.78rem',
            color: page.pageTitle ? '#bbd' : '#556',
            fontStyle: page.pageTitle ? 'normal' : 'italic',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={page.pageTitle || undefined}
        >
          {page.pageTitle || '(untitled)'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0, paddingLeft: '0.5rem' }}>
        {displayDate ? (
          <span style={{ fontSize: '0.7rem', color: '#6a9', fontFamily: 'monospace' }}>{displayDate}</span>
        ) : (
          <span style={{ fontSize: '0.68rem', color: '#fa8', fontFamily: 'monospace' }} title="No last-modified date available">no date</span>
        )}
        <span
          style={{
            fontSize: '0.62rem',
            color: page.readSource === 'com' ? '#88d' : '#667',
            background: page.readSource === 'com' ? '#1a1a35' : '#1a1a1a',
            padding: '0.05rem 0.25rem',
            borderRadius: '3px',
          }}
        >
          {page.readSource}
        </span>
      </div>
    </div>
  );
}

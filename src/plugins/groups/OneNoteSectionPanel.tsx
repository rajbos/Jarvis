import { useState, useEffect } from 'preact/hooks';
import type { OneNoteSectionContent, OneNotePageContent } from '../types';

// ── OneNoteSectionPanel ───────────────────────────────────────────────────────
// Shows the extracted text of a single .one section file — its pages, titles,
// dates, and body content. Opens as a sub-panel to the right of GroupsPanel.

interface Props {
  filePath: string;
  onClose: () => void;
}

export function OneNoteSectionPanel({ filePath, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = useState<OneNoteSectionContent | null>(null);
  const [expandedPages, setExpandedPages] = useState<Set<number>>(new Set());

  useEffect(() => {
    setLoading(true);
    setError('');
    setSection(null);
    setExpandedPages(new Set());

    window.jarvis.onedriveReadOneNoteFile(filePath)
      .then((result) => {
        if (result.ok && result.section) {
          setSection(result.section);
        } else {
          setError(result.error ?? 'Failed to read OneNote file');
        }
      })
      .catch((err: unknown) => {
        setError(String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [filePath]);

  const togglePage = (pageIndex: number) => {
    setExpandedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageIndex)) {
        next.delete(pageIndex);
      } else {
        next.add(pageIndex);
      }
      return next;
    });
  };

  // Derive section name from path for the header (fallback before data loads)
  const sectionName = section?.sectionName
    ?? filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.one$/i, '')
    ?? 'OneNote Section';

  return (
    <div class="org-panel onenote-section-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>📓 {sectionName}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      {loading && (
        <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.5rem 0' }}>Reading file…</div>
      )}

      {!loading && error && (
        <div style={{ color: '#f88', fontSize: '0.82rem', padding: '0.5rem 0', wordBreak: 'break-word' }}>
          {error}
        </div>
      )}

      {!loading && section && (
        <>
          <div style={{ fontSize: '0.73rem', color: '#556', marginBottom: '0.65rem', fontStyle: 'italic' }}>
            {section.pageCount} page{section.pageCount !== 1 ? 's' : ''}
          </div>

          {section.pages.map((page) => (
            <PageCard
              key={page.pageIndex}
              page={page}
              expanded={expandedPages.has(page.pageIndex)}
              onToggle={() => togglePage(page.pageIndex)}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ── PageCard ──────────────────────────────────────────────────────────────────

const CONTENT_PREVIEW_CHARS = 320;

function PageCard({
  page,
  expanded,
  onToggle,
}: {
  page: OneNotePageContent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasLongContent = page.content.length > CONTENT_PREVIEW_CHARS;
  const displayContent =
    expanded || !hasLongContent
      ? page.content
      : page.content.slice(0, CONTENT_PREVIEW_CHARS) + '…';

  return (
    <div
      style={{
        marginBottom: '0.6rem',
        borderRadius: '5px',
        background: '#1a1a26',
        padding: '0.5rem 0.6rem',
        border: '1px solid #232340',
      }}
    >
      {/* Page heading row */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: '0.84rem',
            color: '#cce',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
          title={page.title || undefined}
        >
          {page.title || `Page ${page.pageIndex}`}
        </div>
        <div style={{ fontSize: '0.7rem', color: '#445', flexShrink: 0, paddingLeft: '0.5rem' }}>
          #{page.pageIndex}
        </div>
      </div>

      {/* Date */}
      {page.date && (
        <div style={{ fontSize: '0.72rem', color: '#778', marginBottom: '0.3rem' }}>
          {page.date}
        </div>
      )}

      {/* Body text */}
      {page.content ? (
        <>
          <div
            style={{
              fontSize: '0.77rem',
              color: '#aab',
              lineHeight: '1.55',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {displayContent}
          </div>
          {hasLongContent && (
            <button
              onClick={onToggle}
              style={{
                marginTop: '0.3rem',
                background: 'none',
                border: 'none',
                color: '#66a',
                fontSize: '0.72rem',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {expanded ? '▲ Show less' : '▼ Show more'}
            </button>
          )}
        </>
      ) : (
        <div style={{ fontSize: '0.74rem', color: '#445', fontStyle: 'italic' }}>
          No body text found
        </div>
      )}
    </div>
  );
}

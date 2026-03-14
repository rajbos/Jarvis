import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { Repo } from '../types';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Repo[] | null>(null);
  const [showResults, setShowResults] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const onInput = useCallback((e: Event) => {
    const q = (e.target as HTMLInputElement).value;
    setQuery(q);
    clearTimeout(timerRef.current);
    if (q.trim().length < 2) {
      setShowResults(false);
      setResults(null);
      return;
    }
    timerRef.current = window.setTimeout(async () => {
      try {
        const r = await window.jarvis.searchRepos(q.trim());
        setResults(r);
        setShowResults(true);
      } catch (err) {
        console.error('[Search]', err);
      }
    }, 200);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowResults(false);
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <div class="search-wrap" ref={wrapRef}>
      <span class="search-icon">{'\uD83D\uDD0D'}</span>
      <input
        type="text"
        placeholder={'Search repositories\u2026'}
        autocomplete="off"
        spellcheck={false}
        value={query}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      {showResults && (
        <div class="search-results">
          {results && results.length === 0 && (
            <div class="search-empty">No repositories found</div>
          )}
          {results &&
            results.map((repo) => {
              const slash = repo.full_name.indexOf('/');
              const orgPart = slash !== -1 ? repo.full_name.slice(0, slash) : '';
              return (
                <div
                  key={repo.full_name}
                  class="search-result-item"
                  onClick={() => {
                    window.jarvis.openUrl('https://github.com/' + repo.full_name);
                    setShowResults(false);
                  }}
                >
                  <div class="sri-main">
                    <div class="sri-name">{repo.name}</div>
                    <div class="sri-org">{orgPart || 'personal'}</div>
                  </div>
                  <div class="sri-side">
                    {repo.language && <span class="sri-lang">{repo.language}</span>}
                    {!!repo.fork && <span class="sri-badge">fork</span>}
                    {!!repo.archived && <span class="sri-badge">archived</span>}
                    {!!repo.private && <span class="sri-badge">private</span>}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

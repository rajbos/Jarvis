import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

import './about.css';

interface AboutInfo {
  displayVersion: string;
  appVersion: string;
  isDev: boolean;
  branch: string | null;
  releasedAt: string | null;
  releaseUrl: string | null;
  repoUrl: string;
}

declare const window: Window & {
  jarvis: {
    getAboutInfo(): Promise<AboutInfo>;
    shellOpenUrl(url: string): Promise<{ ok: boolean; error?: string }>;
  };
};

function formatReleaseDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function AboutApp() {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await window.jarvis.getAboutInfo());
      } catch (err) {
        console.error('[About] Failed to load about info:', err);
      }
    })();
  }, []);

  const openUrl = (url: string) => { void window.jarvis.shellOpenUrl(url); };

  if (!info) {
    return (
      <div class="about-dialog">
        <h3>About Jarvis</h3>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div class="about-dialog">
      <h3>About Jarvis</h3>

      <dl class="about-facts">
        <dt>{info.isDev ? 'Branch' : 'Version'}</dt>
        <dd class="about-version">{info.displayVersion}</dd>

        <dt>Released</dt>
        <dd>
          {info.isDev
            ? 'Development build — not a released version'
            : info.releasedAt
              ? formatReleaseDate(info.releasedAt)
              : 'Release date unavailable — could not reach GitHub'}
        </dd>
      </dl>

      <p class="hint">Jarvis is open source — issues and contributions are welcome.</p>

      <div class="about-links">
        <button class="btn-link" onClick={() => openUrl(info.repoUrl)}>Open the GitHub repository</button>
        {info.releaseUrl && (
          <button class="btn-link" onClick={() => openUrl(info.releaseUrl!)}>View the release notes</button>
        )}
      </div>

      <div class="btn-row">
        <button onClick={() => window.close()}>Close</button>
      </div>
    </div>
  );
}

const root = document.getElementById('app')!;
render(<AboutApp />, root);

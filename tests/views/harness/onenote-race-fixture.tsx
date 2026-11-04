/** @jsxImportSource preact */
// Test-only page: the OneNote panels with a hand-controlled `window.jarvis`, so a test
// can resolve an older request after a newer one (issue #491).
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { OneNoteCachePanel } from '../../../src/plugins/groups/OneNoteCachePanel';
import { OneNoteSectionPanel } from '../../../src/plugins/groups/OneNoteSectionPanel';

interface Pending {
  key: number | string;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
declare global {
  interface Window {
    __pending: { cache: Pending[]; section: Pending[] };
  }
}
window.__pending = { cache: [], section: [] };

const deferred = (list: Pending[], key: number | string) =>
  new Promise((resolve, reject) => { list.push({ key, resolve, reject }); });

(window as unknown as { jarvis: unknown }).jarvis = {
  onedriveGetOneNoteCacheForGroup: (id: number) => deferred(window.__pending.cache, id),
  onedriveReadOneNoteFile: (path: string) => deferred(window.__pending.section, path),
};

function App() {
  const [groupId, setGroupId] = useState(1);
  const [filePath, setFilePath] = useState('a.one');
  return (
    <div>
      <button onClick={() => setGroupId(2)}>Switch group</button>
      <button onClick={() => setFilePath('b.one')}>Switch file</button>
      <OneNoteCachePanel groupId={groupId} groupName={`Group ${groupId}`} onClose={() => {}} />
      <OneNoteSectionPanel filePath={filePath} onClose={() => {}} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);

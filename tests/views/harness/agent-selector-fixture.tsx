/** @jsxImportSource preact */
// Test-only page: the AgentSelector modal, counting onClose calls in window.__closed.
import { render } from 'preact';
import { AgentSelector } from '../../../src/plugins/agents/AgentSelector';

declare global {
  interface Window {
    __closed: number;
  }
}
window.__closed = 0;

// Starting a run never settles, so the modal stays in its "Starting…" state.
(window as unknown as { jarvis: { agentsRun: () => Promise<never> } }).jarvis.agentsRun = () => new Promise(() => {});

render(
  <AgentSelector
    repoFullName="example-org/example-repo"
    onClose={() => { window.__closed += 1; }}
    onSessionStarted={() => {}}
  />,
  document.getElementById('app')!,
);

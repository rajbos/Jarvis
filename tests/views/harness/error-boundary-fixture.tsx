/** @jsxImportSource preact */
// Test-only page: a panel that throws on render, wrapped in the real ErrorBoundary,
// next to "chrome" that sits outside the boundary.
import { render } from 'preact';
import { ErrorBoundary } from '../../../src/plugins/shared/ErrorBoundary';

declare global {
  interface Window {
    /** While true the panel throws during render; tests flip it to simulate a fix. */
    __bombArmed?: boolean;
  }
}
window.__bombArmed = true;

function Bomb() {
  if (window.__bombArmed) throw new Error('fixture panel exploded');
  return <p>Panel content is healthy</p>;
}

render(
  <div>
    <nav>
      <button>Chrome button</button>
    </nav>
    <ErrorBoundary label="the fixture panel">
      <Bomb />
    </ErrorBoundary>
  </div>,
  document.getElementById('app')!,
);

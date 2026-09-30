/** @jsxImportSource preact */
import { Component, type ComponentChildren } from 'preact';

interface ErrorBoundaryProps {
  /** Short label shown in the fallback, e.g. the panel name. */
  label?: string;
  children?: ComponentChildren;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const MAX_STACK_LINES = 8;

/** Message plus a truncated stack only: never props or state, which may hold tokens. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stack = (error.stack ?? '').split('\n').slice(0, MAX_STACK_LINES).join('\n');
  return stack || error.message;
}

/** Catches render errors in its subtree and shows a recoverable fallback instead of a blank window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, describeError(error));
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" class="error-boundary" style={{ padding: '12px', color: '#ff6b81' }}>
        <p>Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}.</p>
        <p style={{ opacity: 0.8, fontSize: '0.9em' }}>{error.message}</p>
        <button onClick={() => this.setState({ error: null })}>Try again</button>{' '}
        <button onClick={() => window.location.reload()}>Reload window</button>
      </div>
    );
  }
}

/** Log JS errors that happen outside the render path (event handlers, unhandled promise rejections). */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    console.error('[window.onerror]', describeError(e.error ?? e.message));
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', describeError(e.reason));
  });
}

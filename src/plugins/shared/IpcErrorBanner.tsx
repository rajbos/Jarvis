interface IpcErrorBannerProps {
  /** Human-readable error message (already includes any "Failed to ..." prefix). */
  message: string;
  /** Shown as a button when the screen has a way to reload the failed data. */
  onRetry?: () => void;
  /** Overrides the default "Retry" label. */
  retryLabel?: string;
}

/**
 * Small, non-blocking error banner for a failed IPC call. Visually distinct
 * from an empty-state message (red-tinted, bordered) so users don't mistake
 * "the request failed" for "there is nothing here".
 */
export function IpcErrorBanner({ message, onRetry, retryLabel = 'Retry' }: IpcErrorBannerProps) {
  return (
    <div class="ipc-error-banner" role="alert">
      <span class="ipc-error-banner-icon" aria-hidden="true">{'⚠'}</span>
      <span class="ipc-error-banner-text">{message}</span>
      {onRetry && (
        <button type="button" class="ipc-error-banner-retry" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

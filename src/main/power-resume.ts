// Reacts to the machine waking from sleep. Timers pause while suspended, so
// token checks, update checks and background tasks can be hours stale on wake.
// Kept free of a hard Electron import so it can be unit tested.
import { logger } from '../services/logger';

export interface PowerMonitorLike {
  on(event: 'resume', listener: () => void): unknown;
}

/** Ignore resume events closer together than this (lock/unlock flurries). */
export const RESUME_DEBOUNCE_MS = 5 * 60 * 1000;

let registered = false;

/**
 * Register the single `resume` listener. Calling it again is a no-op, so a
 * second initialize() cannot stack duplicate handlers. `onResume` runs at most
 * once per `debounceMs`.
 */
export function registerPowerResumeHandler(
  monitor: PowerMonitorLike,
  onResume: () => void,
  debounceMs = RESUME_DEBOUNCE_MS,
): void {
  if (registered) return;
  registered = true;
  let lastRunAt = 0;
  monitor.on('resume', () => {
    const now = Date.now();
    if (lastRunAt && now - lastRunAt < debounceMs) {
      logger.debug('[Power] Resume ignored (debounced)');
      return;
    }
    lastRunAt = now;
    logger.info('[Power] System resumed from sleep');
    try {
      onResume();
    } catch (err) {
      logger.warn('[Power] Resume handler failed:', err);
    }
  });
}

/** IPC channel the renderer's polling helper listens on (preload `onSystemResumed`). */
export const APP_RESUMED_CHANNEL = 'app:resumed';

/**
 * Tell every open renderer the machine woke. Their polls run on window timers
 * that paused during sleep too, so they refresh on this instead of waiting a
 * full interval. `send` is `safeSend` in the app (injected to keep this module
 * free of Electron imports); one failing window does not stop the rest.
 */
export function notifyRenderersOfResume<W>(windows: readonly W[], send: (win: W, channel: string) => void): void {
  for (const win of windows) {
    try {
      send(win, APP_RESUMED_CHANNEL);
    } catch (err) {
      logger.debug('[Power] Could not notify window of resume:', err);
    }
  }
}

/** Test helper. */
export function resetPowerResumeHandlerForTests(): void {
  registered = false;
}

import { Notification } from 'electron';
import { logger } from './logger';

export interface SafeNotificationOptions {
  /** Invoked when the user clicks the notification. */
  onClick?: () => void;
  /** Log prefix used when the notification cannot be shown, e.g. '[Claude]'. */
  tag?: string;
}

/**
 * Show a desktop notification without ever throwing. Notifications are best-effort:
 * when the platform doesn't support them (or constructing/showing one fails) the
 * message is logged instead, so callers' real work is never interrupted.
 * Returns true when the notification was handed to the OS.
 */
export function showSafeNotification(title: string, body: string, options: SafeNotificationOptions = {}): boolean {
  const tag = options.tag ?? '[Notification]';
  try {
    if (!Notification.isSupported()) {
      logger.info(`${tag} ${title}: ${body}`);
      return false;
    }
    const notification = new Notification({ title, body });
    if (options.onClick) notification.on('click', options.onClick);
    notification.show();
    return true;
  } catch (err) {
    logger.warn(`${tag} Could not show notification:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

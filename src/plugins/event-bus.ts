// ── Lightweight pub/sub event bus ─────────────────────────────────────────────
// Used for renderer-side cross-plugin communication where prop drilling
// would be awkward (e.g. "notification counts refreshed" → multiple panels).

type Handler = (...args: unknown[]) => void;

const registry = new Map<string, Handler[]>();

/** Subscribe to an event. Returns an unsubscribe function. */
export function on(event: string, handler: Handler): () => void {
  const list = registry.get(event) ?? [];
  list.push(handler);
  registry.set(event, list);
  return () => {
    const current = registry.get(event);
    if (current) registry.set(event, current.filter((h) => h !== handler));
  };
}

/** Emit an event with optional payload arguments. */
export function emit(event: string, ...args: unknown[]): void {
  const list = registry.get(event);
  if (list) list.forEach((h) => h(...args));
}

// ── Well-known event names ────────────────────────────────────────────────────
export const Events = {
  NOTIF_COUNTS_UPDATED: 'notif:counts-updated',
  DISCOVERY_PROGRESS: 'discovery:progress',
  DISCOVERY_COMPLETE: 'discovery:complete',
  OAUTH_COMPLETE: 'oauth:complete',
  OPEN_CHAT: 'chat:open',
} as const;

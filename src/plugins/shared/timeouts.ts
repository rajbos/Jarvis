import { useEffect, useRef } from 'preact/hooks';

/**
 * Keyed one-shot timers that can all be cancelled at once.
 *
 * Setting a key that already has a pending timer replaces it, so a re-triggered
 * "copied!" flag resets from the latest click instead of the first. Distinct
 * keys run independently (e.g. two rows fading out at the same time).
 */
export class TimeoutRegistry {
  private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  set(key: string, fn: () => void, ms: number): void {
    if (this.disposed) return;
    this.clear(key);
    const handle = setTimeout(() => {
      this.handles.delete(key);
      fn();
    }, ms);
    this.handles.set(key, handle);
  }

  clear(key: string): void {
    const handle = this.handles.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.handles.delete(key);
    }
  }

  /** Cancels every pending timer and ignores any set() that comes later. */
  dispose(): void {
    for (const handle of this.handles.values()) clearTimeout(handle);
    this.handles.clear();
    this.disposed = true;
  }

  get pending(): number {
    return this.handles.size;
  }
}

/**
 * Timers for transient UI state (copy feedback, fade-outs, delayed refreshes)
 * that are cancelled when the component unmounts, so their callbacks never
 * call setState or start work on behalf of a view that is gone.
 *
 * Any setTimeout that calls setState from an event handler should go through
 * this hook; timers created inside a useEffect can clear themselves in the
 * effect's cleanup instead.
 */
export function useTimeouts(): TimeoutRegistry {
  const ref = useRef<TimeoutRegistry | null>(null);
  if (ref.current === null) ref.current = new TimeoutRegistry();
  const registry = ref.current;
  // Disposing also covers handlers still awaiting something (a clipboard write,
  // an IPC call) at unmount: their later set() calls become no-ops.
  useEffect(() => () => registry.dispose(), [registry]);
  return registry;
}

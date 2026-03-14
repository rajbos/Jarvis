import { describe, it, expect, vi, beforeEach } from 'vitest';
import { on, emit, Events } from '../../src/plugins/event-bus';

// The registry is module-level, so we must clean up subscriptions in each test.
// All tests should call the returned unsubscribe fn.

describe('event-bus — on / emit', () => {
  it('calls handler when event is emitted', () => {
    const handler = vi.fn();
    const unsub = on('test:basic', handler);
    emit('test:basic', 'hello');
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('hello');
    unsub();
  });

  it('passes multiple arguments through', () => {
    const handler = vi.fn();
    const unsub = on('test:multi-arg', handler);
    emit('test:multi-arg', 1, 'two', { three: 3 });
    expect(handler).toHaveBeenCalledWith(1, 'two', { three: 3 });
    unsub();
  });

  it('calls all registered handlers for the same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const u1 = on('test:multi-handler', h1);
    const u2 = on('test:multi-handler', h2);
    emit('test:multi-handler', 42);
    expect(h1).toHaveBeenCalledWith(42);
    expect(h2).toHaveBeenCalledWith(42);
    u1();
    u2();
  });

  it('does not call handler after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = on('test:unsub', handler);
    unsub();
    emit('test:unsub', 'should not arrive');
    expect(handler).not.toHaveBeenCalled();
  });

  it('only removes the unsubscribed handler, not others', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const u1 = on('test:partial-unsub', h1);
    const u2 = on('test:partial-unsub', h2);
    u1(); // unsubscribe only h1
    emit('test:partial-unsub');
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
    u2();
  });

  it('does not throw when emitting with no handlers', () => {
    expect(() => emit('test:no-listeners', 'data')).not.toThrow();
  });

  it('handler is not called for a different event', () => {
    const handler = vi.fn();
    const unsub = on('test:event-a', handler);
    emit('test:event-b', 'payload');
    expect(handler).not.toHaveBeenCalled();
    unsub();
  });

  it('can be re-subscribed after unsubscribe', () => {
    const handler = vi.fn();
    const u1 = on('test:resub', handler);
    u1();
    const u2 = on('test:resub', handler);
    emit('test:resub', 'ping');
    expect(handler).toHaveBeenCalledOnce();
    u2();
  });
});

// ── Events constants ──────────────────────────────────────────────────────────
describe('Events constants', () => {
  it('has NOTIF_COUNTS_UPDATED', () => {
    expect(Events.NOTIF_COUNTS_UPDATED).toBe('notif:counts-updated');
  });
  it('has DISCOVERY_PROGRESS', () => {
    expect(Events.DISCOVERY_PROGRESS).toBe('discovery:progress');
  });
  it('has DISCOVERY_COMPLETE', () => {
    expect(Events.DISCOVERY_COMPLETE).toBe('discovery:complete');
  });
  it('has OAUTH_COMPLETE', () => {
    expect(Events.OAUTH_COMPLETE).toBe('oauth:complete');
  });
  it('has OPEN_CHAT', () => {
    expect(Events.OPEN_CHAT).toBe('chat:open');
  });
});

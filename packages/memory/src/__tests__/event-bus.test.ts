import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryEventBus } from '../event-bus.js';
import type { MemoryEvent } from '../event-bus.js';

describe('MemoryEventBus', () => {
  let bus: MemoryEventBus;

  beforeEach(() => {
    bus = new MemoryEventBus();
  });

  it('emits events to typed handlers', () => {
    const handler = vi.fn();
    bus.on('embedding_failed', handler);

    bus.emitError('embedding_failed', 'test failure');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'embedding_failed',
      message: 'test failure',
    });
  });

  it('does not trigger handlers for other event types', () => {
    const handler = vi.fn();
    bus.on('fts_query_failed', handler);

    bus.emitError('embedding_failed', 'wrong type');

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports onAny for global handlers', () => {
    const handler = vi.fn();
    bus.onAny(handler);

    bus.emitError('embedding_failed', 'first');
    bus.emitError('fts_query_failed', 'second');

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('returns unsubscribe function from on()', () => {
    const handler = vi.fn();
    const unsub = bus.on('embedding_failed', handler);

    bus.emitError('embedding_failed', 'before unsub');
    unsub();
    bus.emitError('embedding_failed', 'after unsub');

    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns unsubscribe function from onAny()', () => {
    const handler = vi.fn();
    const unsub = bus.onAny(handler);

    bus.emitError('embedding_failed', 'before');
    unsub();
    bus.emitError('embedding_failed', 'after');

    expect(handler).toHaveBeenCalledOnce();
  });

  it('includes nodeId and error when provided', () => {
    const handler = vi.fn();
    bus.on('embedding_failed', handler);

    const testError = new Error('test');
    bus.emitError('embedding_failed', 'with opts', {
      nodeId: 'node-123',
      error: testError,
    });

    const event: MemoryEvent = handler.mock.calls[0][0];
    expect(event.nodeId).toBe('node-123');
    expect(event.error).toBe(testError);
    expect(event.timestamp).toBeTruthy();
  });

  it('does not propagate handler errors', () => {
    const throwingHandler = () => { throw new Error('handler error'); };
    const normalHandler = vi.fn();

    bus.on('embedding_failed', throwingHandler);
    bus.on('embedding_failed', normalHandler);

    // Should not throw
    expect(() => bus.emitError('embedding_failed', 'test')).not.toThrow();
    expect(normalHandler).toHaveBeenCalledOnce();
  });

  it('clear removes all handlers', () => {
    const handler = vi.fn();
    bus.on('embedding_failed', handler);
    bus.onAny(handler);

    bus.clear();
    bus.emitError('embedding_failed', 'after clear');

    expect(handler).not.toHaveBeenCalled();
  });
});

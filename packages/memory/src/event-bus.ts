/**
 * Memory system event bus for observable error handling.
 *
 * Replaces silent catches with event emission so that loggers and
 * UI status indicators can react to failures without blocking
 * the memory pipeline.
 */

/** Event types emitted by the memory subsystem. */
export type MemoryEventType =
  | 'embedding_failed'
  | 'fts_query_failed'
  | 'reflection_failed'
  | 'extraction_failed'
  | 'vector_search_fallback';

/** Payload carried by every memory event. */
export interface MemoryEvent {
  type: MemoryEventType;
  message: string;
  nodeId?: string;
  error?: Error;
  timestamp: string;
}

/** Handler function signature for memory events. */
export type MemoryEventHandler = (event: MemoryEvent) => void;

/**
 * Simple synchronous event bus for the memory system.
 *
 * Listeners are invoked synchronously so that logging happens
 * immediately, but handlers should not throw — a throwing handler
 * is caught and silently ignored to prevent cascading failures.
 */
export class MemoryEventBus {
  private readonly handlers = new Map<MemoryEventType, Set<MemoryEventHandler>>();
  private readonly globalHandlers = new Set<MemoryEventHandler>();

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on(type: MemoryEventType, handler: MemoryEventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    const captured = set;
    return () => captured.delete(handler);
  }

  /** Subscribe to all event types. Returns an unsubscribe function. */
  onAny(handler: MemoryEventHandler): () => void {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
  }

  /** Emit an event to all matching handlers. */
  emit(event: MemoryEvent): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(event);
        } catch {
          // Handler errors must not propagate
        }
      }
    }
    for (const handler of this.globalHandlers) {
      try {
        handler(event);
      } catch {
        // Handler errors must not propagate
      }
    }
  }

  /** Convenience: emit a typed event with auto-timestamp. */
  emitError(
    type: MemoryEventType,
    message: string,
    opts?: { nodeId?: string; error?: Error },
  ): void {
    this.emit({
      type,
      message,
      nodeId: opts?.nodeId,
      error: opts?.error,
      timestamp: new Date().toISOString(),
    });
  }

  /** Remove all handlers. Useful for testing. */
  clear(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }
}

/** Singleton instance shared across the memory subsystem. */
let _instance: MemoryEventBus | null = null;

/** Get the global MemoryEventBus singleton. */
export function getMemoryEventBus(): MemoryEventBus {
  if (!_instance) {
    _instance = new MemoryEventBus();
  }
  return _instance;
}

/** Replace the global event bus (for testing). */
export function setMemoryEventBus(bus: MemoryEventBus): void {
  _instance = bus;
}

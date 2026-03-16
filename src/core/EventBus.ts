import type { EventBus, EventMap, Unsubscribe } from '../types';

export class StrictEventBus<TEvents extends EventMap> implements EventBus<TEvents> {
  private handlers = new Map<keyof TEvents, Set<(payload: TEvents[keyof TEvents]) => void>>();

  on<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: TEvents[keyof TEvents]) => void);
    this.handlers.set(event, set);
    return () => this.off(event, handler);
  }

  once<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): Unsubscribe {
    const wrap = (payload: TEvents[K]) => {
      this.off(event, wrap);
      handler(payload);
    };
    return this.on(event, wrap);
  }

  off<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler as (payload: TEvents[keyof TEvents]) => void);
    if (set.size === 0) this.handlers.delete(event);
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // stable iteration even if a handler mutates subscription
    [...set].forEach((h) => h(payload));
  }

  clear(): void {
    this.handlers.clear();
  }
}


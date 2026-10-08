/**
 * Minimal typed event emitter used internally by the Encatch SDK.
 * Avoids any external runtime dependency.
 */
type Listener<T> = (payload: T) => void;

export class TypedEmitter<Events extends Record<string, any>> {
  private _listeners: Partial<{ [K in keyof Events]: Array<Listener<Events[K]>> }> = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event]!.push(listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const listeners = this._listeners[event];
    if (!listeners) return;
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const listeners = this._listeners[event];
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  removeAllListeners<K extends keyof Events>(event?: K): void {
    if (event) {
      this._listeners[event] = [];
    } else {
      this._listeners = {};
    }
  }
}

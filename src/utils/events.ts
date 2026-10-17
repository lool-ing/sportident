// Authored for lool. Not ported from upstream.
// Replacement for upstream utils/events.ts; no upstream code copied.
// Upstream uses a typed EventTarget polyfill (`SiExternalApplicationEvent`,
// `SiExternalApplicationEventTarget`, etc.). On Node 22+ we get the same shape
// for less code by re-exporting node:events and adding a TypedEventEmitter
// helper.
// See NOTICE.md for cumulative attribution.

export { EventEmitter } from 'node:events';

/**
 * Typed helper that constrains `on`/`emit`/`off` to a declared event map.
 * Usage:
 *   type StationEvents = {
 *     card_inserted: (cardNumber: number) => void;
 *     frame_error: (err: FrameError) => void;
 *   };
 *   class Station extends (EventEmitter as new () => TypedEventEmitter<StationEvents>) {}
 *
 * We intentionally keep this as an interface (not a class) so consumers can
 * pick their own runtime emitter (node:events, a fake, a test spy).
 */
export interface TypedEventEmitter<EventMap extends Record<string, (...args: never[]) => void>> {
  on<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
  off<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
  once<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
  emit<E extends keyof EventMap>(event: E, ...args: Parameters<EventMap[E]>): boolean;
}

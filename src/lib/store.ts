// Minimal external store for high-frequency values (live prediction ~10/s, fps): components
// subscribe with useStore() so only the small widget that shows the value re-renders, not the
// whole page.
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(v: T): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v) {
      if (Object.is(v, value)) return;
      value = v;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

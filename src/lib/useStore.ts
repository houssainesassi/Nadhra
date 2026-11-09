// React binding for a Store (src/lib/store.ts).
import { useSyncExternalStore } from "react";
import type { Store } from "./store.ts";

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

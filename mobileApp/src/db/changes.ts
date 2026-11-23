/** Tiny change feed so screens re-read the local DB when it changes. */
type Listener = (peerIds: Set<string>) => void;
const listeners = new Set<Listener>();

export function onDbChange(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function emitDbChange(peerIds: Iterable<string>) {
  const set = new Set(peerIds);
  for (const l of listeners) l(set);
}

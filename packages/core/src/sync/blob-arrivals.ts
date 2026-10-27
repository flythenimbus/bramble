// "An attachment arrived from another device", for whoever cares in this JS context: a backup
// waiting for that file can run now rather than at its next trigger, and a screen showing the
// file as missing can look again. Its own module so sync (which hears it) and backup or the UI
// (which act on it) need not import each other.

const listeners = new Set<() => void>();

export function onBlobArrived(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function blobArrived(): void {
	for (const cb of listeners) cb();
}

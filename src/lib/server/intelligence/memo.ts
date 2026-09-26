// The fleet baselines, memoised in-process (plan §3, phase 1). A baseline is the same for every
// player in a scope, so one read serves every dossier opened in the next ten minutes. The key
// holds everything the numbers depend on except the clock (sorted servers, windows, filters,
// cutoffs, algorithm version), and the value carries the window it was read over, so callers
// exclude the subject over exactly that window. A stats purge clears it (server/stats.ts).
// Per process: with several web replicas each keeps its own, and a purge clears only its own.

export const FLEET_TTL_MS = 10 * 60_000;
/** Distinct scopes held at once; the oldest goes first. A value is a few hundred cells at most. */
const MAX_ENTRIES = 32;

interface Entry {
	at: number;
	value: Promise<unknown>;
}
const entries = new Map<string, Entry>();

/**
 * The value under `key`, computing it when absent or older than the TTL. Concurrent callers
 * share one computation; a failed one is forgotten so the next caller tries again.
 */
export function memoise<T>(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
	const hit = entries.get(key);
	if (hit && now - hit.at < FLEET_TTL_MS) return hit.value as Promise<T>;
	entries.delete(key);
	const value = compute();
	entries.set(key, { at: now, value });
	while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
	value.catch(() => {
		if (entries.get(key)?.value === value) entries.delete(key);
	});
	return value;
}

/**
 * Forgets every baseline. The purge calls this after its transaction commits, so anything read
 * before it is dropped and anything computed after it reads the purged tables.
 */
export function clearFleetMemo(): void {
	entries.clear();
}

export const memoSize = (): number => entries.size;

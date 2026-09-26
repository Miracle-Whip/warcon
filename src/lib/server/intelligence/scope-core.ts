// The pure part of an intelligence scope (plan §5 "Scope"): the servers a reader holds
// intelligence read on, intersected with an optional requested filter. No database.

export interface ScopeServer {
	id: string;
	name: string;
}

export type ScopeResult = { ok: true; servers: ScopeServer[] } | { ok: false; forbidden: string[] };

/** By name, then id, so the scope reads the same on every request. */
export const sortScope = (list: ScopeServer[]): ScopeServer[] =>
	[...list].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));

/**
 * Every permitted server, or just the requested ones. A requested id outside the permitted set is
 * refused rather than dropped: a caller must not be able to probe or silently narrow past it.
 */
export function resolveScope(permitted: ScopeServer[], requested: string[] | null): ScopeResult {
	const byId = new Map(permitted.map((s) => [s.id, s]));
	if (!requested || !requested.length) return { ok: true, servers: sortScope(permitted) };
	const wanted = [...new Set(requested)];
	const forbidden = wanted.filter((id) => !byId.has(id));
	if (forbidden.length) return { ok: false, forbidden };
	return { ok: true, servers: sortScope(wanted.map((id) => byId.get(id)!)) };
}

/** `?servers=a,b` as a list, or null when absent; capped so a query cannot grow without bound. */
export function parseServerFilter(raw: string | null): string[] | null {
	if (raw === null) return null;
	const ids = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 100);
	return ids.length ? ids : null;
}

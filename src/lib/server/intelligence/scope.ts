// Which servers an intelligence read may cover. Computed on every request: cache identity never
// replaces authorization (plan §5, §6).
import type { Env } from '../env';
import { ApiError } from '../http';
import { accessibleServers, type ServerRow, type SessionUser } from '../access';
import { resolveScope, sortScope, type ScopeServer } from './scope-core';

export const READ = 'players.intelligence.read' as const;

/**
 * The anchor server's organisation, narrowed to the servers where the reader holds intelligence
 * read, then to `requested` when given. The caller has already checked the capability on the
 * anchor itself (requireServerCap), so the result is never empty.
 */
export async function intelligenceScope(
	env: Env,
	user: SessionUser,
	anchor: ServerRow,
	requested: string[] | null
): Promise<{ servers: ScopeServer[]; permitted: ScopeServer[] }> {
	const permitted = (await accessibleServers(env, user, anchor.orgId))
		.filter((s) => s.orgId === anchor.orgId && s.caps.includes(READ))
		.map((s) => ({ id: s.id, name: s.name }));
	const scope = resolveScope(permitted, requested);
	if (!scope.ok)
		throw new ApiError(403, 'The requested intelligence scope is not available.', 'forbidden');
	return { servers: scope.servers, permitted: sortScope(permitted) };
}

// A player's intelligence page as JSON: comparisons with other players, bursts and review priority
// across the organisation's servers where the caller holds intelligence read. `?servers=a,b`
// narrows the scope (each must be permitted); `?sessions=N` pages the session history.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { requireSteamId } from '$lib/server/steam';
import { intelligenceQuery, loadIntelligence } from '$lib/server/intelligence/dossier';

export const GET = route(async (event) => {
	const env = getEnv();
	requireUser(event.locals);
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'players.intelligence.read'
	);
	const steamId = requireSteamId(param(event, 'steamId'));
	const intelligence = await loadIntelligence(
		env,
		user,
		server,
		steamId,
		intelligenceQuery(event.url)
	);
	return apiJson({ ok: true, intelligence });
});

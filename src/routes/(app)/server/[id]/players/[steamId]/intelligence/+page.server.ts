import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireServerCap, requireUser } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { intelligenceQuery, loadIntelligence } from '$lib/server/intelligence/dossier';

/**
 * Checked here, not left to the server layout: a page's data can be asked for without its
 * layouts (SvelteKit's __data.json). Intelligence read on this server opens the page; the numbers
 * cover only the organisation's servers where the reader holds it too.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const env = getEnv();
	try {
		requireUser(locals);
		const { server, user } = await requireServerCap(
			env,
			locals,
			params.id,
			'players.intelligence.read'
		);
		if (!/^\d{17}$/.test(params.steamId)) error(404, 'Not a SteamID64.');
		const intelligence = await loadIntelligence(
			env,
			user,
			server,
			params.steamId,
			intelligenceQuery(url)
		);
		return { intelligence };
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};

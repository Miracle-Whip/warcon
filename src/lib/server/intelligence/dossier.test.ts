// The intelligence page against a real database: the SQL filters and per-weapon totals agree with
// the pure analysis, the subject leaves the peers, a player on two servers counts once, a kill with
// no linked match is compared like any other (plan R11), the scope follows
// the capability, and a stats purge drops the memoised baselines. Skipped without
// TEST_DATABASE_URL, like the other database suites.
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	kills,
	matches,
	matchPlayers,
	orgRoles,
	playerSessions,
	servers
} from '$lib/server/db/schema';
import { BUILTIN_CAPABILITIES } from '$lib/capabilities';
import type { IntelligenceView } from '$lib/intelligence/types';
import { hasTestDb, testEnv } from '../../../test/db';
import { callApi, stubGateway } from '../../../test/call';
import { seedWorld, type World } from '../../../test/world';
import { GET } from '../../../routes/api/servers/[id]/players/[steamId]/intelligence/+server';
import { purgeServerStats } from '../stats';
import { clearFleetMemo, memoSize } from './memo';

const SUBJECT = '76561198000000701';
const PEER = '76561198000000702';
const OTHER = '76561198000000703';
const M4 = 'Id.Item.M4';
const MOSIN = 'Id.Item.Mosin';
const SKS = 'Id.Item.SKS';

describe.skipIf(!hasTestDb)('player intelligence', () => {
	let env: Env;
	let w: World;
	const now = Date.now();
	const base = now - 3600_000;
	let seq = 0;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		clearFleetMemo();
		w = await seedWorld(env);
		const open = async (serverId: string) => {
			const [m] = await env.db
				.insert(matches)
				.values({
					serverId,
					startedAt: new Date(now - 2 * 3600_000),
					map: 'Europe'
				})
				.returning({ id: matches.id });
			return m.id;
		};
		const here = await open(w.server.id);
		const there = await open(w.otherServer.id);
		const [ended] = await env.db
			.insert(matches)
			.values({
				serverId: w.server.id,
				startedAt: new Date(now - 5 * 3600_000),
				endedAt: new Date(now - 4 * 3600_000),
				map: 'Europe'
			})
			.returning({ id: matches.id });
		await env.db
			.insert(matchPlayers)
			.values({ matchId: ended.id, serverId: w.server.id, steamId: SUBJECT, name: 's', kills: 5 });
		await env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId: SUBJECT,
			name: 'Subject',
			faction: 'A',
			joinedAt: new Date(now - 90 * 60_000),
			lastSeen: new Date(now)
		});

		const k = (o: Partial<typeof kills.$inferInsert> & { killerSteamId: string }) => {
			seq++;
			return {
				ts: new Date(base + seq * 1000),
				serverId: w.server.id,
				eventId: `intel-${seq}`,
				instanceId: 'boot-1',
				matchId: 'g',
				matchRow: here,
				eventTime: 100 + seq,
				map: 'Europe',
				killerName: 'k',
				killerFaction: 'A',
				victimSteamId: `765611980000019${String(seq).padStart(2, '0')}`,
				victimName: 'v',
				victimFaction: 'B',
				cause: M4,
				distanceM: 50,
				tags: [],
				...o
			};
		};
		await env.db.insert(kills).values([
			// the subject: 3 M4 kills (2 headshots), 2 Mosin kills (one beyond the sniper cutoff)
			k({ killerSteamId: SUBJECT, headshot: true }),
			k({ killerSteamId: SUBJECT, headshot: true }),
			k({ killerSteamId: SUBJECT }),
			k({ killerSteamId: SUBJECT, cause: MOSIN, distanceM: 310, headshot: true }),
			k({ killerSteamId: SUBJECT, cause: MOSIN, distanceM: 250 }),
			// a map the open match is not on, and a kill from before the match: compared all the same
			k({ killerSteamId: SUBJECT, map: 'Dunes' }),
			k({ killerSteamId: SUBJECT, ts: new Date(now - 3 * 3600_000) }),
			// the only SKS kills, neither linked to a match: one the subject's, one a peer's
			k({ killerSteamId: SUBJECT, cause: SKS, matchRow: null }),
			k({ killerSteamId: PEER, cause: SKS, matchRow: null, headshot: true }),
			// a team kill and a suicide
			k({ killerSteamId: SUBJECT, victimFaction: 'A', teamKill: true }),
			k({ killerSteamId: SUBJECT, victimSteamId: SUBJECT, suicide: true }),
			// one peer on both servers: 2 kills (1 headshot) here, 2 there
			k({ killerSteamId: PEER, headshot: true }),
			k({ killerSteamId: PEER }),
			k({ killerSteamId: PEER, serverId: w.otherServer.id, matchRow: there }),
			k({ killerSteamId: PEER, serverId: w.otherServer.id, matchRow: there }),
			// everything the filters leave out of the fleet
			k({ killerSteamId: OTHER, headshot: true, victimFaction: 'A', teamKill: true }),
			k({ killerSteamId: OTHER, headshot: true, victimFaction: null }),
			k({ killerSteamId: OTHER, headshot: true, cause: 'Id.Item.M67Grenade' }),
			// ...and one they keep, on a map the match is not on: a second M4 peer
			k({ killerSteamId: OTHER, headshot: true, map: 'Dunes' })
		]);
	});

	const read = async (who: keyof World['users'], query?: string) => {
		const r = await callApi(GET, w.users[who], {
			params: { id: w.server.id, steamId: SUBJECT },
			query
		});
		return { ...r, view: (r.body as { intelligence?: IntelligenceView })?.intelligence };
	};

	test('only intelligence read opens it', async () => {
		expect((await read('anon')).status).toBe(401);
		expect((await read('viewer')).status).toBe(403);
		expect((await read('elsewhere')).status).toBe(404);
		expect((await read('outsider')).status).toBe(404);
		expect((await read('owner')).status).toBe(200);
		// the built-in admin does not hold it: an owner grants it (plan R4)
		expect((await read('admin')).status).toBe(403);
	});

	test('the peers exclude the subject and count a player on two servers once', async () => {
		const { view } = await read('owner');
		expect(view!.scope.servers.map((s) => s.id).sort()).toEqual(
			[w.server.id, w.otherServer.id].sort()
		);
		// one M4 row for every mode and map: the subject's 5 (2 headshots), and 5 others' kills by
		// PEER (4, on both servers, counted once) and OTHER (1, on another map)
		const m4 = view!.weapons.filter((r) => r.weapon === M4);
		expect(m4.length).toBe(1);
		expect(m4[0].subject).toEqual({ kills: 5, headshots: 2 });
		expect(m4[0].peers).toEqual({ kills: 5, headshots: 2, players: 2 });
	});

	test('the long-range cutoff in SQL is the weapon class one, as in the analysis', async () => {
		const { view } = await read('owner');
		const mosin = view!.weapons.find((r) => r.weapon === MOSIN)!;
		expect(mosin.longRange).toMatchObject({
			enabled: true,
			distanceM: 300,
			subject: { kills: 1, headshots: 1 },
			peers: { kills: 0, headshots: 0, players: 0 }
		});
		expect(view!.kpis.longRange).toEqual({ kills: 1, headshots: 1 });
	});

	test('a kill with no linked match counts toward both the subject and the peer baseline', async () => {
		const { view } = await read('owner');
		const sks = view!.weapons.find((r) => r.weapon === SKS)!;
		expect(sks.subject).toEqual({ kills: 1, headshots: 0 });
		expect(sks.peers).toEqual({ kills: 1, headshots: 1, players: 1 });
	});

	test('only the filters leave kills out, and they are counted', async () => {
		const { view } = await read('owner');
		expect(view!.coverage.excluded).toEqual({ unscored: 0, teamKill: 1, enemyUnknown: 0 });
		expect(view!.kpis.killsOnRecord).toBe(9);
		expect(view!.kpis.eligible.kills).toBe(8);
		expect(view!.coverage.eligibleKills).toBe(8);
	});

	test('history comes from sessions and recorded matches', async () => {
		const { view } = await read('owner');
		expect(view!.presence.state).toBe('online');
		expect(view!.kpis.recorded).toEqual({ kills: 5, deaths: 0, matches: 1 });
		expect(view!.sessions.total).toBe(1);
		expect(view!.sessions.rows[0].maps).toContain('Europe');
	});

	test('a reader with intelligence on one server sees that server only', async () => {
		// the owner adds it to the admin role, which `admin` holds on this server alone
		await env.db
			.update(orgRoles)
			.set({ capabilities: [...BUILTIN_CAPABILITIES.admin, 'players.intelligence.read'] })
			.where(eq(orgRoles.id, w.roles.admin));
		const { view } = await read('admin');
		expect(view!.scope.servers.map((s) => s.id)).toEqual([w.server.id]);
		// this server's M4 kills only: PEER's 2 here (1 headshot) and OTHER's 1
		const m4 = view!.weapons.find((r) => r.weapon === M4)!;
		expect(m4.peers).toEqual({ kills: 3, headshots: 2, players: 2 });
		expect((await read('admin', `servers=${w.otherServer.id}`)).status).toBe(403);
		expect((await read('owner', `servers=${w.server.id}`)).view!.scope.servers.length).toBe(1);
	});

	test('a stats purge drops the memoised baselines', async () => {
		await read('owner');
		expect(memoSize()).toBeGreaterThan(0);
		const [row] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		await purgeServerStats(env, new Request('http://localhost/'), w.users.owner!, row);
		expect(memoSize()).toBe(0);
		const { view } = await read('owner', `servers=${w.server.id}`);
		expect(view!.weapons).toEqual([]);
	});
});

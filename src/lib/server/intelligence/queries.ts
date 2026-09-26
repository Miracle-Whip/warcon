// The reads behind a player's intelligence page. Subject reads ride kills_killer_idx and
// kills_victim_idx ((steam_id, ts desc)); the fleet read is one aggregate over the scope's kills
// in the baseline window, memoised (memo.ts). No new tables and no writes (plan §3, phase 1).
import { sql, type SQL } from 'drizzle-orm';
import type { Env } from '../env';
import type { IntelligenceConfig } from '$lib/intelligence/config';
import { longRangeCutoffs, type FleetCell, type SubjectKill } from '$lib/intelligence/analysis';
import type { OpponentView } from '$lib/intelligence/types';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ms = (v: unknown): number => new Date(v as string | Date).getTime();
const iso = (v: unknown): string | null =>
	v === null || v === undefined ? null : new Date(v as string | Date).toISOString();
const at = (t: number) => sql`${new Date(t).toISOString()}::timestamptz`;

/**
 * The recorded match a kill was attached to at receipt, only where that attachment is credible:
 * the same server, the kill inside the match's time (the start is estimated, hence the two
 * minutes upstream allows too) and on the match's map. Burst timing alone reads it, to place a
 * kill on a match clock; it never filters or groups the comparisons (plan R11).
 */
const credibleMatch = sql`
	LEFT JOIN matches m ON m.id = k.match_row AND m.server_id = k.server_id
	 AND k.ts >= m.started_at - interval '120 seconds'
	 AND (m.ended_at IS NULL OR k.ts <= m.ended_at)
	 AND (m.map IS NULL OR m.map = k.map)`;

/** exclusionFilter() in $lib/intelligence/analysis, in SQL: the fleet is filtered as the subject is. */
function eligible(c: IntelligenceConfig): SQL {
	const parts: SQL[] = [
		sql`k.killer_steam_id IS NOT NULL`,
		sql`NOT k.suicide`,
		sql`k.cause IN ${c.filters.scoredWeaponTags}`
	];
	if (c.filters.excludeTeamKills) parts.push(sql`NOT k.team_kill`);
	if (c.filters.requireKnownEnemy)
		parts.push(
			sql`k.killer_faction IS NOT NULL AND k.victim_faction IS NOT NULL AND k.killer_faction <> k.victim_faction`
		);
	return sql.join(parts, sql` AND `);
}

/** Each scored weapon's long-range cutoff as a joinable table (empty when every rule is off). */
function cutoffs(c: IntelligenceConfig): SQL {
	const list = [...longRangeCutoffs(c)];
	const table = list.length
		? sql`(VALUES ${sql.join(
				list.map(([tag, m]) => sql`(${tag}::text, ${m}::real)`),
				sql`, `
			)})`
		: sql`(SELECT NULL::text, NULL::real WHERE false)`;
	return sql`LEFT JOIN ${table} AS lr(tag, dist) ON lr.tag = k.cause`;
}

/**
 * The fleet's per-weapon totals over [from, asOf]: every player, the subject included, grouped by
 * the exact tag alone. No match is joined, so a kill with no linked match counts like any other.
 */
export async function fleetCells(
	env: Env,
	c: IntelligenceConfig,
	serverIds: string[],
	from: number,
	asOf: number
): Promise<FleetCell[]> {
	if (!serverIds.length) return [];
	const rows = await env.db.execute<{
		weapon: string;
		kills: string;
		headshots: string;
		players: string;
		lrKills: string;
		lrHeadshots: string;
		lrPlayers: string;
	}>(sql`
		WITH e AS (
			SELECT k.killer_steam_id AS killer, k.cause AS weapon, k.headshot,
			       (k.distance_m IS NOT NULL AND lr.dist IS NOT NULL AND k.distance_m >= lr.dist) AS lr
			  FROM kills k
			  ${cutoffs(c)}
			 WHERE k.server_id IN ${serverIds} AND k.ts >= ${at(from)} AND k.ts <= ${at(asOf)}
			   AND ${eligible(c)})
		SELECT weapon, COUNT(*) AS kills,
		       COUNT(*) FILTER (WHERE headshot) AS headshots,
		       COUNT(DISTINCT killer) AS players,
		       COUNT(*) FILTER (WHERE lr) AS "lrKills",
		       COUNT(*) FILTER (WHERE lr AND headshot) AS "lrHeadshots",
		       COUNT(DISTINCT killer) FILTER (WHERE lr) AS "lrPlayers"
		  FROM e
		 GROUP BY weapon`);
	return rows.map((r) => ({
		weapon: r.weapon,
		kills: num(r.kills),
		headshots: num(r.headshots),
		players: num(r.players),
		lrKills: num(r.lrKills),
		lrHeadshots: num(r.lrHeadshots),
		lrPlayers: num(r.lrPlayers)
	}));
}

/** Most rows of the subject's own kills read at once; past it the page says so and withholds comparisons. */
export const SUBJECT_ROW_LIMIT = 20_000;

/** The subject's kills (not suicides) received since `from`, newest first. */
export async function subjectKills(
	env: Env,
	steamId: string,
	serverIds: string[],
	from: number
): Promise<{ rows: SubjectKill[]; clipped: boolean }> {
	if (!serverIds.length) return { rows: [], clipped: false };
	const rows = await env.db.execute<Record<string, unknown>>(sql`
		SELECT k.ts, k.server_id AS "serverId", k.instance_id AS "instanceId",
		       k.match_row AS "matchRow", k.event_time AS "eventTime", k.map, k.cause,
		       k.distance_m AS "distanceM", k.headshot, k.team_kill AS "teamKill",
		       k.killer_faction AS "killerFaction", k.victim_faction AS "victimFaction",
		       k.victim_steam_id AS "victimSteamId", k.victim_name AS "victimName",
		       (m.id IS NOT NULL) AS credible
		  FROM kills k
		  ${credibleMatch}
		 WHERE k.killer_steam_id = ${steamId} AND k.server_id IN ${serverIds}
		   AND NOT k.suicide AND k.ts >= ${at(from)}
		 ORDER BY k.ts DESC
		 LIMIT ${SUBJECT_ROW_LIMIT + 1}`);
	const clipped = rows.length > SUBJECT_ROW_LIMIT;
	return {
		clipped,
		rows: rows.slice(0, SUBJECT_ROW_LIMIT).map((r) => ({
			ts: ms(r.ts),
			serverId: String(r.serverId),
			instanceId: String(r.instanceId ?? ''),
			matchRow: numOrNull(r.matchRow),
			credible: r.credible === true || r.credible === 't',
			eventTime: Number(r.eventTime),
			map: String(r.map ?? ''),
			cause: (r.cause as string | null) ?? null,
			distanceM: numOrNull(r.distanceM),
			headshot: r.headshot === true || r.headshot === 't',
			teamKill: r.teamKill === true || r.teamKill === 't',
			killerFaction: (r.killerFaction as string | null) ?? null,
			victimFaction: (r.victimFaction as string | null) ?? null,
			victimSteamId: String(r.victimSteamId),
			victimName: String(r.victimName ?? '')
		}))
	};
}

/** "Who kills them": the players who killed the subject since `from`, most kills first. */
export async function subjectKillers(
	env: Env,
	steamId: string,
	serverIds: string[],
	from: number,
	limit = 10
): Promise<OpponentView[]> {
	if (!serverIds.length) return [];
	const rows = await env.db.execute<{
		steamId: string;
		name: string | null;
		kills: string;
		headshots: string;
		avgDistance: string | null;
	}>(sql`
		SELECT killer_steam_id AS "steamId", (array_agg(killer_name ORDER BY ts DESC))[1] AS name,
		       COUNT(*) AS kills, COUNT(*) FILTER (WHERE headshot) AS headshots,
		       AVG(distance_m) AS "avgDistance"
		  FROM kills
		 WHERE victim_steam_id = ${steamId} AND server_id IN ${serverIds}
		   AND killer_steam_id IS NOT NULL AND NOT suicide AND ts >= ${at(from)}
		 GROUP BY killer_steam_id
		 ORDER BY kills DESC, headshots DESC, killer_steam_id
		 LIMIT ${limit}`);
	return rows.map((r) => ({
		steamId: r.steamId,
		name: r.name ?? '',
		kills: num(r.kills),
		headshots: num(r.headshots),
		avgDistanceM: r.avgDistance === null ? null : Math.round(num(r.avgDistance))
	}));
}

/** Feed kills (not suicides) on record in scope, all time. */
export async function killsOnRecord(
	env: Env,
	steamId: string,
	serverIds: string[]
): Promise<number> {
	if (!serverIds.length) return 0;
	const [row] = await env.db.execute<{ n: string }>(sql`
		SELECT COUNT(*) AS n FROM kills
		 WHERE killer_steam_id = ${steamId} AND server_id IN ${serverIds} AND NOT suicide`);
	return num(row?.n);
}

/** The game's scoreboard counters over the recorded matches that ended, as careers count them. */
export async function recordedMatches(
	env: Env,
	steamId: string,
	serverIds: string[]
): Promise<{ kills: number; deaths: number; matches: number }> {
	if (!serverIds.length) return { kills: 0, deaths: 0, matches: 0 };
	const [row] = await env.db.execute<{ matches: string; kills: string; deaths: string }>(sql`
		SELECT COUNT(*) AS matches, COALESCE(SUM(p.kills), 0) AS kills,
		       COALESCE(SUM(p.deaths), 0) AS deaths
		  FROM match_players p JOIN matches m ON m.id = p.match_id AND m.server_id = p.server_id
		 WHERE p.steam_id = ${steamId} AND p.server_id IN ${serverIds} AND m.ended_at IS NOT NULL`);
	return { kills: num(row?.kills), deaths: num(row?.deaths), matches: num(row?.matches) };
}

export interface PresenceRow {
	name: string | null;
	sessions: number;
	/** join to last observation, summed: a stay the poller lost track of stops at its last look */
	observedMinutes: number;
	firstSeen: string | null;
	lastSeen: string | null;
	open: { serverId: string; lastSeen: string } | null;
}

export async function presence(
	env: Env,
	steamId: string,
	serverIds: string[]
): Promise<PresenceRow> {
	if (!serverIds.length)
		return {
			name: null,
			sessions: 0,
			observedMinutes: 0,
			firstSeen: null,
			lastSeen: null,
			open: null
		};
	const [[summary], [latest], [open]] = await Promise.all([
		env.db.execute<{
			sessions: string;
			minutes: string | null;
			firstSeen: unknown;
			lastSeen: unknown;
		}>(sql`
			SELECT COUNT(*) AS sessions,
			       SUM(GREATEST(0, EXTRACT(EPOCH FROM (last_seen - joined_at)))) / 60 AS minutes,
			       MIN(joined_at) AS "firstSeen", MAX(last_seen) AS "lastSeen"
			  FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${serverIds}`),
		env.db.execute<{ name: string }>(sql`
			SELECT name FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${serverIds}
			 ORDER BY last_seen DESC LIMIT 1`),
		env.db.execute<{ serverId: string; lastSeen: unknown }>(sql`
			SELECT server_id AS "serverId", last_seen AS "lastSeen" FROM player_sessions
			 WHERE steam_id = ${steamId} AND server_id IN ${serverIds} AND left_at IS NULL
			 ORDER BY last_seen DESC LIMIT 1`)
	]);
	return {
		name: latest?.name || null,
		sessions: num(summary?.sessions),
		observedMinutes: Math.round(num(summary?.minutes)),
		firstSeen: iso(summary?.firstSeen),
		lastSeen: iso(summary?.lastSeen),
		open: open ? { serverId: open.serverId, lastSeen: iso(open.lastSeen)! } : null
	};
}

export interface SessionRow {
	id: number;
	serverId: string;
	name: string;
	faction: string | null;
	joinedAt: string;
	lastSeen: string;
	leftAt: string | null;
	kills: number;
	deaths: number;
	maps: string[];
}

/** One page of the subject's stays, newest first, each with the maps of the matches it overlapped. */
export async function sessionPage(
	env: Env,
	steamId: string,
	serverIds: string[],
	page: number,
	pageSize: number
): Promise<SessionRow[]> {
	if (!serverIds.length) return [];
	const rows = await env.db.execute<Record<string, unknown>>(sql`
		SELECT s.id, s.server_id AS "serverId", s.name, s.faction, s.joined_at AS "joinedAt",
		       s.last_seen AS "lastSeen", s.left_at AS "leftAt", s.kills, s.deaths,
		       COALESCE((SELECT json_agg(x.map ORDER BY x.started_at) FROM (
		           SELECT mm.map, mm.started_at FROM matches mm
		            WHERE mm.server_id = s.server_id AND mm.started_at < s.last_seen
		              AND (mm.ended_at IS NULL OR mm.ended_at > s.joined_at)
		            ORDER BY mm.started_at LIMIT 12) x), '[]'::json) AS maps
		  FROM player_sessions s
		 WHERE s.steam_id = ${steamId} AND s.server_id IN ${serverIds}
		 ORDER BY s.last_seen DESC, s.id DESC
		 LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
	return rows.map((r) => {
		const raw = typeof r.maps === 'string' ? JSON.parse(r.maps) : r.maps;
		return {
			id: num(r.id),
			serverId: String(r.serverId),
			name: String(r.name ?? ''),
			faction: (r.faction as string | null) ?? null,
			joinedAt: iso(r.joinedAt)!,
			lastSeen: iso(r.lastSeen)!,
			leftAt: iso(r.leftAt),
			kills: num(r.kills),
			deaths: num(r.deaths),
			maps: Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string' && !!m) : []
		};
	});
}

/** How many of these servers have a kill feed set up. */
export async function feedServerCount(env: Env, serverIds: string[]): Promise<number> {
	if (!serverIds.length) return 0;
	const [row] = await env.db.execute<{ n: string }>(sql`
		SELECT COUNT(*) AS n FROM servers WHERE id IN ${serverIds} AND feed_token_hash IS NOT NULL`);
	return num(row?.n);
}

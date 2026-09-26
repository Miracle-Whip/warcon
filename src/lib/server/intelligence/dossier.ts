// A player's intelligence page, computed on demand from existing tables (plan §3, phase 1): the
// scope the reader may see, the fleet baseline (memoised), the subject's own rows, and the pure
// analysis over them. Read-only: no writes, no game requests, and nothing here reaches the
// connect-risk score or its kick rule.
import { createHash } from 'node:crypto';
import type { Env } from '../env';
import { int } from '../http';
import type { ServerRow, SessionUser } from '../access';
import { analyse, longRangeCutoffs, type FleetCell } from '$lib/intelligence/analysis';
import type { IntelligenceConfig } from '$lib/intelligence/config';
import { presenceOf } from '$lib/intelligence/format';
import { ALGORITHM_VERSION } from '$lib/intelligence/score';
import type { IntelligenceView } from '$lib/intelligence/types';
import { memoise } from './memo';
import {
	feedServerCount,
	fleetCells,
	killsOnRecord,
	presence,
	recordedMatches,
	sessionPage,
	subjectKillers,
	subjectKills
} from './queries';
import { intelligenceScope } from './scope';
import { parseServerFilter } from './scope-core';
import { effectiveConfig } from './settings';

const DAY_MS = 86400_000;

export interface IntelligenceQuery {
	/** narrow the scope to these servers (each must be permitted) */
	servers: string[] | null;
	/** 1-based page of the session history */
	sessionsPage: number;
}

/** `?servers=a,b&sessions=2`, as the page and the API both take it. */
export function intelligenceQuery(url: URL): IntelligenceQuery {
	return {
		servers: parseServerFilter(url.searchParams.get('servers')),
		sessionsPage: int(url.searchParams.get('sessions'), 1, 1, 1000)
	};
}

export interface FleetBaseline {
	/** the window it was read over, ms */
	from: number;
	asOf: number;
	cells: FleetCell[];
}

/** Everything a fleet baseline depends on except the clock: its memo key. */
export function fleetKey(c: IntelligenceConfig, serverIds: string[]): string {
	const identity = {
		algorithmVersion: ALGORITHM_VERSION,
		serverIds: [...new Set(serverIds)].sort(),
		lookbackDays: c.baseline.lookbackDays,
		sinceUtc: c.baseline.sinceUtc,
		cohort: c.baseline.cohort,
		requireKnownEnemy: c.filters.requireKnownEnemy,
		excludeTeamKills: c.filters.excludeTeamKills,
		scored: [...c.filters.scoredWeaponTags].sort(),
		cutoffs: [...longRangeCutoffs(c)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	};
	return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** The baseline window ending now: the lookback, or the owner's baseline start if later. */
export function baselineFrom(c: IntelligenceConfig, now: number): number {
	const since = c.baseline.sinceUtc ? Date.parse(c.baseline.sinceUtc) : -Infinity;
	return Math.max(now - c.baseline.lookbackDays * DAY_MS, since);
}

export function fleetBaseline(
	env: Env,
	c: IntelligenceConfig,
	serverIds: string[],
	now: number
): Promise<FleetBaseline> {
	return memoise(
		fleetKey(c, serverIds),
		async () => {
			const from = baselineFrom(c, now);
			return { from, asOf: now, cells: await fleetCells(env, c, serverIds, from, now) };
		},
		now
	);
}

export async function loadIntelligence(
	env: Env,
	user: SessionUser,
	anchor: ServerRow,
	steamId: string,
	query: IntelligenceQuery,
	nowDate = new Date()
): Promise<IntelligenceView> {
	const now = nowDate.getTime();
	const { config: c, source, revision } = effectiveConfig();
	const scope = await intelligenceScope(env, user, anchor, query.servers);
	const ids = scope.servers.map((s) => s.id);
	const nameOf = new Map(scope.permitted.map((s) => [s.id, s.name]));

	const scoring = { from: now - c.lookbackDays * DAY_MS, to: now };
	const fleet = await fleetBaseline(env, c, ids, now);
	// Far enough back for the scoring window and the subject's share of the baseline alike.
	const history = { from: Math.min(scoring.from, fleet.from), to: now };
	const pageSize = c.display.sessionPageSize;

	const [subject, killers, onRecord, recorded, seen, sessions, feedServers] = await Promise.all([
		subjectKills(env, steamId, ids, history.from),
		subjectKillers(env, steamId, ids, history.from),
		killsOnRecord(env, steamId, ids),
		recordedMatches(env, steamId, ids),
		presence(env, steamId, ids),
		sessionPage(env, steamId, ids, query.sessionsPage, pageSize),
		feedServerCount(env, ids)
	]);
	const a = analyse({
		config: c,
		kills: subject.rows,
		fleet,
		scoring,
		history,
		clipped: subject.clipped
	});

	return {
		steamId,
		name: seen.name || steamId,
		generatedAt: nowDate.toISOString(),
		algorithmVersion: ALGORITHM_VERSION,
		settings: {
			source,
			revision,
			mode: c.mode,
			cohort: c.baseline.cohort,
			requireKnownEnemy: c.filters.requireKnownEnemy,
			excludeTeamKills: c.filters.excludeTeamKills,
			minPeerKills: c.baseline.minPeerKills,
			minPeerPlayers: c.baseline.minPeerPlayers,
			minComparableCoveragePct: c.baseline.minComparableCoveragePct,
			thresholds: c.thresholds,
			burst: {
				windowSeconds: c.rules.burst.windowSeconds,
				minKills: c.rules.burst.minKills,
				minDistinctVictims: c.rules.burst.minDistinctVictims
			}
		},
		scope: { servers: scope.servers, permitted: scope.permitted, feedServers },
		windows: {
			scoring: {
				from: new Date(scoring.from).toISOString(),
				to: nowDate.toISOString(),
				days: c.lookbackDays
			},
			baseline: {
				from: new Date(fleet.from).toISOString(),
				to: new Date(fleet.asOf).toISOString(),
				days: c.baseline.lookbackDays,
				sinceUtc: c.baseline.sinceUtc
			}
		},
		presence: presenceOf(
			seen.open
				? {
						serverId: seen.open.serverId,
						serverName: nameOf.get(seen.open.serverId) || seen.open.serverId,
						lastSeen: seen.open.lastSeen
					}
				: null,
			seen.lastSeen,
			now
		),
		kpis: {
			killsOnRecord: onRecord,
			eligible: a.eligible,
			matched: {
				...a.mix.matched,
				expectedPct: a.mix.expectedPct,
				coveragePct: a.mix.coveragePct
			},
			longRange: a.longRange,
			burst: a.burst,
			recorded,
			sessions: seen.sessions,
			observedMinutes: seen.observedMinutes,
			firstSeen: seen.firstSeen
		},
		weapons: a.weapons,
		unscored: a.unscored,
		coverage: {
			eligibleKills: a.mix.eligibleKills,
			matchedKills: a.mix.matched.kills,
			unknownModeKills: a.mix.unknownModeKills,
			knownDistanceKills: a.knownDistanceKills,
			excluded: a.excluded,
			clipped: subject.clipped
		},
		timeline: a.timeline,
		distance: a.distance,
		assessment: a.assessment,
		opponents: { victims: a.victims, killers },
		sessions: {
			rows: sessions.map((s) => ({
				...s,
				serverName: nameOf.get(s.serverId) || s.serverId,
				observedMinutes: Math.max(
					0,
					Math.round((Date.parse(s.lastSeen) - Date.parse(s.joinedAt)) / 60_000)
				)
			})),
			page: query.sessionsPage,
			pageSize,
			total: seen.sessions
		}
	};
}

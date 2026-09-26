// The pure part of a player's intelligence page: which kills are eligible, the subject against
// every other player on the same exact weapon tag, weapon-mix expectations, validated clock
// segments for bursts, and the charts' bins. No database: the server hands in the subject's kill
// rows and the fleet's per-weapon totals, and everything here is unit tested. Definitions follow
// docs/intelligence/plan.md §5, with R11: one cohort, the weapon tag, across every mode and map.
import { weaponRules, type IntelligenceConfig } from './config';
import {
	assessIntelligence,
	maxRollingBurst,
	type Assessment,
	type Comparison,
	type Counts,
	type TimedKill
} from './score';
import { weaponInfo } from './weapons';
import type {
	BurstView,
	DistanceBin,
	OpponentView,
	Requirement,
	RuleView,
	TimelineDay,
	UnscoredWeaponView,
	WeaponRowView
} from './types';

/** One kill by the subject (never a suicide), as the server reads it from the kills table. */
export interface SubjectKill {
	/** receipt time, ms */
	ts: number;
	serverId: string;
	/** the game's per-boot server id */
	instanceId: string;
	matchRow: number | null;
	/**
	 * The match association passed the checks (same server, inside the match's time, same map).
	 * Only burst timing reads it, to place the kill on a match clock; the comparisons never do.
	 */
	credible: boolean;
	/** seconds on the match clock */
	eventTime: number;
	map: string;
	cause: string | null;
	distanceM: number | null;
	headshot: boolean;
	teamKill: boolean;
	killerFaction: string | null;
	victimFaction: string | null;
	victimSteamId: string;
	victimName: string;
}

export type Exclusion = 'unscored' | 'teamKill' | 'enemyUnknown';

/**
 * Why a kill is left out of the comparisons, or null when it counts. The same filters run on the
 * fleet in SQL (server/intelligence), so the subject and the peers are judged alike.
 */
export function exclusionFilter(c: IntelligenceConfig) {
	const scored = new Set(c.filters.scoredWeaponTags);
	return (k: Pick<SubjectKill, 'cause' | 'teamKill' | 'killerFaction' | 'victimFaction'>) => {
		if (!k.cause || !scored.has(k.cause)) return 'unscored' as const;
		if (c.filters.excludeTeamKills && k.teamKill) return 'teamKill' as const;
		// Factions were joined from the sessions at receipt, not reported by the game at the shot.
		if (
			c.filters.requireKnownEnemy &&
			(!k.killerFaction || !k.victimFaction || k.killerFaction === k.victimFaction)
		)
			return 'enemyUnknown' as const;
		return null;
	};
}

/** Each scored tag's long-range cutoff in metres, for the tags whose long-range rule is on. */
export function longRangeCutoffs(c: IntelligenceConfig): Map<string, number> {
	const out = new Map<string, number>();
	for (const tag of c.filters.scoredWeaponTags) {
		const lr = weaponRules(c, tag).longRange;
		if (lr.enabled) out.set(tag, lr.distanceM);
	}
	return out;
}

export interface CellCounts {
	kills: number;
	headshots: number;
	/** kills with a known distance at or beyond the weapon's cutoff */
	lrKills: number;
	lrHeadshots: number;
	knownDistance: number;
}
export interface SubjectCell {
	/** the exact cause tag, as stored */
	weapon: string;
	counts: CellCounts;
}

const blankCounts = (): CellCounts => ({
	kills: 0,
	headshots: 0,
	lrKills: 0,
	lrHeadshots: 0,
	knownDistance: 0
});

/**
 * The subject's eligible kills received in [from, to] (ms, inclusive), by exact weapon tag. Mode,
 * map and whether a match is linked play no part (plan R11).
 */
export function tallyCells(
	c: IntelligenceConfig,
	kills: SubjectKill[],
	range: { from: number; to: number }
): Map<string, SubjectCell> {
	const excluded = exclusionFilter(c);
	const cutoffs = longRangeCutoffs(c);
	const out = new Map<string, SubjectCell>();
	for (const k of kills) {
		if (k.ts < range.from || k.ts > range.to || excluded(k)) continue;
		const weapon = k.cause!; // eligible, so a scored tag
		let cell = out.get(weapon);
		if (!cell) out.set(weapon, (cell = { weapon, counts: blankCounts() }));
		cell.counts.kills++;
		if (k.headshot) cell.counts.headshots++;
		if (k.distanceM !== null) {
			cell.counts.knownDistance++;
			const cutoff = cutoffs.get(weapon);
			if (cutoff !== undefined && k.distanceM >= cutoff) {
				cell.counts.lrKills++;
				if (k.headshot) cell.counts.lrHeadshots++;
			}
		}
	}
	return out;
}

/** The fleet's totals for one weapon tag over the baseline window, every player included. */
export interface FleetCell {
	weapon: string;
	kills: number;
	headshots: number;
	/** distinct killers */
	players: number;
	lrKills: number;
	lrHeadshots: number;
	/** distinct killers with a long-range kill */
	lrPlayers: number;
}

type Peers = Counts & { players: number };

/**
 * Everyone but the subject: the fleet's cell less the subject's own kills in it over the same
 * window, and one fewer player when the subject has any. Exact because `own` is tallied over the
 * very window the fleet was read for; the clamps only guard a kill written between the two reads.
 */
export function peersExcluding(
	fleet: FleetCell | undefined,
	own: CellCounts | undefined
): { peers: Peers; longRange: Peers } {
	const o = own ?? blankCounts();
	const f = fleet ?? {
		kills: 0,
		headshots: 0,
		players: 0,
		lrKills: 0,
		lrHeadshots: 0,
		lrPlayers: 0
	};
	const side = (
		kills: number,
		headshots: number,
		players: number,
		ownKills: number,
		ownHs: number
	) => {
		const k = Math.max(0, kills - ownKills);
		const h = Math.min(k, Math.max(0, headshots - ownHs));
		const p = Math.min(k, Math.max(0, players - (ownKills > 0 ? 1 : 0)));
		return { kills: k, headshots: h, players: p };
	};
	return {
		peers: side(f.kills, f.headshots, f.players, o.kills, o.headshots),
		longRange: side(f.lrKills, f.lrHeadshots, f.lrPlayers, o.lrKills, o.lrHeadshots)
	};
}

function validCounts(c: Counts): boolean {
	return (
		Number.isSafeInteger(c.kills) &&
		Number.isSafeInteger(c.headshots) &&
		c.kills >= 0 &&
		c.headshots >= 0 &&
		c.headshots <= c.kills
	);
}

const pctText = (v: number) => `${Math.round(v * 10) / 10}%`;

/**
 * The checks assessIntelligence() makes before a rule may judge a cell, spelled out for the page.
 * The score comes from assessIntelligence alone; this only explains it, and a test holds the two
 * to the same answer.
 */
export function ruleView(
	c: IntelligenceConfig,
	row: Pick<WeaponRowView, 'weapon' | 'subject' | 'peers' | 'longRange'>,
	code: 'headshots' | 'longRange',
	coveragePct: number | null
): RuleView {
	const rules = weaponRules(c, row.weapon);
	const r = rules[code];
	if (!r.enabled) return { state: 'off', requirements: [] };
	const s = code === 'headshots' ? row.subject : row.longRange.subject;
	const p = code === 'headshots' ? row.peers : row.longRange.peers;
	const minPeers = code === 'headshots' ? c.baseline.minPeerKills : rules.longRange.minPeerKills;
	const minPlayers =
		code === 'headshots' ? c.baseline.minPeerPlayers : rules.longRange.minPeerPlayers;
	const noun =
		code === 'headshots' ? 'kills' : `kills at ${rules.longRange.distanceM} m or farther`;
	const min = c.baseline.minComparableCoveragePct;
	const covered =
		coveragePct !== null &&
		Number.isFinite(coveragePct) &&
		coveragePct <= 100 &&
		coveragePct >= min;
	const req: Requirement[] = [
		{
			label: 'Eligible kills on weapons with enough other players',
			need: `≥ ${min}%`,
			have: coveragePct === null ? 'withheld (row limit reached)' : pctText(coveragePct),
			ok: covered
		},
		{
			label: `Player's ${noun}`,
			need: `≥ ${r.minKills}`,
			have: String(s.kills),
			ok: s.kills >= r.minKills
		},
		{
			label: `Other players' ${noun}`,
			need: `≥ ${minPeers}`,
			have: String(p.kills),
			ok: p.kills >= minPeers
		},
		{
			label: 'Other players',
			need: `≥ ${minPlayers}`,
			have: String(p.players),
			ok: p.players >= minPlayers && Number.isSafeInteger(p.players) && p.players <= p.kills
		},
		{
			label: "Other players' headshots",
			need: '> 0',
			have: String(p.headshots),
			ok: p.headshots > 0
		}
	];
	if (!validCounts(s) || !validCounts(p))
		req.push({ label: 'Counts are consistent', need: 'yes', have: 'no', ok: false });
	return { state: req.every((q) => q.ok) ? 'eligible' : 'unavailable', requirements: req };
}

/** The weapons table: one row per weapon tag the subject has eligible kills with, most kills first. */
export function weaponRows(
	c: IntelligenceConfig,
	subject: Map<string, SubjectCell>,
	fleet: Map<string, FleetCell>,
	own: Map<string, SubjectCell>
): WeaponRowView[] {
	const rows = [...subject].map(([weapon, cell]): WeaponRowView => {
		const { peers, longRange } = peersExcluding(fleet.get(weapon), own.get(weapon)?.counts);
		const info = weaponInfo(weapon);
		const lr = weaponRules(c, weapon).longRange;
		return {
			weapon,
			name: info.name,
			weaponClass: info.class,
			subject: { kills: cell.counts.kills, headshots: cell.counts.headshots },
			peers,
			comparable:
				peers.kills >= c.baseline.minPeerKills && peers.players >= c.baseline.minPeerPlayers,
			longRange: {
				enabled: lr.enabled,
				distanceM: lr.distanceM,
				subject: { kills: cell.counts.lrKills, headshots: cell.counts.lrHeadshots },
				peers: longRange
			},
			knownDistance: cell.counts.knownDistance,
			headshots: { state: 'unavailable', requirements: [] },
			longRangeRule: { state: 'unavailable', requirements: [] }
		};
	});
	return rows.sort(
		(a, b) =>
			b.subject.kills - a.subject.kills ||
			a.name.localeCompare(b.name) ||
			(a.weapon < b.weapon ? -1 : 1)
	);
}

export interface WeaponMix {
	eligibleKills: number;
	/** the eligible kills on weapons whose peer sample meets the baseline minimums */
	matched: Counts;
	/** matched kills as a share of eligible kills, 0 when there are none */
	coveragePct: number;
	/**
	 * Weapon-mix expected headshot share over the matched weapons: each weapon's kills times its
	 * peers' share, summed, over the matched kills. Null when no weapon has enough peers.
	 */
	expectedPct: number | null;
}

export function weaponMix(rows: WeaponRowView[]): WeaponMix {
	let eligibleKills = 0;
	const matched = { kills: 0, headshots: 0 };
	let expected = 0;
	for (const r of rows) {
		eligibleKills += r.subject.kills;
		if (!r.comparable) continue;
		matched.kills += r.subject.kills;
		matched.headshots += r.subject.headshots;
		expected += r.subject.kills * (r.peers.headshots / r.peers.kills);
	}
	return {
		eligibleKills,
		matched,
		coveragePct: eligibleKills ? (100 * matched.kills) / eligibleKills : 0,
		expectedPct: matched.kills ? (100 * expected) / matched.kills : null
	};
}

/** What assessIntelligence judges: every weapon row, its cohort id being the weapon tag itself. */
export const comparisonsFrom = (rows: WeaponRowView[]): Comparison[] =>
	rows.map((r) => ({
		cohortId: r.weapon,
		weapon: r.weapon,
		subject: r.subject,
		peers: r.peers,
		longRange: { subject: r.longRange.subject, peers: r.longRange.peers }
	}));

// ---- bursts -----------------------------------------------------------------------------------

/**
 * How far a kill's receipt may drift from the match clock before it is taken for another clock
 * epoch (a reset the match row did not show) or a batch held back by that long. Either way it
 * starts a new segment: windows never span the split, so the error is always an undercount.
 */
export const CLOCK_TOLERANCE_S = 120;
/** Two kills at the same match-clock value received further apart than this: the clock is stuck. */
const SAME_CLOCK_GAP_MS = 5000;

export type ClockKill = Pick<
	SubjectKill,
	'ts' | 'serverId' | 'instanceId' | 'matchRow' | 'credible' | 'eventTime' | 'victimSteamId'
>;

export interface ClockSegments {
	events: TimedKill[];
	segments: number;
	excluded: BurstView['excluded'];
}

/**
 * Places kills on validated match-clock segments. A segment is one server boot (instance) and one
 * recorded match with a credible association, split wherever receipt time and the match clock
 * disagree by more than the tolerance (a reset, or a batch held back), and dropped whole when its
 * clock does not advance with receipt time. Kills without a credible match are left out of the
 * burst, never guessed onto a neighbour's clock; they still count in every comparison.
 */
export function clockSegments(kills: ClockKill[], tolerance = CLOCK_TOLERANCE_S): ClockSegments {
	const excluded = { ambiguousMatch: 0, clockNotAdvancing: 0, badClock: 0 };
	const groups = new Map<string, ClockKill[]>();
	for (const k of kills) {
		if (!k.credible || k.matchRow === null || !k.instanceId) excluded.ambiguousMatch++;
		else if (!Number.isFinite(k.eventTime) || k.eventTime < 0 || !Number.isFinite(k.ts))
			excluded.badClock++;
		else {
			const key = `${k.serverId}|${k.instanceId}|${k.matchRow}`;
			const rows = groups.get(key) ?? [];
			rows.push(k);
			groups.set(key, rows);
		}
	}
	const events: TimedKill[] = [];
	let segments = 0;
	for (const [key, rows] of groups) {
		rows.sort((a, b) => a.ts - b.ts || a.eventTime - b.eventTime);
		const epochs: ClockKill[][] = [];
		let base = Infinity;
		for (const k of rows) {
			// receipt less match clock: when the clock started, plus how late this kill arrived
			const offset = k.ts / 1000 - k.eventTime;
			if (!epochs.length || Math.abs(offset - base) > tolerance) {
				epochs.push([]);
				base = offset;
			} else base = Math.min(base, offset);
			epochs[epochs.length - 1].push(k);
		}
		epochs.forEach((seg, i) => {
			if (!clockAdvances(seg, tolerance)) {
				excluded.clockNotAdvancing += seg.length;
				return;
			}
			segments++;
			for (const k of seg)
				events.push({ segment: `${key}#${i}`, seconds: k.eventTime, victim: k.victimSteamId });
		});
	}
	return { events, segments, excluded };
}

/** False when receipt time moves on and the match clock does not: every kill would stack up. */
function clockAdvances(seg: ClockKill[], tolerance: number): boolean {
	const seen = new Map<number, { min: number; max: number }>();
	let minTs = Infinity,
		maxTs = -Infinity,
		minEt = Infinity,
		maxEt = -Infinity;
	for (const k of seg) {
		const s = seen.get(k.eventTime);
		if (s) {
			s.min = Math.min(s.min, k.ts);
			s.max = Math.max(s.max, k.ts);
			if (s.max - s.min > SAME_CLOCK_GAP_MS) return false;
		} else seen.set(k.eventTime, { min: k.ts, max: k.ts });
		minTs = Math.min(minTs, k.ts);
		maxTs = Math.max(maxTs, k.ts);
		minEt = Math.min(minEt, k.eventTime);
		maxEt = Math.max(maxEt, k.eventTime);
	}
	const receiptSpan = (maxTs - minTs) / 1000;
	const clockSpan = maxEt - minEt;
	return !(receiptSpan > tolerance / 2 && clockSpan < receiptSpan / 4);
}

/** The display maximum and the rule's maximum over the eligible kills of the scoring window. */
export function burstView(c: IntelligenceConfig, kills: ClockKill[]): BurstView {
	const windowSeconds = c.rules.burst.windowSeconds;
	const { events, segments, excluded } = clockSegments(kills);
	const reliable = events.length > 0;
	const at = (floor: number) => {
		const b = reliable ? maxRollingBurst(events, windowSeconds, floor) : null;
		return b ? { ...b, reliable } : null;
	};
	return {
		windowSeconds,
		display: at(1),
		rule: at(c.rules.burst.minDistinctVictims),
		used: events.length,
		excluded,
		segments
	};
}

// ---- charts -----------------------------------------------------------------------------------

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** YYYY-MM-DD of a moment in a time zone. */
export function dayKey(ms: number, timeZone: string): string {
	let f = dayFormats.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
		dayFormats.set(timeZone, f);
	}
	return f.format(new Date(ms));
}

/**
 * Kills per day by receipt time, every day of [from, to] present so quiet days read as zero.
 * Receipt time is when Warcon heard of a kill, not when it happened; bursts use the match clock.
 */
export function killTimeline(
	kills: { ts: number; eligible: boolean; headshot: boolean }[],
	range: { from: number; to: number },
	timeZone: string
): TimelineDay[] {
	const days = new Map<string, TimelineDay>();
	const add = (ms: number) => {
		const day = dayKey(ms, timeZone);
		if (!days.has(day)) days.set(day, { day, kills: 0, eligible: 0, headshots: 0 });
	};
	// Hourly steps, so a daylight-saving day of 23 or 25 hours is neither skipped nor doubled.
	for (let t = range.from; t < range.to; t += 3600_000) add(t);
	add(range.to);
	for (const k of kills) {
		if (k.ts < range.from || k.ts > range.to) continue;
		const d = days.get(dayKey(k.ts, timeZone));
		if (!d) continue;
		d.kills++;
		if (k.eligible) {
			d.eligible++;
			if (k.headshot) d.headshots++;
		}
	}
	return [...days.values()];
}

/** Kills by distance: below the first edge, between each pair (lower edge included), past the last. */
export function distanceHistogram(
	edges: number[],
	kills: { distanceM: number | null; headshot: boolean }[]
): { bins: DistanceBin[]; unknown: number } {
	const bins: DistanceBin[] = [
		{ label: `< ${edges[0]} m`, fromM: 0, toM: edges[0], kills: 0, headshots: 0 },
		...edges.slice(1).map((to, i) => ({
			label: `${edges[i]}–${to} m`,
			fromM: edges[i],
			toM: to,
			kills: 0,
			headshots: 0
		})),
		{
			label: `≥ ${edges[edges.length - 1]} m`,
			fromM: edges[edges.length - 1],
			toM: null,
			kills: 0,
			headshots: 0
		}
	];
	let unknown = 0;
	for (const k of kills) {
		if (k.distanceM === null || !Number.isFinite(k.distanceM)) {
			unknown++;
			continue;
		}
		const d = k.distanceM;
		const bin = bins.find((b) => d >= b.fromM && (b.toM === null || d < b.toM)) ?? bins[0];
		bin.kills++;
		if (k.headshot) bin.headshots++;
	}
	return { bins, unknown };
}

/** "Who they kill": victims by kills, with headshots and the mean known distance. */
export function topVictims(kills: SubjectKill[], limit = 10): OpponentView[] {
	const by = new Map<string, OpponentView & { ts: number; dSum: number; dN: number }>();
	for (const k of kills) {
		let v = by.get(k.victimSteamId);
		if (!v)
			by.set(
				k.victimSteamId,
				(v = {
					steamId: k.victimSteamId,
					name: k.victimName,
					kills: 0,
					headshots: 0,
					avgDistanceM: null,
					ts: k.ts,
					dSum: 0,
					dN: 0
				})
			);
		v.kills++;
		if (k.headshot) v.headshots++;
		if (k.distanceM !== null) {
			v.dSum += k.distanceM;
			v.dN++;
		}
		if (k.ts >= v.ts) {
			v.ts = k.ts;
			v.name = k.victimName || v.name;
		}
	}
	return [...by.values()]
		.sort((a, b) => b.kills - a.kills || b.headshots - a.headshots || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map(({ steamId, name, kills, headshots, dSum, dN }) => ({
			steamId,
			name,
			kills,
			headshots,
			avgDistanceM: dN ? Math.round(dSum / dN) : null
		}));
}

/** The subject's kills with weapons the rules do not score, by raw tag, and why each is unscored. */
export function unscoredWeapons(
	c: IntelligenceConfig,
	kills: SubjectKill[],
	range: { from: number; to: number }
): UnscoredWeaponView[] {
	const excluded = exclusionFilter(c);
	const by = new Map<string, UnscoredWeaponView>();
	for (const k of kills) {
		if (k.ts < range.from || k.ts > range.to || excluded(k) !== 'unscored') continue;
		const tag = k.cause ?? '';
		let row = by.get(tag);
		if (!row) {
			const info = weaponInfo(tag);
			by.set(
				tag,
				(row = {
					weapon: tag,
					name: info.name || 'No cause reported',
					weaponClass: info.class,
					reason: !info.known ? 'catalog' : !info.scored ? 'class' : 'config',
					kills: 0,
					headshots: 0
				})
			);
		}
		row.kills++;
		if (k.headshot) row.headshots++;
	}
	return [...by.values()].sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
}

// ---- the whole analysis -------------------------------------------------------------------------

export interface AnalysisInput {
	config: IntelligenceConfig;
	/** the subject's kills (no suicides) over at least [min(scoring.from, fleet.from), now] */
	kills: SubjectKill[];
	/** the fleet's cells over [from, asOf], as memoised */
	fleet: { from: number; asOf: number; cells: FleetCell[] };
	scoring: { from: number; to: number };
	history: { from: number; to: number };
	/** the subject's rows hit the fetch limit, so the self-exclusion may be short */
	clipped: boolean;
}

export interface Analysis {
	weapons: WeaponRowView[];
	unscored: UnscoredWeaponView[];
	mix: WeaponMix;
	eligible: Counts;
	longRange: Counts;
	knownDistanceKills: number;
	excluded: { unscored: number; teamKill: number; enemyUnknown: number };
	burst: BurstView;
	timeline: TimelineDay[];
	distance: { bins: DistanceBin[]; unknown: number };
	victims: OpponentView[];
	assessment: Assessment;
}

export function analyse(input: AnalysisInput): Analysis {
	const { config: c, kills, fleet, scoring, history } = input;
	const excluded = exclusionFilter(c);
	const inScoring = kills.filter((k) => k.ts >= scoring.from && k.ts <= scoring.to);
	const eligibleNow = inScoring.filter((k) => !excluded(k));

	const fleetCells = new Map(fleet.cells.map((f) => [f.weapon, f]));
	const own = tallyCells(c, kills, { from: fleet.from, to: fleet.asOf });
	const rows = weaponRows(c, tallyCells(c, kills, scoring), fleetCells, own);
	const mix = weaponMix(rows);
	// A clipped fetch may have missed some of the subject's own baseline kills, so the peers could
	// still hold some of them: the comparisons are withheld rather than judged on that.
	const coverageForRules = input.clipped ? null : mix.coveragePct;
	for (const r of rows) {
		r.headshots = ruleView(c, r, 'headshots', coverageForRules);
		r.longRangeRule = ruleView(c, r, 'longRange', coverageForRules);
	}
	const burst = burstView(c, eligibleNow);
	const assessment = assessIntelligence(c, {
		comparisons: comparisonsFrom(rows),
		// NaN fails the coverage check whatever the configured minimum, even 0.
		comparableCoveragePct: coverageForRules ?? NaN,
		burst: burst.rule
	});

	const counts = { unscored: 0, teamKill: 0, enemyUnknown: 0 };
	for (const k of inScoring) {
		const why = excluded(k);
		if (why) counts[why]++;
	}
	const longRange = { kills: 0, headshots: 0 };
	let knownDistanceKills = 0;
	for (const r of rows) {
		longRange.kills += r.longRange.subject.kills;
		longRange.headshots += r.longRange.subject.headshots;
		knownDistanceKills += r.knownDistance;
	}
	const inHistory = kills.filter((k) => k.ts >= history.from && k.ts <= history.to);
	return {
		weapons: rows,
		unscored: unscoredWeapons(c, kills, scoring),
		mix,
		eligible: {
			kills: eligibleNow.length,
			headshots: eligibleNow.filter((k) => k.headshot).length
		},
		longRange,
		knownDistanceKills,
		excluded: counts,
		burst,
		timeline: killTimeline(
			inHistory.map((k) => ({ ts: k.ts, eligible: !excluded(k), headshot: k.headshot })),
			history,
			c.display.timezone
		),
		distance: distanceHistogram(c.display.distanceEdgesM, eligibleNow),
		victims: topVictims(inHistory),
		assessment
	};
}

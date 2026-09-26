// What the player intelligence page and its API return. Client-safe: no server imports. Kept out
// of $lib/types so the module's shapes never touch an upstream file (plan R3).
import type { Assessment, Burst, Counts } from './score';

/** One check behind a rule's "insufficient evidence": what it needs and what the data has. */
export interface Requirement {
	label: string;
	need: string;
	have: string;
	ok: boolean;
}

export interface RuleView {
	/** off: disabled for this weapon or class; the rest follow the requirements */
	state: 'off' | 'unavailable' | 'eligible';
	requirements: Requirement[];
}

/**
 * One weapon: the subject against every other player with the same exact tag, across every mode
 * and map (plan R11). The tag is also the cohort id findings and unavailable rules refer to.
 */
export interface WeaponRowView {
	/** the raw cause tag, exactly as stored */
	weapon: string;
	/** weaponInfo(tag).name */
	name: string;
	weaponClass: string;
	subject: Counts;
	/** every other player with this weapon over the baseline window, the subject excluded */
	peers: Counts & { players: number };
	/** peers meet the baseline minimums: counted as matched coverage */
	comparable: boolean;
	longRange: {
		enabled: boolean;
		distanceM: number;
		subject: Counts;
		peers: Counts & { players: number };
	};
	/** the subject's kills in this cell with a known distance */
	knownDistance: number;
	headshots: RuleView;
	longRangeRule: RuleView;
}

export interface UnscoredWeaponView {
	weapon: string;
	name: string;
	weaponClass: string;
	/** 'catalog': not in the weapon catalog; 'class': its class is never scored; 'config': left out of the scored tags */
	reason: 'catalog' | 'class' | 'config';
	kills: number;
	headshots: number;
}

export interface BurstView {
	windowSeconds: number;
	/** the largest window over validated clock segments, whatever its victims */
	display: Burst | null;
	/** the largest window that meets the distinct-victim floor: what the rule judges */
	rule: Burst | null;
	/** kills placed on a validated clock segment */
	used: number;
	/**
	 * kills left out of the burst only (never the comparisons): no credible match to place them on a
	 * match clock, a clock that did not advance, or a bad clock value
	 */
	excluded: { ambiguousMatch: number; clockNotAdvancing: number; badClock: number };
	segments: number;
}

export interface TimelineDay {
	/** YYYY-MM-DD in the display time zone */
	day: string;
	/** every kill (not suicides) received that day */
	kills: number;
	/** of which eligible for the comparisons */
	eligible: number;
	headshots: number;
}

export interface DistanceBin {
	label: string;
	fromM: number;
	/** null: open-ended */
	toM: number | null;
	kills: number;
	headshots: number;
}

export interface OpponentView {
	steamId: string;
	name: string;
	kills: number;
	headshots: number;
	/** mean over the kills with a known distance; null when none has one */
	avgDistanceM: number | null;
}

export interface SessionView {
	id: number;
	serverId: string;
	serverName: string;
	name: string;
	faction: string | null;
	joinedAt: string;
	lastSeen: string;
	leftAt: string | null;
	/** join to last observation, so a poller outage never lengthens a stay */
	observedMinutes: number;
	kills: number;
	deaths: number;
	/** the maps of the recorded matches the stay overlapped, oldest first */
	maps: string[];
}

export type Presence =
	| { state: 'online'; serverId: string; serverName: string; lastSeen: string }
	| { state: 'unknown'; serverId: string; serverName: string; lastSeen: string }
	| { state: 'offline'; lastSeen: string | null };

export interface IntelligenceView {
	steamId: string;
	name: string;
	generatedAt: string;
	algorithmVersion: number;
	settings: {
		/** phase 1 has no saved settings: the built-in defaults, evaluated on demand in shadow mode */
		source: 'defaults';
		revision: number;
		mode: 'shadow' | 'review';
		requireKnownEnemy: boolean;
		excludeTeamKills: boolean;
		minPeerKills: number;
		minPeerPlayers: number;
		minComparableCoveragePct: number;
		thresholds: { watch: number; review: number; priority: number };
		burst: { windowSeconds: number; minKills: number; minDistinctVictims: number };
	};
	scope: {
		/** the servers these numbers cover, sorted by name */
		servers: { id: string; name: string }[];
		/** every server of the org where the reader holds intelligence read */
		permitted: { id: string; name: string }[];
		/** how many of the covered servers have a kill feed */
		feedServers: number;
	};
	windows: {
		scoring: { from: string; to: string; days: number };
		baseline: { from: string; to: string; days: number; sinceUtc: string | null };
	};
	presence: Presence;
	kpis: {
		/** every feed kill (not suicides) on record in scope, all time */
		killsOnRecord: number;
		/** eligible kills in the scoring window, and their headshots */
		eligible: Counts;
		/** the same over weapons with enough other players, with the weapon-mix expected share */
		matched: Counts & { expectedPct: number | null; coveragePct: number };
		/** headshots among long-range kills, over weapons whose long-range rule is on */
		longRange: Counts;
		burst: BurstView;
		/** the game's scoreboard counters over recorded matches that ended */
		recorded: { kills: number; deaths: number; matches: number };
		sessions: number;
		observedMinutes: number;
		firstSeen: string | null;
	};
	weapons: WeaponRowView[];
	unscored: UnscoredWeaponView[];
	coverage: {
		eligibleKills: number;
		/** eligible kills on weapons whose peer sample meets the baseline minimums */
		matchedKills: number;
		knownDistanceKills: number;
		excluded: { unscored: number; teamKill: number; enemyUnknown: number };
		/** the subject's rows hit the fetch limit: comparisons are withheld */
		clipped: boolean;
	};
	timeline: TimelineDay[];
	distance: { bins: DistanceBin[]; unknown: number };
	assessment: Assessment;
	opponents: { victims: OpponentView[]; killers: OpponentView[] };
	sessions: { rows: SessionView[]; page: number; pageSize: number; total: number };
}

// Review priority from comparable evidence (docs/intelligence/plan.md §5, appendix). Pure and
// client-safe. The score is a heuristic for where staff look first, never a probability, and it
// never reaches assessRisk() or risk_kick: those can act on a player, this cannot.
import type { IntelligenceConfig } from './config';
import { weaponRules } from './config';

export interface Counts {
	kills: number;
	headshots: number;
}
// One row per weapon, never one blended row across weapons. The cohort is the exact weapon tag
// across every mode and map (plan R11), so cohortId is that tag.
export interface Comparison {
	cohortId: string;
	weapon: string;
	subject: Counts;
	peers: Counts & { players: number };
	longRange: { subject: Counts; peers: Counts & { players: number } };
}
export interface Finding {
	code: 'headshots' | 'longRange' | 'burst';
	group: 'aim' | 'burst';
	weight: number;
	weapon?: string;
	cohortId?: string;
	detail: string;
}
export interface Burst {
	// A maximum from a rolling window with reliable ordering within one match-clock segment.
	kills: number;
	distinctVictims: number;
	windowSeconds: number;
	reliable: boolean;
}
export interface Evidence {
	comparisons: Comparison[];
	comparableCoveragePct: number;
	burst: Burst | null;
}

export const ALGORITHM_VERSION = 1;

function valid(c: Counts): boolean {
	return (
		Number.isSafeInteger(c.kills) &&
		Number.isSafeInteger(c.headshots) &&
		c.kills >= 0 &&
		c.headshots >= 0 &&
		c.headshots <= c.kills
	);
}
function high(subject: Counts, peers: Counts, ratio: number, gapPoints: number) {
	const observed = subject.headshots / subject.kills;
	const expected = peers.headshots / peers.kills;
	// A zero observed peer rate is not an infinite-strength signal.
	return expected > 0 && observed / expected >= ratio && 100 * (observed - expected) >= gapPoints;
}

export function assessIntelligence(c: IntelligenceConfig, e: Evidence) {
	const findings: Finding[] = [];
	const unavailable: string[] = [];
	let eligibleRules = 0;
	if (c.enabled)
		for (const row of e.comparisons) {
			if (!c.filters.scoredWeaponTags.includes(row.weapon)) continue;
			const rules = weaponRules(c, row.weapon);
			const coverageOk =
				Number.isFinite(e.comparableCoveragePct) &&
				e.comparableCoveragePct <= 100 &&
				e.comparableCoveragePct >= c.baseline.minComparableCoveragePct;
			const evaluate = (
				code: 'headshots' | 'longRange',
				s: Counts,
				p: Counts & { players: number },
				minPeers: number,
				minPlayers: number
			) => {
				const r = rules[code];
				if (!r.enabled) return;
				if (
					!coverageOk ||
					!valid(s) ||
					!valid(p) ||
					s.kills < r.minKills ||
					p.kills < minPeers ||
					p.players < minPlayers ||
					p.players > p.kills ||
					!Number.isSafeInteger(p.players) ||
					p.headshots === 0
				) {
					unavailable.push(`${row.cohortId}: ${code} has insufficient comparable evidence`);
					return;
				}
				eligibleRules++;
				if (high(s, p, r.ratio, r.gapPoints))
					findings.push({
						code,
						group: 'aim',
						weight: r.weight,
						weapon: row.weapon,
						cohortId: row.cohortId,
						detail:
							`${s.headshots}/${s.kills} headshots versus ${p.headshots}/${p.kills} ` +
							`among ${p.players} other players` +
							(code === 'longRange' ? ` at ${rules.longRange.distanceM}m or farther` : '')
					});
			};
			evaluate(
				'headshots',
				row.subject,
				row.peers,
				c.baseline.minPeerKills,
				c.baseline.minPeerPlayers
			);
			evaluate(
				'longRange',
				row.longRange.subject,
				row.longRange.peers,
				rules.longRange.minPeerKills,
				rules.longRange.minPeerPlayers
			);
		}
	const b = e.burst,
		r = c.rules.burst;
	if (c.enabled && r.enabled) {
		if (
			b?.reliable &&
			b.windowSeconds === r.windowSeconds &&
			Number.isSafeInteger(b.kills) &&
			Number.isSafeInteger(b.distinctVictims) &&
			b.kills >= 0 &&
			b.distinctVictims >= 0 &&
			b.distinctVictims <= b.kills
		) {
			eligibleRules++;
			if (b.kills >= r.minKills && b.distinctVictims >= r.minDistinctVictims)
				findings.push({
					code: 'burst',
					group: 'burst',
					weight: r.weight,
					detail:
						`${b.kills} kills against ${b.distinctVictims} distinct victims ` +
						`within ${b.windowSeconds} seconds`
				});
		} else unavailable.push('Burst timing or victim coverage is unavailable');
	}
	// Correlated headshot findings, including different weapons, contribute once.
	const aim = Math.max(0, ...findings.filter((f) => f.group === 'aim').map((f) => f.weight));
	const burst = Math.max(0, ...findings.filter((f) => f.group === 'burst').map((f) => f.weight));
	const score = !c.enabled || !eligibleRules ? null : Math.min(100, aim + burst);
	const level =
		score === null
			? null
			: score >= c.thresholds.priority
				? 'priority'
				: score >= c.thresholds.review
					? 'review'
					: score >= c.thresholds.watch
						? 'watch'
						: 'clear';
	return {
		algorithmVersion: ALGORITHM_VERSION,
		mode: c.mode,
		score,
		level,
		state: !c.enabled ? 'disabled' : !eligibleRules ? 'insufficient_data' : 'ready',
		eligibleRules,
		findings,
		unavailable
	};
}

export type Assessment = ReturnType<typeof assessIntelligence>;

export interface TimedKill {
	segment: string;
	seconds: number;
	victim: string;
}
// Segments must distinguish server boot AND actual match-clock epoch.
// Do not pass the feed's raw matchId alone: it has been observed to be per-boot.
export function maxRollingBurst(
	events: TimedKill[],
	seconds: number,
	minDistinctVictims = 1
): Burst | null {
	if (!(seconds > 0) || !events.length) return null;
	const segments = new Map<string, TimedKill[]>();
	for (const e of events) {
		if (!e.segment || !Number.isFinite(e.seconds) || e.seconds < 0 || !e.victim) return null;
		const rows = segments.get(e.segment) ?? [];
		rows.push(e);
		segments.set(e.segment, rows);
	}
	let best = { kills: 0, distinctVictims: 0, windowSeconds: seconds, reliable: true };
	for (const rows of segments.values()) {
		rows.sort((a, b) => a.seconds - b.seconds);
		let left = 0;
		const victims = new Map<string, number>();
		for (let right = 0; right < rows.length; right++) {
			const victim = rows[right].victim;
			victims.set(victim, (victims.get(victim) ?? 0) + 1);
			// Half-open interval (latest - window, latest].
			while (rows[right].seconds - rows[left].seconds >= seconds) {
				const old = rows[left++].victim;
				const n = victims.get(old)! - 1;
				if (n) victims.set(old, n);
				else victims.delete(old);
			}
			const kills = right - left + 1;
			if (
				victims.size >= minDistinctVictims &&
				(kills > best.kills || (kills === best.kills && victims.size > best.distinctVictims))
			)
				best = { ...best, kills, distinctVictims: victims.size };
		}
	}
	return best;
}

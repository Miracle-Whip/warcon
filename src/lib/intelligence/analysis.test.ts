import { describe, expect, test } from 'bun:test';
import {
	analyse,
	burstView,
	cellId,
	cellOf,
	clockSegments,
	comparisonsFrom,
	dayKey,
	distanceHistogram,
	exclusionFilter,
	killTimeline,
	peersExcluding,
	ruleView,
	tallyCells,
	topVictims,
	unscoredWeapons,
	weaponMix,
	weaponRows,
	type ClockKill,
	type FleetCell,
	type SubjectCell,
	type SubjectKill
} from './analysis';
import { DEFAULT_CONFIG, type IntelligenceConfig } from './config';
import { assessIntelligence } from './score';
import type { WeaponRowView } from './types';

const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const M4 = 'Id.Item.M4';
const MOSIN = 'Id.Item.Mosin';
const SKS = 'Id.Item.SKS';
const VECTOR = 'Id.Item.Vector';

const config = (patch: (c: IntelligenceConfig) => void = () => {}): IntelligenceConfig => {
	const c = { ...structuredClone(DEFAULT_CONFIG), enabled: true };
	patch(c);
	return c;
};

let seq = 0;
const kill = (over: Partial<SubjectKill> = {}): SubjectKill => ({
	ts: T0,
	serverId: 's1',
	instanceId: 'i1',
	matchRow: 1,
	credible: true,
	mode: 'Conquest',
	eventTime: 100,
	map: 'Europe',
	cause: M4,
	distanceM: 50,
	headshot: false,
	teamKill: false,
	killerFaction: 'A',
	victimFaction: 'B',
	victimSteamId: `7656119800000${String(1000 + seq++).padStart(4, '0')}`,
	victimName: 'victim',
	...over
});

const clockKill = (eventTime: number, ts: number, over: Partial<ClockKill> = {}): ClockKill => ({
	ts,
	serverId: 's1',
	instanceId: 'i1',
	matchRow: 1,
	credible: true,
	eventTime,
	victimSteamId: `v${seq++}`,
	...over
});

describe('eligibility', () => {
	const excluded = exclusionFilter(config());

	test('scored weapons against a known enemy count', () => {
		expect(excluded(kill())).toBe(null);
	});

	test('unscored tags, a missing cause, team kills and unknown sides are left out', () => {
		expect(excluded(kill({ cause: 'Id.Item.M67Grenade' }))).toBe('unscored');
		expect(excluded(kill({ cause: 'Id.Item.CombatBow' }))).toBe('unscored');
		expect(excluded(kill({ cause: null }))).toBe('unscored');
		expect(excluded(kill({ teamKill: true, victimFaction: 'A' }))).toBe('teamKill');
		expect(excluded(kill({ victimFaction: null }))).toBe('enemyUnknown');
		expect(excluded(kill({ killerFaction: 'B' }))).toBe('enemyUnknown');
	});

	test('the tag is matched exactly, as the kills table stores it', () => {
		expect(excluded(kill({ cause: 'id.item.m4' }))).toBe('unscored');
	});

	test('with the filters off, team kills and unknown sides count', () => {
		const loose = exclusionFilter(
			config((c) => {
				c.filters.excludeTeamKills = false;
				c.filters.requireKnownEnemy = false;
			})
		);
		expect(loose(kill({ teamKill: true, victimFaction: 'A' }))).toBe(null);
		expect(loose(kill({ killerFaction: null, victimFaction: null }))).toBe(null);
	});
});

describe('cohort cells', () => {
	test('weapon ignores mode and map; weapon_mode needs a credible match', () => {
		expect(cellOf('weapon', kill({ credible: false }))).toEqual({
			weapon: M4,
			mode: null,
			map: null,
			modeKnown: true
		});
		expect(cellOf('weapon_mode', kill())).toEqual({
			weapon: M4,
			mode: 'Conquest',
			map: null,
			modeKnown: true
		});
		expect(cellOf('weapon_mode', kill({ credible: false })).modeKnown).toBe(false);
		expect(cellOf('weapon_mode', kill({ mode: null })).modeKnown).toBe(false);
		expect(cellOf('weapon_mode_map', kill()).map).toBe('Europe');
	});

	test('long range uses each weapon class cutoff, and an unknown distance is never long range', () => {
		const c = config();
		const cells = tallyCells(
			c,
			[
				kill({ distanceM: 150, headshot: true }),
				kill({ distanceM: 149.99 }),
				kill({ distanceM: null }),
				kill({ cause: MOSIN, distanceM: 250 }),
				kill({ cause: MOSIN, distanceM: 300 }),
				kill({ cause: VECTOR, distanceM: 500 })
			],
			{ from: T0, to: T0 }
		);
		expect(cells.get(cellId(M4, 'Conquest', null))!.counts).toEqual({
			kills: 3,
			headshots: 1,
			lrKills: 1,
			lrHeadshots: 1,
			knownDistance: 2
		});
		expect(cells.get(cellId(MOSIN, 'Conquest', null))!.counts.lrKills).toBe(1);
		expect(cells.get(cellId(VECTOR, 'Conquest', null))!.counts.lrKills).toBe(0);
	});

	test('the window is inclusive at both ends and nothing outside it counts', () => {
		const cells = tallyCells(
			config(),
			[kill({ ts: T0 - 1 }), kill({ ts: T0 }), kill({ ts: T0 + 10 }), kill({ ts: T0 + 11 })],
			{ from: T0, to: T0 + 10 }
		);
		expect(cells.get(cellId(M4, 'Conquest', null))!.counts.kills).toBe(2);
	});
});

describe('self-exclusion', () => {
	const fleet: FleetCell = {
		weapon: M4,
		mode: 'Conquest',
		map: null,
		kills: 1100,
		headshots: 260,
		players: 51,
		lrKills: 540,
		lrHeadshots: 125,
		lrPlayers: 31
	};

	test("the subject's kills, headshots and the subject as a player leave the peers", () => {
		const own = { kills: 100, headshots: 60, lrKills: 40, lrHeadshots: 25, knownDistance: 90 };
		expect(peersExcluding(fleet, own)).toEqual({
			peers: { kills: 1000, headshots: 200, players: 50 },
			longRange: { kills: 500, headshots: 100, players: 30 }
		});
	});

	test('a subject with no kills in the cell leaves the player count alone', () => {
		const own = { kills: 0, headshots: 0, lrKills: 0, lrHeadshots: 0, knownDistance: 0 };
		expect(peersExcluding(fleet, own).peers.players).toBe(51);
		expect(peersExcluding(fleet, undefined).peers.players).toBe(51);
	});

	test('a subject with kills but none at long range stays among the long-range players', () => {
		const own = { kills: 10, headshots: 1, lrKills: 0, lrHeadshots: 0, knownDistance: 10 };
		expect(peersExcluding(fleet, own).longRange.players).toBe(31);
	});

	test('a kill written between the two reads cannot make a count negative', () => {
		const own = { kills: 5, headshots: 5, lrKills: 5, lrHeadshots: 5, knownDistance: 5 };
		const tiny = {
			...fleet,
			kills: 3,
			headshots: 1,
			players: 1,
			lrKills: 0,
			lrHeadshots: 0,
			lrPlayers: 0
		};
		expect(peersExcluding(tiny, own)).toEqual({
			peers: { kills: 0, headshots: 0, players: 0 },
			longRange: { kills: 0, headshots: 0, players: 0 }
		});
	});
});

const subjectCell = (
	weapon: string,
	mode: string | null,
	kills: number,
	headshots: number
): SubjectCell => ({
	weapon,
	mode,
	map: null,
	modeKnown: mode !== null,
	counts: { kills, headshots, lrKills: 0, lrHeadshots: 0, knownDistance: kills }
});
const fleetCell = (
	weapon: string,
	mode: string | null,
	kills: number,
	headshots: number,
	players: number
): FleetCell => ({
	weapon,
	mode,
	map: null,
	kills,
	headshots,
	players,
	lrKills: 0,
	lrHeadshots: 0,
	lrPlayers: 0
});
const byId = <T extends { weapon: string; mode: string | null; map: string | null }>(list: T[]) =>
	new Map(list.map((x) => [cellId(x.weapon, x.mode, x.map), x]));

describe('weapon-mix expectation and coverage', () => {
	const c = config();
	const rows = weaponRows(
		c,
		byId([
			subjectCell(M4, 'Conquest', 100, 30),
			subjectCell(MOSIN, 'Conquest', 50, 30),
			subjectCell(SKS, 'Conquest', 20, 5),
			subjectCell(M4, null, 30, 20)
		]),
		byId([
			fleetCell(M4, 'Conquest', 1000, 200, 40),
			fleetCell(MOSIN, 'Conquest', 600, 300, 35),
			fleetCell(SKS, 'Conquest', 100, 20, 10)
		]),
		new Map()
	);

	test('each cell is weighted by its own peers, never a pooled rate', () => {
		const mix = weaponMix(rows);
		expect(mix.eligibleKills).toBe(200);
		expect(mix.matched).toEqual({ kills: 150, headshots: 60 });
		// (100 × 20% + 50 × 50%) / 150; a pooled peer rate (500/1600 = 31.25%) would be wrong
		expect(mix.expectedPct).toBeCloseTo(30, 10);
		expect(mix.coveragePct).toBe(75);
		expect(mix.unknownModeKills).toBe(30);
	});

	test('a sparse cohort and an unknown mode are not matched, and unknown mode is not compared', () => {
		const sks = rows.find((r) => r.weapon === SKS)!;
		expect(sks.comparable).toBe(false);
		const unknown = rows.find((r) => !r.modeKnown)!;
		expect(unknown.comparable).toBe(false);
		expect(comparisonsFrom(rows).map((r) => r.cohortId)).not.toContain(unknown.cohortId);
		expect(ruleView(c, unknown, 'headshots', 100).requirements[0]).toMatchObject({
			label: 'Recorded match mode',
			ok: false
		});
	});

	test('no matched cell means no expectation, and no eligible kills means zero coverage', () => {
		expect(weaponMix([])).toMatchObject({ coveragePct: 0, expectedPct: null });
	});
});

describe('the explanation agrees with the score', () => {
	const c = config();
	const view = (
		weapon: string,
		s: [number, number],
		p: [number, number, number]
	): WeaponRowView => ({
		cohortId: cellId(weapon, 'Conquest', null),
		weapon,
		name: weapon,
		weaponClass: '',
		mode: 'Conquest',
		map: null,
		modeKnown: true,
		subject: { kills: s[0], headshots: s[1] },
		peers: { kills: p[0], headshots: p[1], players: p[2] },
		comparable: true,
		longRange: {
			enabled: true,
			distanceM: 150,
			subject: { kills: s[0], headshots: s[1] },
			peers: { kills: p[0], headshots: p[1], players: p[2] }
		},
		knownDistance: s[0],
		headshots: { state: 'unavailable', requirements: [] },
		longRangeRule: { state: 'unavailable', requirements: [] }
	});

	test('a rule check is unavailable in the score exactly when a requirement is unmet', () => {
		let checked = 0;
		for (const weapon of [M4, VECTOR])
			for (const sk of [0, 29, 30, 100, 150])
				for (const pk of [0, 199, 200, 500, 1000])
					for (const ph of [0, 0.2])
						for (const pp of [1, 19, 20, 30, 60])
							for (const coverage of [50, 80, 100]) {
								const row = view(weapon, [sk, Math.floor(sk * 0.6)], [pk, Math.floor(pk * ph), pp]);
								const a = assessIntelligence(c, {
									comparisons: comparisonsFrom([row]),
									comparableCoveragePct: coverage,
									burst: null
								});
								for (const code of ['headshots', 'longRange'] as const) {
									const inScore = a.unavailable.includes(
										`${row.cohortId}: ${code} has insufficient comparable evidence`
									);
									const explained = ruleView(c, row, code, coverage).state;
									expect({ weapon, sk, pk, ph, pp, coverage, code, inScore }).toEqual({
										weapon,
										sk,
										pk,
										ph,
										pp,
										coverage,
										code,
										inScore: explained === 'unavailable'
									});
									checked++;
								}
							}
		expect(checked).toBeGreaterThan(1000);
	});

	test('a rule that is off for the weapon class is off, not unavailable', () => {
		expect(ruleView(c, view(VECTOR, [100, 50], [1000, 200, 50]), 'longRange', 100)).toEqual({
			state: 'off',
			requirements: []
		});
	});
});

describe('clock segments', () => {
	const c = config();

	test('a consistent clock is one segment with every kill', () => {
		const r = clockSegments([10, 20, 30, 40, 50].map((et) => clockKill(et, T0 + et * 1000)));
		expect(r.segments).toBe(1);
		expect(r.events.length).toBe(5);
	});

	test('a clock reset inside one match row starts a new segment: no window spans it', () => {
		const a = Array.from({ length: 11 }, (_, i) => clockKill(i * 5, T0 + i * 5000));
		const b = Array.from({ length: 11 }, (_, i) => clockKill(i * 5, T0 + 600_000 + i * 5000));
		const view = burstView(c, [...a, ...b]);
		expect(view.segments).toBe(2);
		expect(view.display!.kills).toBe(11);
	});

	test('identical receipt timestamps are spread by the match clock, not stacked', () => {
		const batch = Array.from({ length: 10 }, (_, i) => clockKill(i * 30, T0));
		const view = burstView(c, batch);
		expect(view.segments).toBe(1);
		expect(view.display!.kills).toBe(2);
	});

	test('a batch held back and delivered late cannot create a burst larger than the real one', () => {
		const prompt = Array.from({ length: 11 }, (_, i) => clockKill(i * 30, T0 + i * 30_000));
		const late = [100, 105, 110].map((et) => clockKill(et, T0 + 400_000));
		const view = burstView(c, [...prompt, ...late]);
		// On the true clock the best 60 s holds 5 kills (90, 100, 105, 110, 120); split, it is 3.
		expect(view.display!.kills).toBeLessThanOrEqual(5);
		expect(view.display!.kills).toBe(3);
	});

	test('a clock that does not advance with receipt time is left out', () => {
		const stuck = Array.from({ length: 20 }, (_, i) => clockKill(5, T0 + i * 10_000));
		const r = clockSegments(stuck);
		expect(r.events.length).toBe(0);
		expect(r.excluded.clockNotAdvancing).toBe(20);
		expect(burstView(c, stuck).display).toBe(null);
		// never the same value twice, but 0.25 s of clock over four minutes of receipts
		const creeping = Array.from({ length: 26 }, (_, i) => clockKill(5 + i * 0.01, T0 + i * 10_000));
		expect(clockSegments(creeping).events.length).toBe(0);
	});

	test('different boots and different match rows never share a segment', () => {
		const boot = (instanceId: string) =>
			Array.from({ length: 11 }, (_, i) => clockKill(i * 5, T0 + i * 5000, { instanceId }));
		expect(burstView(c, [...boot('i1'), ...boot('i2')]).display!.kills).toBe(11);
		const row = (matchRow: number) =>
			Array.from({ length: 11 }, (_, i) => clockKill(i * 5, T0 + i * 5000, { matchRow }));
		expect(burstView(c, [...row(1), ...row(2)]).display!.kills).toBe(11);
	});

	test('kills without a credible match or with a bad clock value are counted out, not guessed', () => {
		const r = clockSegments([
			clockKill(10, T0, { credible: false }),
			clockKill(10, T0, { matchRow: null }),
			clockKill(10, T0, { instanceId: '' }),
			clockKill(-1, T0),
			clockKill(Number.NaN, T0),
			clockKill(10, T0)
		]);
		expect(r.excluded).toEqual({ ambiguousMatch: 3, clockNotAdvancing: 0, badClock: 2 });
		expect(r.events.length).toBe(1);
	});

	test('the rule maximum honours the distinct-victim floor; the display maximum does not', () => {
		const farmed = Array.from({ length: 12 }, (_, i) =>
			clockKill(i * 4, T0 + i * 4000, { victimSteamId: `v${i % 3}` })
		);
		const view = burstView(c, farmed);
		expect(view.display).toMatchObject({ kills: 12, distinctVictims: 3, reliable: true });
		expect(view.rule).toMatchObject({ kills: 0, distinctVictims: 0, reliable: true });
		const a = assessIntelligence(c, {
			comparisons: [],
			comparableCoveragePct: 0,
			burst: view.rule
		});
		expect([a.score, a.findings]).toEqual([0, []]);
	});

	test('no validated kill leaves the burst rule without evidence', () => {
		const view = burstView(c, []);
		expect([view.display, view.rule]).toEqual([null, null]);
		const a = assessIntelligence(c, {
			comparisons: [],
			comparableCoveragePct: 0,
			burst: view.rule
		});
		expect(a.state).toBe('insufficient_data');
		expect(a.unavailable).toContain('Burst timing or victim coverage is unavailable');
	});
});

describe('charts', () => {
	test('distance bins include their lower edge; an unknown distance is not zero metres', () => {
		const h = distanceHistogram(
			[25, 50],
			[
				{ distanceM: 0, headshot: false },
				{ distanceM: 24.99, headshot: true },
				{ distanceM: 25, headshot: true },
				{ distanceM: 50, headshot: false },
				{ distanceM: 900, headshot: true },
				{ distanceM: null, headshot: true }
			]
		);
		expect(h.bins.map((b) => [b.label, b.kills, b.headshots])).toEqual([
			['< 25 m', 2, 1],
			['25–50 m', 1, 1],
			['≥ 50 m', 2, 1]
		]);
		expect(h.unknown).toBe(1);
	});

	test('the timeline has every day of the range, quiet ones as zero', () => {
		const days = killTimeline(
			[
				{ ts: T0, eligible: true, headshot: true },
				{ ts: T0 + 86400_000, eligible: false, headshot: true },
				{ ts: T0 - 86400_000 * 5, eligible: true, headshot: true }
			],
			{ from: T0, to: T0 + 2 * 86400_000 + 3600_000 },
			'UTC'
		);
		expect(days).toEqual([
			{ day: '2026-09-20', kills: 1, eligible: 1, headshots: 1 },
			{ day: '2026-09-21', kills: 1, eligible: 0, headshots: 0 },
			{ day: '2026-09-22', kills: 0, eligible: 0, headshots: 0 }
		]);
	});

	test('days follow the display time zone', () => {
		const t = Date.UTC(2026, 8, 21, 2, 0, 0);
		expect(dayKey(t, 'UTC')).toBe('2026-09-21');
		expect(dayKey(t, 'America/New_York')).toBe('2026-09-20');
	});

	test('victims by kills, with the mean over known distances and their latest name', () => {
		const v = 'v-top';
		const rows = topVictims([
			kill({ victimSteamId: v, victimName: 'old', ts: T0, distanceM: 10, headshot: true }),
			kill({ victimSteamId: v, victimName: 'new', ts: T0 + 1, distanceM: null }),
			kill({ victimSteamId: v, victimName: 'old', ts: T0 - 1, distanceM: 30 }),
			kill({ victimSteamId: 'v-other', victimName: 'x' })
		]);
		expect(rows[0]).toEqual({ steamId: v, name: 'new', kills: 3, headshots: 1, avgDistanceM: 20 });
		expect(rows[1].avgDistanceM).toBe(50);
	});
});

describe('unscored weapons', () => {
	test('each says why: not in the catalog, a class never scored, or left out of the config', () => {
		const c = config((cfg) => {
			cfg.filters.scoredWeaponTags = cfg.filters.scoredWeaponTags.filter((t) => t !== SKS);
			delete cfg.weaponOverrides[SKS];
		});
		const rows = unscoredWeapons(
			c,
			[
				kill({ cause: 'Id.Item.Railgun' }),
				kill({ cause: 'Id.Item.M67Grenade' }),
				kill({ cause: 'Id.Item.M67Grenade', headshot: true }),
				kill({ cause: SKS }),
				kill({ cause: M4 })
			],
			{ from: T0, to: T0 }
		);
		expect(rows.map((r) => [r.weapon, r.reason, r.kills, r.headshots])).toEqual([
			['Id.Item.M67Grenade', 'class', 2, 1],
			['Id.Item.Railgun', 'catalog', 1, 0],
			[SKS, 'config', 1, 0]
		]);
		expect(rows[0].name).toBe('M67 grenade');
	});
});

describe('analyse', () => {
	const now = T0 + 3 * 3600_000;
	const scoring = { from: now - 7 * 86400_000, to: now };
	const fleetWindow = { from: now - 30 * 86400_000, asOf: now };
	/** 120 M4 kills, 90 of them headshots, 30 s apart on a consistent clock, distinct victims. */
	const m4 = () =>
		Array.from({ length: 120 }, (_, i) =>
			kill({ ts: T0 + i * 30_000, eventTime: 100 + i * 30, headshot: i < 90 })
		);
	const sks = () =>
		Array.from({ length: 120 }, (_, i) =>
			kill({ cause: SKS, ts: T0 + i * 30_000 + 1, eventTime: 100 + i * 30 })
		);
	const run = (kills: SubjectKill[], cells: FleetCell[], clipped = false) =>
		analyse({
			config: config(),
			kills,
			fleet: { ...fleetWindow, cells },
			scoring,
			history: { from: fleetWindow.from, to: now },
			clipped
		});
	// the fleet includes the subject: 2000 other kills (400 headshots) by 60 other players
	const m4Fleet = fleetCell(M4, 'Conquest', 2120, 490, 61);

	test('a strong headshot share on well-covered weapons is a finding', () => {
		const a = run(m4(), [m4Fleet]);
		const row = a.weapons[0];
		expect(row.peers).toEqual({ kills: 2000, headshots: 400, players: 60 });
		expect(row.headshots.state).toBe('eligible');
		expect(a.mix.coveragePct).toBe(100);
		expect(a.mix.expectedPct).toBeCloseTo(20, 10);
		expect(a.assessment.findings.map((f) => [f.code, f.weight])).toEqual([['headshots', 40]]);
		expect([a.assessment.score, a.assessment.level]).toEqual([40, 'review']);
	});

	test('minimum matched coverage is enforced, not just displayed', () => {
		const a = run([...m4(), ...sks()], [m4Fleet]);
		expect(a.mix.coveragePct).toBe(50);
		const row = a.weapons.find((r) => r.weapon === M4)!;
		expect(row.headshots.state).toBe('unavailable');
		expect(row.headshots.requirements.find((q) => !q.ok)!.label).toBe(
			'Matched coverage of eligible kills'
		);
		expect(a.assessment.findings.filter((f) => f.group === 'aim')).toEqual([]);
	});

	test('without self-exclusion the cohort would pass; with it the sample is too small', () => {
		// 499 other kills by 29 other players: the subject's 120 kills must not lift them over 500 / 30
		const a = run(m4(), [fleetCell(M4, 'Conquest', 619, 190, 30)]);
		const q = a.weapons[0].headshots.requirements;
		expect(q.find((r) => r.label === "Other players' kills")).toMatchObject({
			have: '499',
			ok: false
		});
		expect(q.find((r) => r.label === 'Other players')).toMatchObject({ have: '29', ok: false });
		expect(a.assessment.findings).toEqual([]);
	});

	test('a clipped read withholds the comparisons', () => {
		const a = run(m4(), [m4Fleet], true);
		expect(a.weapons[0].headshots.requirements[0]).toMatchObject({
			have: 'withheld (row limit reached)',
			ok: false
		});
		expect(a.assessment.findings.filter((f) => f.group === 'aim')).toEqual([]);
	});

	test('exclusions are counted, and the charts see only what they should', () => {
		const a = run(
			[
				...m4().slice(0, 10),
				kill({ ts: T0, teamKill: true, victimFaction: 'A' }),
				kill({ ts: T0, victimFaction: null }),
				kill({ ts: T0, cause: 'Id.Item.C4Explosive' }),
				kill({ ts: scoring.from - 1 })
			],
			[m4Fleet]
		);
		expect(a.eligible.kills).toBe(10);
		expect(a.excluded).toEqual({ unscored: 1, teamKill: 1, enemyUnknown: 1 });
		expect(a.distance.bins.reduce((n, b) => n + b.kills, 0)).toBe(10);
		// the timeline covers the history window, so the older kill is on it too
		expect(a.timeline.reduce((n, d) => n + d.kills, 0)).toBe(14);
		expect(a.burst.used).toBe(10);
	});
});

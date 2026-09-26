// Player intelligence settings: one Zod schema for every reader (browser, API, worker, imports)
// and the defaults an organisation starts from. Client-safe; no database. Phase 1 reads only
// DEFAULT_CONFIG; phase 2 persists an organisation's own copy (docs/intelligence/plan.md §4).
import { z } from 'zod';
import { DEFAULT_WEAPON_OVERRIDES, SCORED_WEAPON_TAGS } from './weapons';

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const rule = z
	.object({
		enabled: z.boolean(),
		weight: integer(0, 100),
		minKills: integer(1, 100000),
		ratio: z.number().min(1).max(20),
		gapPoints: z.number().min(0).max(100)
	})
	.strict();
const longRule = rule.extend({
	distanceM: integer(1, 5000),
	minPeerKills: integer(10, 1000000),
	minPeerPlayers: integer(2, 10000)
});
const overrides = z
	.object({
		headshots: rule.partial().optional(),
		longRange: longRule.partial().optional()
	})
	.strict();

export const IntelligenceConfigSchema = z
	.object({
		schemaVersion: z.literal(1),
		enabled: z.boolean(),
		mode: z.enum(['shadow', 'review']),
		lookbackDays: integer(1, 90),
		// One cohort definition (plan R11): the exact weapon tag, across every mode and map.
		baseline: z
			.object({
				lookbackDays: integer(1, 90),
				minPeerKills: integer(10, 1000000),
				minPeerPlayers: integer(2, 10000),
				minComparableCoveragePct: integer(0, 100),
				sinceUtc: z.iso.datetime().nullable(),
				label: z.string().max(100)
			})
			.strict(),
		filters: z
			.object({
				requireKnownEnemy: z.boolean(),
				excludeTeamKills: z.boolean(),
				// Explicit allowlist: causeKind('weapon') also includes explosives and tools.
				scoredWeaponTags: z.array(z.string().min(1).max(160)).min(1).max(200)
			})
			.strict(),
		rules: z
			.object({
				headshots: rule,
				longRange: longRule,
				burst: z
					.object({
						enabled: z.boolean(),
						weight: integer(0, 100),
						windowSeconds: integer(10, 300),
						minKills: integer(2, 1000),
						minDistinctVictims: integer(2, 1000)
					})
					.strict()
			})
			.strict(),
		weaponOverrides: z.record(z.string().min(1).max(160), overrides),
		thresholds: z
			.object({
				watch: integer(1, 98),
				review: integer(2, 99),
				priority: integer(3, 100)
			})
			.strict(),
		display: z
			.object({
				timezone: z
					.string()
					.max(100)
					.refine((v) => {
						try {
							new Intl.DateTimeFormat('en', { timeZone: v });
							return true;
						} catch {
							return false;
						}
					}, 'Use an IANA time zone, such as UTC or America/New_York'),
				distanceEdgesM: z.array(integer(1, 5000)).min(2).max(20),
				sessionPageSize: integer(10, 100),
				panels: z
					.object({
						timeline: z.boolean(),
						distance: z.boolean(),
						activity: z.boolean(),
						weapons: z.boolean(),
						sessions: z.boolean(),
						opponents: z.boolean(),
						steam: z.boolean(),
						network: z.boolean()
					})
					.strict()
			})
			.strict(),
		steam: z
			.object({
				enabled: z.boolean(),
				appId: integer(1, 2147483647).nullable(),
				refreshHours: integer(1, 168),
				friendsRefreshDays: integer(1, 30),
				maxFriends: integer(0, 500),
				fields: z
					.object({
						level: z.boolean(),
						badges: z.boolean(),
						ownedGames: z.boolean(),
						recentGames: z.boolean(),
						achievements: z.boolean(),
						friendLinks: z.boolean()
					})
					.strict()
			})
			.strict(),
		network: z
			.object({
				enabled: z.boolean(),
				lookbackDays: integer(1, 30),
				coJoinSeconds: integer(10, 600),
				minOverlaps: integer(2, 100),
				minSharedMinutes: integer(1, 1440),
				maxPeers: integer(5, 100)
			})
			.strict(),
		board: z
			.object({
				minLevel: z.enum(['watch', 'review', 'priority']),
				cooldownMinutes: integer(1, 1440),
				snapshotRetentionDays: integer(7, 365)
			})
			.strict(),
		worker: z
			.object({
				refreshSeconds: integer(30, 3600),
				maxPlayersPerJob: integer(1, 100)
			})
			.strict()
	})
	.strict()
	.superRefine((c, ctx) => {
		const issue = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: 'custom', path, message });
		if (!(c.thresholds.watch < c.thresholds.review && c.thresholds.review < c.thresholds.priority))
			issue(['thresholds'], 'Require watch < review < priority');
		if (c.rules.burst.minDistinctVictims > c.rules.burst.minKills)
			issue(['rules', 'burst'], 'Distinct-victim minimum cannot exceed kill minimum');
		if (c.display.distanceEdgesM.some((v, i, a) => i > 0 && v <= a[i - 1]))
			issue(['display', 'distanceEdgesM'], 'Distance edges must increase strictly');
		if (Object.keys(c.weaponOverrides).length > 200)
			issue(['weaponOverrides'], 'At most 200 weapon overrides');
		for (const tag of Object.keys(c.weaponOverrides))
			if (!c.filters.scoredWeaponTags.includes(tag))
				issue(['weaponOverrides', tag], 'Add this tag to scoredWeaponTags first');
		if (new Set(c.filters.scoredWeaponTags).size !== c.filters.scoredWeaponTags.length)
			issue(['filters', 'scoredWeaponTags'], 'Remove duplicate tags');
	});

export type IntelligenceConfig = z.infer<typeof IntelligenceConfigSchema>;

export const DEFAULT_CONFIG: IntelligenceConfig = IntelligenceConfigSchema.parse({
	schemaVersion: 1,
	enabled: false,
	mode: 'shadow',
	lookbackDays: 7,
	baseline: {
		lookbackDays: 30,
		minPeerKills: 500,
		minPeerPlayers: 30,
		minComparableCoveragePct: 80,
		sinceUtc: null,
		label: ''
	},
	filters: {
		requireKnownEnemy: true,
		excludeTeamKills: true,
		// Plan R5: the weapon catalog decides which exact tags are scored.
		scoredWeaponTags: SCORED_WEAPON_TAGS
	},
	rules: {
		headshots: { enabled: true, weight: 40, minKills: 100, ratio: 1.8, gapPoints: 15 },
		longRange: {
			enabled: true,
			weight: 55,
			minKills: 30,
			ratio: 2.5,
			gapPoints: 15,
			distanceM: 150,
			minPeerKills: 200,
			minPeerPlayers: 20
		},
		burst: { enabled: true, weight: 25, windowSeconds: 60, minKills: 10, minDistinctVictims: 5 }
	},
	// Plan R10: the long-range cutoff per weapon class, off for SMGs, pistols and shotguns.
	weaponOverrides: DEFAULT_WEAPON_OVERRIDES,
	thresholds: { watch: 20, review: 40, priority: 70 },
	display: {
		timezone: 'UTC',
		distanceEdgesM: [25, 50, 100, 150, 250],
		sessionPageSize: 25,
		panels: {
			timeline: true,
			distance: true,
			activity: true,
			weapons: true,
			sessions: true,
			opponents: true,
			steam: true,
			network: true
		}
	},
	steam: {
		enabled: true,
		appId: 1867240,
		refreshHours: 24,
		friendsRefreshDays: 7,
		maxFriends: 200,
		fields: {
			level: true,
			badges: false,
			ownedGames: true,
			recentGames: true,
			achievements: false,
			friendLinks: false
		}
	},
	network: {
		enabled: false,
		lookbackDays: 7,
		coJoinSeconds: 60,
		minOverlaps: 3,
		minSharedMinutes: 10,
		maxPeers: 30
	},
	board: { minLevel: 'watch', cooldownMinutes: 60, snapshotRetentionDays: 90 },
	worker: { refreshSeconds: 120, maxPlayersPerJob: 25 }
});

/** The headshot and long-range rules for one weapon: the organisation's, with its override on top. */
export function weaponRules(c: IntelligenceConfig, tag: string) {
	const o = c.weaponOverrides[tag];
	return {
		headshots: { ...c.rules.headshots, ...o?.headshots },
		longRange: { ...c.rules.longRange, ...o?.longRange }
	};
}

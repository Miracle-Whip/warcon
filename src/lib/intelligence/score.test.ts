// The appendix tests of docs/intelligence/plan.md, on Bun's runner.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, IntelligenceConfigSchema } from './config';
import { assessIntelligence, maxRollingBurst, type Comparison, type Evidence } from './score';

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), enabled: true });
const row = (): Comparison => ({
	cohortId: 'Id.Item.M4',
	weapon: 'Id.Item.M4',
	subject: { kills: 100, headshots: 60 },
	peers: { kills: 1000, headshots: 200, players: 50 },
	longRange: {
		subject: { kills: 40, headshots: 25 },
		peers: { kills: 500, headshots: 100, players: 30 }
	}
});
const evidence = (): Evidence => ({
	comparisons: [row()],
	comparableCoveragePct: 100,
	burst: { kills: 10, distinctVictims: 5, windowSeconds: 60, reliable: true }
});

describe('configuration', () => {
	test('defaults validate and start disabled in shadow mode', () => {
		expect(IntelligenceConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
		expect(DEFAULT_CONFIG.enabled).toBe(false);
		expect(DEFAULT_CONFIG.mode).toBe('shadow');
	});

	test('thresholds must increase; unknown properties rejected', () => {
		const c = config();
		c.thresholds.review = 10;
		expect(IntelligenceConfigSchema.safeParse(c).success).toBe(false);
		expect(IntelligenceConfigSchema.safeParse({ ...config(), autoban: true }).success).toBe(false);
	});

	test('invalid distance edges and timezone rejected', () => {
		const c = config();
		c.display.distanceEdgesM = [50, 25];
		expect(IntelligenceConfigSchema.safeParse(c).success).toBe(false);
		c.display.distanceEdgesM = [25, 50];
		c.display.timezone = 'Moon/Base';
		expect(IntelligenceConfigSchema.safeParse(c).success).toBe(false);
	});
});

describe('assessIntelligence', () => {
	test('correlated aim flags count once, plus burst: 55 + 25', () => {
		const result = assessIntelligence(config(), evidence());
		expect(result.findings.length).toBe(3);
		expect(result.score).toBe(80);
		expect(result.level).toBe('priority');
	});

	test('duplicate/weapons aim flags never multiply the aim contribution', () => {
		const e = evidence();
		e.comparisons.push(row());
		expect(assessIntelligence(config(), e).score).toBe(80);
	});

	test('configuration takes effect without changing score code', () => {
		const c = config();
		c.rules.longRange.enabled = false;
		c.rules.headshots.weight = 20;
		expect(assessIntelligence(c, evidence()).score).toBe(45);
	});

	test('weapon overrides are applied', () => {
		const c = config();
		c.weaponOverrides['Id.Item.M4'] = { headshots: { weight: 10 }, longRange: { enabled: false } };
		expect(assessIntelligence(c, evidence()).score).toBe(35);
	});

	test('missing evidence is unknown, not zero risk', () => {
		const e: Evidence = { comparisons: [], comparableCoveragePct: 0, burst: null };
		const result = assessIntelligence(config(), e);
		expect(result.score).toBe(null);
		expect(result.state).toBe('insufficient_data');
	});

	test('disabled module cannot return findings', () => {
		const r = assessIntelligence(DEFAULT_CONFIG, evidence());
		expect(r.score).toBe(null);
		expect(r.findings).toEqual([]);
	});

	test('small cohort is insufficient, not suspicious', () => {
		const e = evidence();
		e.burst = null;
		e.comparisons[0].peers.players = 1;
		e.comparisons[0].longRange.peers.players = 1;
		expect(assessIntelligence(config(), e).score).toBe(null);
	});

	test('zero peer headshots is not infinite-strength evidence', () => {
		const e = evidence();
		e.burst = null;
		e.comparisons[0].peers.headshots = 0;
		e.comparisons[0].longRange.peers.headshots = 0;
		expect(assessIntelligence(config(), e).score).toBe(null);
	});

	test('insufficient comparable coverage disables comparisons', () => {
		const e = evidence();
		e.burst = null;
		e.comparableCoveragePct = 20;
		expect(assessIntelligence(config(), e).score).toBe(null);
	});

	test('invalid headshot count is not scored', () => {
		const e = evidence();
		e.burst = null;
		e.comparisons[0].subject.headshots = 200;
		e.comparisons[0].longRange.subject.headshots = 200;
		expect(assessIntelligence(config(), e).score).toBe(null);
	});

	test('unreliable timing blocks burst, still permits other evidence', () => {
		const e = evidence();
		e.burst!.reliable = false;
		expect(assessIntelligence(config(), e).score).toBe(55);
	});

	test('one repeated victim cannot satisfy a burst rule', () => {
		const e = evidence();
		e.comparisons = [];
		e.burst!.distinctVictims = 1;
		expect(assessIntelligence(config(), e).score).toBe(0);
	});
});

describe('maxRollingBurst', () => {
	test('sliding window works across minute boundaries and excludes exact left edge', () => {
		const r = maxRollingBurst(
			[59, 61, 119].map((seconds, i) => ({ segment: 'boot1:round1', seconds, victim: String(i) })),
			60
		);
		expect(r!.kills).toBe(2);
	});

	test('different clock segments never combine', () => {
		const r = maxRollingBurst(
			[
				{ segment: 'A', seconds: 5, victim: 'x' },
				{ segment: 'B', seconds: 6, victim: 'y' }
			],
			60
		);
		expect(r!.kills).toBe(1);
	});

	test('rule scan can find a qualifying window even if the maximum farms one victim', () => {
		const events = Array.from({ length: 20 }, (_, seconds) => ({
			segment: 'A',
			seconds,
			victim: 'same'
		}));
		events.push(
			...Array.from({ length: 10 }, (_, i) => ({
				segment: 'A',
				seconds: 200 + i,
				victim: String(i)
			}))
		);
		expect(maxRollingBurst(events, 60)!.kills).toBe(20);
		expect(maxRollingBurst(events, 60, 5)!.kills).toBe(10);
	});

	test('unknown clock segment suppresses burst output', () => {
		expect(maxRollingBurst([{ segment: '', seconds: 2, victim: 'x' }], 60)).toBe(null);
	});
});

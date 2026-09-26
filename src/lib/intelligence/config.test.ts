// The defaults are seeded from the weapon catalog (plan R5, R10), not a hand-written list.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, IntelligenceConfigSchema, weaponRules } from './config';
import { DEFAULT_WEAPON_OVERRIDES, SCORED_WEAPON_TAGS, weaponInfo } from './weapons';

describe('DEFAULT_CONFIG seeding', () => {
	test('scored tags and overrides come straight from the catalog', () => {
		expect(DEFAULT_CONFIG.filters.scoredWeaponTags).toEqual(SCORED_WEAPON_TAGS);
		expect(DEFAULT_CONFIG.weaponOverrides).toEqual(DEFAULT_WEAPON_OVERRIDES);
		expect(SCORED_WEAPON_TAGS.length).toBe(26);
	});

	test('every scored tag is a scored class in the catalog; bows, explosives and tools are not', () => {
		for (const tag of DEFAULT_CONFIG.filters.scoredWeaponTags)
			expect(weaponInfo(tag).scored).toBe(true);
		for (const tag of [
			'Id.Item.CombatBow',
			'Id.Item.M67Grenade',
			'ID.Item.ATMine',
			'Id.Item.Fists'
		])
			expect(DEFAULT_CONFIG.filters.scoredWeaponTags).not.toContain(tag);
	});

	test('long-range cutoffs follow the weapon class', () => {
		const lr = (tag: string) => weaponRules(DEFAULT_CONFIG, tag).longRange;
		expect(lr('Id.Item.M4')).toMatchObject({ enabled: true, distanceM: 150 });
		expect(lr('Id.Item.M249')).toMatchObject({ enabled: true, distanceM: 150 });
		expect(lr('Id.Item.SKS')).toMatchObject({ enabled: true, distanceM: 200 });
		expect(lr('Id.Item.Mosin')).toMatchObject({ enabled: true, distanceM: 300 });
		for (const tag of ['Id.Item.Vector', 'Id.Item.Glock17', 'Id.Item.M500'])
			expect(lr(tag).enabled).toBe(false);
	});

	test('the seeded config survives a round trip through the schema', () => {
		const again = IntelligenceConfigSchema.parse(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
		expect(again).toEqual(DEFAULT_CONFIG);
	});

	test('an override for an unscored tag is refused', () => {
		const c = structuredClone(DEFAULT_CONFIG);
		c.weaponOverrides['Id.Item.CombatBow'] = { longRange: { enabled: false } };
		expect(IntelligenceConfigSchema.safeParse(c).success).toBe(false);
	});
});

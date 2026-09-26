// src/lib/intelligence/weapons.ts
//
// In-game (shop) names, classes and scoring rules for the kill feed's cause tags.
//
// Stored data is never changed: kills.cause keeps the raw tag the game sends
// (`Id.Item.WEPN_029`), and every statistic groups by that tag. This file only
// decides how a tag is displayed, which class it belongs to, and whether the
// player-intelligence rules score it.
//
// Names and classes: wardogs.zone weapons and vehicles databases, checked
// 2026-09-26. Their item URLs are the tag's own segments in lower case
// (/database/wepn_029 = Id.Item.WEPN_029), which is what makes the mapping exact.
// Anything not listed falls back to upstream Warcon's causeLabel(), and is shown
// but never scored until someone classifies it here.

import { causeLabel } from '$lib/causes';

export type WeaponClass =
	| 'assault_rifle'
	| 'marksman'
	| 'sniper'
	| 'lmg'
	| 'smg'
	| 'pistol'
	| 'shotgun'
	| 'bow'
	| 'launcher'
	| 'explosive'
	| 'melee'
	| 'tool'
	| 'vehicle'
	| 'vehicle_weapon'
	| 'buildable'
	| 'unknown';

/** Classes whose kills the headshot and long-range rules may score. */
const SCORED_CLASSES = new Set<WeaponClass>([
	'assault_rifle',
	'marksman',
	'sniper',
	'lmg',
	'smg',
	'pistol',
	'shotgun'
]);

/**
 * Distance at which a kill counts as long range, per class. null turns the
 * long-range rule off for that class: pistols, SMGs and shotguns almost never
 * reach it, so it could only ever report "no evidence". Chosen from this
 * deployment's averages on 2026-09-26 (sniper 136-256 m, marksman 92-112 m,
 * assault rifle 23-44 m, SMG 24-31 m, pistol 5-20 m). With one 150 m cutoff for
 * everything, most sniper kills would already be "long range" and the rule could
 * not tell a good sniper from anyone else.
 */
export const LONG_RANGE_M: Record<WeaponClass, number | null> = {
	assault_rifle: 150,
	lmg: 150,
	marksman: 200,
	sniper: 300,
	smg: null,
	pistol: null,
	shotgun: null,
	bow: null,
	launcher: null,
	explosive: null,
	melee: null,
	tool: null,
	vehicle: null,
	vehicle_weapon: null,
	buildable: null,
	unknown: null
};

interface Entry {
	name: string;
	class: WeaponClass;
}

/** Id.Item.<code> / ID.Item.<code>, keyed by <code> in lower case. */
const ITEMS: Record<string, Entry> = {
	// Assault rifles
	wepn_029: { name: 'Galil', class: 'assault_rifle' },
	m4: { name: 'M4', class: 'assault_rifle' },
	ak74m: { name: 'AK74', class: 'assault_rifle' },
	wepn_033: { name: 'Bushmaster M17S', class: 'assault_rifle' },
	wepn_030: { name: 'FAL', class: 'assault_rifle' }, // not yet seen in this deployment's feed
	kh2002: { name: 'KH-2002', class: 'assault_rifle' },
	tar21: { name: 'T-21', class: 'assault_rifle' },
	a91: { name: 'A-91', class: 'assault_rifle' },
	// Marksman rifles
	rfb: { name: 'BMR-308', class: 'marksman' }, // not yet seen
	sks: { name: 'SKS', class: 'marksman' },
	svdm: { name: 'SVD', class: 'marksman' },
	// Sniper rifles
	sr_04: { name: 'AMR 50', class: 'sniper' }, // not yet seen
	mk22: { name: 'MK22', class: 'sniper' },
	mosin: { name: 'Mosin Nagant', class: 'sniper' },
	wepn_035: { name: 'Scout Rifle TD', class: 'sniper' },
	sv98: { name: 'SV98', class: 'sniper' },
	// Light machine guns
	m249: { name: 'M249 SAW', class: 'lmg' },
	lmg_02: { name: 'PKM', class: 'lmg' },
	// SMGs
	mp9: { name: 'AMP-9', class: 'smg' },
	wepn_028: { name: 'MP5', class: 'smg' },
	smg_03: { name: 'PP-19 Vityaz', class: 'smg' },
	vector: { name: 'Super-45', class: 'smg' },
	// Pistols
	wepn_027: { name: 'Deagle', class: 'pistol' },
	glock17: { name: 'GGX 17', class: 'pistol' },
	wepn_032: { name: 'GGX 18', class: 'pistol' },
	judge: { name: 'Judge', class: 'pistol' },
	wepn_026: { name: 'M1911', class: 'pistol' },
	// Shotguns
	m500: { name: 'M500', class: 'shotgun' },
	mp43: { name: 'MP43', class: 'shotgun' },
	// Bow: arrow drop and a small sample make headshot comparisons meaningless
	combatbow: { name: 'Compound Bow', class: 'bow' },
	// Launchers
	launcher_04: { name: '9K333 Verba', class: 'launcher' },
	cgm4: { name: 'MAAWS', class: 'launcher' },
	mmgl: { name: 'MGL-40', class: 'launcher' },
	rpg7: { name: 'RPG-7', class: 'launcher' },
	// Explosives: distance is from the placement or throw, not a shot
	m67grenade: { name: 'M67 grenade', class: 'explosive' },
	c4explosive: { name: 'C4', class: 'explosive' },
	claymore: { name: 'Claymore', class: 'explosive' },
	atmine: { name: 'AT mine', class: 'explosive' },
	'ied.explosive': { name: 'IED', class: 'explosive' },
	// Melee and tools
	fists: { name: 'Fists', class: 'melee' },
	crowbar: { name: 'Crowbar', class: 'melee' },
	'defibrillator.standard': { name: 'Defibrillator', class: 'tool' },
	'buildtool.hammer.large': { name: 'Hammer (large)', class: 'tool' },
	'buildtool.hammer.medium': { name: 'Hammer (medium)', class: 'tool' },
	'buildtool.hammer.small': { name: 'Hammer (small)', class: 'tool' }
};

/** Vehicle.Variant.<path>, keyed by <path> in lower case. The vehicle itself as the cause. */
const VEHICLES: Record<string, string> = {
	'air.rotary.littlebird.default': 'MH-6',
	'air.rotary.littlebird.mountedmachineguns': 'AH-6M (miniguns)',
	'air.rotary.littlebird.rocketpods': 'AH-6R (rockets)',
	'air.rotary.havoc.default': 'Havoc',
	'air.rotary.rot_04.default': 'Z20 Lakota',
	'air.rotary.rot_04.mountedmachineguns': 'Z20 Lakota (miniguns)',
	'land.tracked.tnk_01.antiair': 'Flakpanzer Gepard',
	'land.tracked.tnk_01.heavy': 'L2A6',
	'land.tracked.tnk_01.artillery': 'SPH-2',
	'land.tracked.spawnvehicle.lonestar': 'M113 APC SV (Lonestar)',
	'land.tracked.spawnvehicle.manticore': 'M113 APC SV (Manticore)',
	'land.tracked.spawnvehicle.valkyra': 'M113 APC SV (Valkyra)',
	'land.wheeled.bobcat.default': 'Bobcat',
	'land.wheeled.dunebuggy.default': 'Dune Buggy',
	'land.wheeled.humvee.default': 'Humvee',
	'land.wheeled.humvee.machinegun': 'Humvee (M249)',
	'land.wheeled.humvee.minigun': 'Humvee (minigun)',
	'land.wheeled.kodiak.default': 'Kodiak',
	'land.wheeled.kodiak.machinegun': 'Kodiak (M249)',
	'land.wheeled.kodiak.pickup': 'Kodiak (pickup)',
	'land.wheeled.ural.default': 'URAL',
	'land.wheeled.ural.battle': 'Ural Defender',
	'land.wheeled.ural.attack': 'Ural Defender (M249)',
	'stationary.loudspeaker': 'Loudspeaker',
	'stationary.mistralaa': 'Talon 9K-SAM',
	'stationary.mortar': 'L81 Mortar',
	'stationary.phalanx': 'Vanguard CIWS',
	'stationary.stn_05': 'Stingray'
};

/**
 * Id.Vehicle.WeaponExtension.<mount>.<weapon>, keyed in lower case. Only mounts
 * that match a named vehicle exactly are listed. Still unconfirmed, so left on
 * upstream's codename labels until checked in game: STN_02, STN_03, ROT_02,
 * ROT_03, WHL_02 and WHL_05.
 */
const VEHICLE_WEAPONS: Record<string, string> = {
	'tnk_01.artillery': 'SPH-2 (gun)',
	'tnk_01.mountedmachinegun': 'TNK-01 (mounted MG)',
	'stn_01.mistralaa': 'Talon 9K-SAM',
	'stn_05.mainbarrel': 'Stingray (gun)',
	'rot_04.mountedmachinegun': 'Z20 Lakota (mounted MG)'
};

export interface WeaponInfo {
	tag: string;
	name: string;
	class: WeaponClass;
	/** Whether the headshot/long-range rules may score kills with it. */
	scored: boolean;
	/** Long-range cutoff for this weapon, or null when the rule does not apply. */
	longRangeM: number | null;
	/** False when the tag is not in this file and the name is upstream's fallback. */
	known: boolean;
}

function prefixClass(t: string): WeaponClass {
	if (t.startsWith('id.vehicle.weaponextension.')) return 'vehicle_weapon';
	if (t.startsWith('vehicle.')) return 'vehicle';
	if (t.startsWith('id.buildable.')) return 'buildable';
	return 'unknown';
}

/** Display name, class and scoring for any cause tag. Never throws. */
export function weaponInfo(tag: string | null | undefined): WeaponInfo {
	if (!tag)
		return { tag: '', name: '', class: 'unknown', scored: false, longRangeM: null, known: false };
	const t = tag.toLowerCase();
	let name: string | undefined;
	let cls: WeaponClass | undefined;
	if (t.startsWith('id.item.')) {
		const e = ITEMS[t.slice('id.item.'.length)];
		if (e) ({ name, class: cls } = e);
	} else if (t.startsWith('vehicle.variant.')) {
		name = VEHICLES[t.slice('vehicle.variant.'.length)];
		if (name) cls = 'vehicle';
	} else if (t.startsWith('id.vehicle.weaponextension.')) {
		name = VEHICLE_WEAPONS[t.slice('id.vehicle.weaponextension.'.length)];
		if (name) cls = 'vehicle_weapon';
	}
	const known = name !== undefined;
	const klass = cls ?? prefixClass(t);
	return {
		tag,
		name: name ?? causeLabel(tag),
		class: klass,
		scored: known && SCORED_CLASSES.has(klass),
		longRangeM: known ? LONG_RANGE_M[klass] : null,
		known
	};
}

/** Every Id.Item tag seen in this deployment's feed up to 2026-09-26, exactly as sent. */
export const OBSERVED_ITEM_TAGS = [
	'Id.Item.WEPN_029',
	'Id.Item.M4',
	'Id.Item.AK74M',
	'Id.Item.SVDM',
	'Id.Item.Mosin',
	'Id.Item.SKS',
	'Id.Item.TAR21',
	'Id.Item.Vector',
	'Id.Item.MP9',
	'Id.Item.M249',
	'Id.Item.SV98',
	'Id.Item.M500',
	'Id.Item.WEPN_032',
	'Id.Item.SMG_03',
	'Id.Item.WEPN_028',
	'Id.Item.CombatBow',
	'Id.Item.M67Grenade',
	'Id.Item.KH2002',
	'Id.Item.Glock17',
	'Id.Item.MP43',
	'Id.Item.Launcher_04',
	'Id.Item.A91',
	'Id.Item.WEPN_035',
	'Id.Item.WEPN_027',
	'Id.Item.WEPN_033',
	'Id.Item.WEPN_026',
	'Id.Item.RPG7',
	'Id.Item.Defibrillator.Standard',
	'ID.Item.ATMine',
	'Id.Item.CGM4',
	'Id.Item.C4Explosive',
	'ID.Item.BuildTool.Hammer.Large',
	'Id.Item.LMG_02',
	'Id.Item.Fists',
	'Id.Item.MK22',
	'Id.Item.Claymore',
	'ID.Item.BuildTool.Hammer.Medium',
	'Id.Item.Judge',
	'Id.Item.MMGL',
	'Id.Item.IED.Explosive',
	'Id.Item.Crowbar',
	'ID.Item.BuildTool.Hammer.Small'
] as const;

/**
 * Seed for DEFAULT_CONFIG.filters.scoredWeaponTags: exact tags, because the
 * config and the kills table match on the exact string. A weapon that has never
 * appeared in the feed is added here once its real tag is seen.
 */
export const SCORED_WEAPON_TAGS: string[] = OBSERVED_ITEM_TAGS.filter((t) => weaponInfo(t).scored);

/**
 * Seed for DEFAULT_CONFIG.weaponOverrides: the long-range cutoff per weapon.
 * Assault rifles and LMGs use the rule's default (150 m) and need no entry.
 */
export const DEFAULT_WEAPON_OVERRIDES: Record<
	string,
	{ longRange: { enabled: false } | { distanceM: number } }
> = Object.fromEntries(
	SCORED_WEAPON_TAGS.flatMap((tag) => {
		const m = weaponInfo(tag).longRangeM;
		if (m === 150) return [];
		return [[tag, { longRange: m === null ? { enabled: false as const } : { distanceM: m } }]];
	})
);

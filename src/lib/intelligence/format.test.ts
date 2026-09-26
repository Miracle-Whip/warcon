import { describe, expect, test } from 'bun:test';
import { kdText, pctText, presenceOf, shareText, STALE_OBSERVATION_MS } from './format';

describe('kdText', () => {
	test('a ratio when there are deaths, the counts when there are none', () => {
		expect(kdText(30, 12)).toBe('2.50');
		expect(kdText(7, 0)).toBe('7 kills / 0 deaths');
		expect(kdText(1, 0)).toBe('1 kill / 0 deaths');
		expect(kdText(0, 0)).toBe('—');
		expect(kdText(0, 4)).toBe('0.00');
	});
});

describe('shares', () => {
	test('one decimal, and a dash for nothing to divide', () => {
		expect(pctText(38.4567)).toBe('38.5%');
		expect(pctText(null)).toBe('—');
		expect(pctText(Number.NaN)).toBe('—');
		expect(shareText({ kills: 200, headshots: 77 })).toBe('38.5% (77/200)');
		expect(shareText({ kills: 0, headshots: 0 })).toBe('—');
	});
});

describe('presenceOf', () => {
	const now = Date.UTC(2026, 8, 26, 12);
	const at = (ms: number) => new Date(now - ms).toISOString();
	const open = (ago: number) => ({ serverId: 's', serverName: 'S', lastSeen: at(ago) });

	test('an open session freshly observed is online', () => {
		expect(presenceOf(open(30_000), at(30_000), now).state).toBe('online');
	});

	test('an open session the poller has not looked at lately is unknown, not online or offline', () => {
		expect(presenceOf(open(STALE_OBSERVATION_MS + 1), at(0), now).state).toBe('unknown');
	});

	test('no open session is offline, with the last observation when there is one', () => {
		expect(presenceOf(null, at(60_000), now)).toEqual({ state: 'offline', lastSeen: at(60_000) });
		expect(presenceOf(null, null, now)).toEqual({ state: 'offline', lastSeen: null });
	});
});

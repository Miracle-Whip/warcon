import { describe, expect, test } from 'bun:test';
import { parseServerFilter, resolveScope } from './scope-core';

const permitted = [
	{ id: 'b', name: 'Bravo' },
	{ id: 'a', name: 'Alpha' },
	{ id: 'c', name: 'Charlie' }
];

describe('resolveScope', () => {
	test('no filter is every permitted server, by name', () => {
		expect(resolveScope(permitted, null)).toEqual({
			ok: true,
			servers: [
				{ id: 'a', name: 'Alpha' },
				{ id: 'b', name: 'Bravo' },
				{ id: 'c', name: 'Charlie' }
			]
		});
		expect(resolveScope(permitted, [])).toEqual(resolveScope(permitted, null));
	});

	test('a filter narrows to the requested servers, once each', () => {
		expect(resolveScope(permitted, ['c', 'a', 'c'])).toEqual({
			ok: true,
			servers: [
				{ id: 'a', name: 'Alpha' },
				{ id: 'c', name: 'Charlie' }
			]
		});
	});

	test('a requested server outside the permitted set is refused, not silently dropped', () => {
		expect(resolveScope(permitted, ['a', 'hidden'])).toEqual({ ok: false, forbidden: ['hidden'] });
		expect(resolveScope([], ['a'])).toEqual({ ok: false, forbidden: ['a'] });
	});
});

describe('parseServerFilter', () => {
	test('a comma list, trimmed; absent or blank is no filter', () => {
		expect(parseServerFilter(null)).toBe(null);
		expect(parseServerFilter(' , ')).toBe(null);
		expect(parseServerFilter('a, b,,c ')).toEqual(['a', 'b', 'c']);
	});

	test('bounded', () => {
		const many = Array.from({ length: 150 }, (_, i) => `s${i}`).join(',');
		expect(parseServerFilter(many)!.length).toBe(100);
	});
});

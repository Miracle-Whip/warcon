import { beforeEach, describe, expect, test } from 'bun:test';
import { clearFleetMemo, FLEET_TTL_MS, memoSize, memoise } from './memo';

describe('fleet memo', () => {
	beforeEach(() => clearFleetMemo());

	test('a value is reused for ten minutes, then read again', async () => {
		let reads = 0;
		const read = async () => ++reads;
		expect(await memoise('k', read, 0)).toBe(1);
		expect(await memoise('k', read, FLEET_TTL_MS - 1)).toBe(1);
		expect(await memoise('k', read, FLEET_TTL_MS)).toBe(2);
	});

	test('different keys never share a value', async () => {
		expect(await memoise('a', async () => 'A', 0)).toBe('A');
		expect(await memoise('b', async () => 'B', 0)).toBe('B');
	});

	test('callers arriving together share one read', async () => {
		let reads = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const read = async () => {
			reads++;
			await gate;
			return reads;
		};
		const both = Promise.all([memoise('k', read, 0), memoise('k', read, 1)]);
		release();
		expect(await both).toEqual([1, 1]);
		expect(reads).toBe(1);
	});

	test('a failed read is forgotten so the next caller tries again', async () => {
		await expect(memoise('k', async () => Promise.reject(new Error('db away')), 0)).rejects.toThrow(
			'db away'
		);
		expect(await memoise('k', async () => 'ok', 1)).toBe('ok');
	});

	test('a purge clears every baseline', async () => {
		await memoise('a', async () => 1, 0);
		await memoise('b', async () => 2, 0);
		expect(memoSize()).toBe(2);
		clearFleetMemo();
		expect(memoSize()).toBe(0);
		expect(await memoise('a', async () => 3, 1)).toBe(3);
	});

	test('the number of scopes held is bounded, oldest first out', async () => {
		for (let i = 0; i < 40; i++) await memoise(`k${i}`, async () => i, 0);
		expect(memoSize()).toBe(32);
		expect(await memoise('k0', async () => -1, 1)).toBe(-1);
		expect(await memoise('k39', async () => -1, 1)).toBe(39);
	});
});

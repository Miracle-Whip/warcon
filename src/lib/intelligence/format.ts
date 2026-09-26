// Display helpers for the intelligence page. Client-safe and pure.
import type { Counts } from './score';
import type { Presence } from './types';

/** Recorded-match K/D; with no deaths a ratio would mislead, so the counts are spelled out. */
export function kdText(kills: number, deaths: number): string {
	if (deaths > 0) return (kills / deaths).toFixed(2);
	if (kills > 0) return `${kills} kill${kills === 1 ? '' : 's'} / 0 deaths`;
	return '—';
}

/** "38.5%" to one decimal, or a dash when there is nothing to divide. */
export function pctText(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	return `${Math.round(value * 10) / 10}%`;
}

/** Headshots as a share of kills: "38.5% (77/200)". */
export function shareText(c: Counts): string {
	if (!c.kills) return '—';
	return `${pctText((100 * c.headshots) / c.kills)} (${c.headshots}/${c.kills})`;
}

/** Past this without a fresh look, an open session says nothing about whether they are on. */
export const STALE_OBSERVATION_MS = 5 * 60_000;

/**
 * Where the player is, as far as the poller last saw. An open session the poller has not looked
 * at for a while (it may be down) is "unknown", never "online" or "offline".
 */
export function presenceOf(
	open: { serverId: string; serverName: string; lastSeen: string } | null,
	lastSeen: string | null,
	now: number
): Presence {
	if (open)
		return {
			state: now - Date.parse(open.lastSeen) <= STALE_OBSERVATION_MS ? 'online' : 'unknown',
			...open
		};
	return { state: 'offline', lastSeen };
}

<script lang="ts">
	// "Who they kill" or "Who kills them", with headshots and the mean known distance.
	import { fmtNum } from '$lib/format';
	import { shareText } from '$lib/intelligence/format';
	import type { OpponentView } from '$lib/intelligence/types';

	let {
		rows,
		countLabel,
		hrefFor
	}: { rows: OpponentView[]; countLabel: string; hrefFor: (steamId: string) => string } = $props();
</script>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>Player</th>
				<th class="num">{countLabel}</th>
				<th class="num">Headshots</th>
				<th class="num">Avg distance</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as o (o.steamId)}
				<tr>
					<td
						><a href={hrefFor(o.steamId)} class="hover:text-accent hover:underline"
							>{o.name || o.steamId}</a
						></td
					>
					<td class="num">{fmtNum(o.kills)}</td>
					<td class="num">{shareText(o)}</td>
					<td class="num">{o.avgDistanceM === null ? '—' : `${fmtNum(o.avgDistanceM)} m`}</td>
				</tr>
			{:else}
				<tr><td colspan="4" class="py-6 text-center text-mist-600">Nobody in this window.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

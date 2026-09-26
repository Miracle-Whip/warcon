<script lang="ts">
	// Eligible kills by distance, with the headshot share in each bin. An unknown distance is its
	// own count, never zero metres.
	import { fmtNum } from '$lib/format';
	import { pctText } from '$lib/intelligence/format';
	import type { DistanceBin } from '$lib/intelligence/types';

	let { bins, unknown }: { bins: DistanceBin[]; unknown: number } = $props();

	let max = $derived(Math.max(1, ...bins.map((b) => b.kills)));
	let known = $derived(bins.reduce((n, b) => n + b.kills, 0));
</script>

{#if !known && !unknown}
	<p class="py-6 text-center text-[13px] text-mist-600">No eligible kills in the scoring window.</p>
{:else}
	<table class="w-full text-[13px]">
		<caption class="sr-only">Eligible kills by distance</caption>
		<thead class="sr-only"><tr><th>Distance</th><th>Kills</th><th>Headshot share</th></tr></thead>
		<tbody>
			{#each bins as b (b.label)}
				<tr>
					<th
						scope="row"
						class="w-24 py-1 pr-3 text-left font-normal whitespace-nowrap text-mist-400"
						>{b.label}</th
					>
					<td class="py-1">
						<div class="progress" aria-hidden="true">
							<span class="progress-bar" style="width:{(b.kills / max) * 100}%"></span>
						</div>
						<span class="sr-only">{b.kills}</span>
					</td>
					<td class="w-36 py-1 pl-3 text-right font-mono text-[12px] text-mist-400 tabular"
						>{fmtNum(b.kills)} · {b.kills ? pctText((100 * b.headshots) / b.kills) : '—'} hs</td
					>
				</tr>
			{/each}
		</tbody>
	</table>
	<p class="mt-2 text-[12.5px] text-mist-400">
		{fmtNum(known)} kill{known === 1 ? '' : 's'} with a known distance{#if unknown}, {fmtNum(
				unknown
			)}
			without one (not counted as zero){/if}.
	</p>
{/if}

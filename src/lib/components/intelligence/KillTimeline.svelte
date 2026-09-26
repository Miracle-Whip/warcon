<script lang="ts">
	// Kills per day by receipt time: when Warcon heard of them, not when they happened (bursts use
	// the match clock instead). Days inside the scoring window are shaded.
	import type { TimelineDay } from '$lib/intelligence/types';

	let { days, scoringFrom }: { days: TimelineDay[]; scoringFrom: string } = $props();

	let max = $derived(Math.max(1, ...days.map((d) => d.kills)));
	let total = $derived(days.reduce((n, d) => n + d.kills, 0));
	let busiest = $derived(days.reduce((a, d) => (d.kills > a.kills ? d : a), days[0]));
	let summary = $derived(
		total
			? `${total} kills over ${days.length} days; the busiest day was ${busiest.day} with ${busiest.kills}.`
			: `No kills in the last ${days.length} days.`
	);
	const h = (n: number) => `${(100 * n) / max}%`;
</script>

{#if !total}
	<p class="py-6 text-center text-[13px] text-mist-600">{summary}</p>
{:else}
	<div class="flex h-32 items-end gap-px" role="img" aria-label={summary}>
		{#each days as d (d.day)}
			<div
				class="flex h-full flex-1 flex-col justify-end {d.day >= scoringFrom
					? 'bg-white/[0.04]'
					: ''}"
				title="{d.day}: {d.kills} kills, {d.eligible} eligible, {d.headshots} eligible headshots"
			>
				<div class="bg-mist-600/70" style="height:{h(d.kills - d.eligible)}"></div>
				<div class="bg-accent/45" style="height:{h(d.eligible - d.headshots)}"></div>
				<div class="bg-accent" style="height:{h(d.headshots)}"></div>
			</div>
		{/each}
	</div>
	<div class="mt-1 flex justify-between font-mono text-[11px] text-mist-600">
		<span>{days[0].day}</span><span>{days[days.length - 1].day}</span>
	</div>
	<div class="mt-2 flex flex-wrap gap-3 text-[12px] text-mist-400">
		<span class="flex items-center gap-1"
			><i class="inline-block h-2 w-2 bg-accent"></i>eligible headshots</span
		>
		<span class="flex items-center gap-1"
			><i class="inline-block h-2 w-2 bg-accent/45"></i>other eligible kills</span
		>
		<span class="flex items-center gap-1"
			><i class="inline-block h-2 w-2 bg-mist-600/70"></i>not eligible</span
		>
		<span class="flex items-center gap-1"
			><i class="inline-block h-2 w-2 bg-white/[0.08]"></i>scoring window</span
		>
	</div>
	<p class="mt-2 text-[12.5px] text-mist-400">{summary}</p>
	<details class="mt-1 text-[12.5px]">
		<summary class="cursor-pointer text-mist-400">As a table</summary>
		<div class="mt-2 max-h-56 table-wrap">
			<table>
				<thead
					><tr
						><th>Day (UTC)</th><th class="num">Kills</th><th class="num">Eligible</th><th
							class="num">Headshots</th
						></tr
					></thead
				>
				<tbody>
					{#each days as d (d.day)}
						<tr
							><td class="font-mono">{d.day}</td><td class="num">{d.kills}</td><td class="num"
								>{d.eligible}</td
							><td class="num">{d.headshots}</td></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
{/if}

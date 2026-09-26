<script lang="ts">
	// The subject against every other player, per weapon and cohort, with the sample-size gates
	// spelled out. A row expands to the checks each rule made and what the data had.
	import Badge from '$lib/components/Badge.svelte';
	import { fmtNum } from '$lib/format';
	import { pctText, shareText } from '$lib/intelligence/format';
	import type { RuleView, WeaponRowView } from '$lib/intelligence/types';

	let {
		rows,
		flagged,
		cohortLabel
	}: {
		rows: WeaponRowView[];
		/** `${cohortId}|${rule}` of every finding */
		flagged: Set<string>;
		cohortLabel: (row: WeaponRowView) => string;
	} = $props();

	let open = $state<Record<string, boolean>>({});
	const ratio = (r: WeaponRowView) => {
		if (!r.subject.kills || !r.peers.kills || !r.peers.headshots) return '—';
		const s = r.subject.headshots / r.subject.kills;
		const p = r.peers.headshots / r.peers.kills;
		return `${(s / p).toFixed(2)}×`;
	};
	const CLASS: Record<string, string> = {
		assault_rifle: 'assault rifle',
		marksman: 'marksman',
		sniper: 'sniper',
		lmg: 'LMG',
		smg: 'SMG',
		pistol: 'pistol',
		shotgun: 'shotgun'
	};
</script>

{#snippet ruleChip(rule: RuleView, hit: boolean, name: string)}
	{#if hit}<Badge tone="warn" title="{name}: crossed its threshold">above</Badge>
	{:else if rule.state === 'eligible'}<Badge tone="ok" title="{name}: compared">compared</Badge>
	{:else if rule.state === 'off'}<Badge title="{name}: off for this weapon">off</Badge>
	{:else}<Badge title="{name}: not enough comparable evidence">insufficient</Badge>{/if}
{/snippet}

{#snippet checks(title: string, rule: RuleView)}
	<div>
		<div class="field-label">{title}</div>
		{#if rule.state === 'off'}
			<p class="text-mist-400">Off for this weapon's class.</p>
		{:else}
			<ul class="space-y-0.5">
				{#each rule.requirements as q (q.label)}
					<li class="flex gap-2">
						<span class={q.ok ? 'text-ok' : 'text-danger'} aria-hidden="true"
							>{q.ok ? '✓' : '✕'}</span
						>
						<span class="sr-only">{q.ok ? 'met' : 'not met'}:</span>
						<span>{q.label}: <span class="text-mist-400">needs {q.need}, has {q.have}</span></span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/snippet}

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>Weapon</th>
				<th>Cohort</th>
				<th class="num">Kills</th>
				<th class="num">Headshot share</th>
				<th class="num">Other players</th>
				<th class="num">Ratio</th>
				<th class="num">Long range</th>
				<th class="num">LR headshots</th>
				<th class="num">Others at LR</th>
				<th>Rules</th>
				<th><span class="sr-only">Details</span></th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.cohortId)}
				<tr>
					<td>
						<span title={r.weapon}>{r.name}</span>
						{#if CLASS[r.weaponClass]}<span class="block text-[11.5px] text-mist-600"
								>{CLASS[r.weaponClass]}</span
							>{/if}
					</td>
					<td class="text-mist-400">{cohortLabel(r)}</td>
					<td class="num">{fmtNum(r.subject.kills)}</td>
					<td class="num">{shareText(r.subject)}</td>
					<td class="num">
						{#if r.modeKnown}{shareText(r.peers)}<span class="block text-[11.5px] text-mist-600"
								>{fmtNum(r.peers.players)} player{r.peers.players === 1 ? '' : 's'}</span
							>{:else}—{/if}
					</td>
					<td class="num">{r.modeKnown ? ratio(r) : '—'}</td>
					<td class="num">{r.longRange.enabled ? `≥ ${r.longRange.distanceM} m` : 'off'}</td>
					<td class="num">
						{r.longRange.enabled
							? `${r.longRange.subject.headshots}/${r.longRange.subject.kills}`
							: '—'}
					</td>
					<td class="num">
						{#if r.longRange.enabled && r.modeKnown}{shareText(r.longRange.peers)}<span
								class="block text-[11.5px] text-mist-600"
								>{fmtNum(r.longRange.peers.players)} player{r.longRange.peers.players === 1
									? ''
									: 's'}</span
							>{:else}—{/if}
					</td>
					<td class="whitespace-nowrap">
						{@render ruleChip(
							r.headshots,
							flagged.has(`${r.cohortId}|headshots`),
							'Headshot share'
						)}
						{@render ruleChip(
							r.longRangeRule,
							flagged.has(`${r.cohortId}|longRange`),
							'Long-range headshots'
						)}
					</td>
					<td>
						<button
							class="btn btn-sm btn-ghost"
							aria-expanded={!!open[r.cohortId]}
							aria-label="Checks for {r.name}"
							onclick={() => (open[r.cohortId] = !open[r.cohortId])}
							>{open[r.cohortId] ? '▾' : '▸'}</button
						>
					</td>
				</tr>
				{#if open[r.cohortId]}
					<tr>
						<td colspan="11" class="bg-ink-900 text-[12.5px]">
							<div class="grid gap-4 py-1 md:grid-cols-2">
								{@render checks('Headshot share', r.headshots)}
								{@render checks(
									r.longRange.enabled
										? `Headshots among kills at ${r.longRange.distanceM} m or farther`
										: 'Long-range headshots',
									r.longRangeRule
								)}
							</div>
							<p class="mt-2 text-mist-600">
								{fmtNum(r.knownDistance)} of {fmtNum(r.subject.kills)} kills have a known distance{#if r.modeKnown && r.peers.kills};
									other players' share is {pctText((100 * r.peers.headshots) / r.peers.kills)}{/if}.
								Raw tag <span class="font-mono">{r.weapon}</span>.
							</p>
						</td>
					</tr>
				{/if}
			{:else}
				<tr>
					<td colspan="11" class="py-6 text-center text-mist-600">
						No eligible kills in the scoring window.
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

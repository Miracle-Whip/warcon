<script lang="ts">
	// Review priority: the score, its level and the findings behind it, then every rule that had
	// no usable evidence. A heuristic for where staff look first, never a probability of cheating.
	import Badge from '$lib/components/Badge.svelte';
	import type { Assessment } from '$lib/intelligence/score';
	import type { IntelligenceView } from '$lib/intelligence/types';

	let {
		assessment,
		settings,
		labelOf
	}: {
		assessment: Assessment;
		settings: IntelligenceView['settings'];
		/** a cohort id (the exact weapon tag) as people read it: the weapon's name */
		labelOf: (cohortId: string) => string;
	} = $props();

	const RULE = {
		headshots: 'Headshot share',
		longRange: 'Long-range headshots',
		burst: 'Kill burst'
	};
	const TONE = { priority: 'err', review: 'warn', watch: 'info', clear: 'ok' } as const;

	let headline = $derived(
		assessment.state === 'disabled'
			? 'off'
			: assessment.state === 'insufficient_data'
				? 'insufficient evidence'
				: `${assessment.level} · ${assessment.score}`
	);
	let tone = $derived<'' | (typeof TONE)[keyof typeof TONE]>(
		assessment.level ? TONE[assessment.level as keyof typeof TONE] : ''
	);

	/** "<weapon tag>: <rule> has insufficient comparable evidence", as people read it */
	let unavailable = $derived(
		assessment.unavailable.map((u) => {
			const m = /^(.*): (headshots|longRange) has insufficient comparable evidence$/.exec(u);
			return m ? `${labelOf(m[1])}: ${RULE[m[2] as 'headshots' | 'longRange'].toLowerCase()}` : u;
		})
	);
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0!">Review priority</span>
		<span class="ml-auto"><Badge {tone}>{headline}</Badge></span>
	</div>
	{#if assessment.findings.length}
		<ul class="space-y-2 text-[13px]">
			{#each assessment.findings as f, i (i)}
				<li class="flex gap-2">
					<span class="font-mono text-[12px] text-mist-600 tabular">+{f.weight}</span>
					<span>
						<b>{RULE[f.code]}</b>{#if f.cohortId}
							<span class="text-mist-400"> · {labelOf(f.cohortId)}</span>{/if}:
						{f.detail}.
					</span>
				</li>
			{/each}
		</ul>
	{:else if assessment.state === 'ready'}
		<p class="text-[13px] text-mist-400">
			{assessment.eligibleRules} rule check{assessment.eligibleRules === 1 ? '' : 's'} had enough comparable
			evidence, and none crossed its threshold.
		</p>
	{:else}
		<p class="text-[13px] text-mist-400">
			No rule had enough comparable evidence, so there is no score. That is expected while the kill
			feed is young: the comparisons need other players' kills on the same weapon first.
		</p>
	{/if}

	{#if unavailable.length}
		<details class="mt-3 text-[13px]">
			<summary class="cursor-pointer text-mist-400">
				{unavailable.length} rule check{unavailable.length === 1 ? '' : 's'} without usable evidence
			</summary>
			<ul class="mt-2 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-mist-400">
				{#each unavailable as u, i (i)}<li>{u}</li>{/each}
			</ul>
			<p class="mt-1 text-[12px] text-mist-600">
				The weapons table shows what each one is missing.
			</p>
		</details>
	{/if}

	<p class="note">
		Where staff might look first, not a probability of cheating. The score is the strongest aim
		finding (headshot share or long-range headshots, counted once however many weapons show it) plus
		the burst finding, capped at 100; with no usable evidence there is no score, not a low one.
		Levels: watch from {settings.thresholds.watch}, review from {settings.thresholds.review},
		priority from {settings.thresholds.priority}. Bans, reports, names, friends and playing hours
		never enter it, and it never reaches the connect-risk score or its kick rule.
	</p>
</div>

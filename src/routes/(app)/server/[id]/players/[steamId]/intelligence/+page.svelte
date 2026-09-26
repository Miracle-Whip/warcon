<script lang="ts">
	// A player's intelligence page (docs/intelligence/plan.md, phase 1): review priority, how the
	// player compares with everyone else on the same weapons, bursts on the match clock, and the
	// history behind them. Computed on demand from recorded data; review signals only.
	import Badge from '$lib/components/Badge.svelte';
	import DistanceHistogram from '$lib/components/intelligence/DistanceHistogram.svelte';
	import KillTimeline from '$lib/components/intelligence/KillTimeline.svelte';
	import OpponentTable from '$lib/components/intelligence/OpponentTable.svelte';
	import ReviewPriority from '$lib/components/intelligence/ReviewPriority.svelte';
	import WeaponTable from '$lib/components/intelligence/WeaponTable.svelte';
	import { expLabel, fmtAgo, fmtMinutes, fmtNum, fmtTime, mapLabel } from '$lib/format';
	import { kdText, pctText } from '$lib/intelligence/format';
	import type { IntelligenceView, WeaponRowView } from '$lib/intelligence/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let v = $derived<IntelligenceView>(data.intelligence);
	let id = $derived(data.server.id);
	let dossier = $derived(`/server/${encodeURIComponent(id)}/players/${v.steamId}`);
	let scopeIds = $derived(v.scope.servers.map((s) => s.id));
	let whole = $derived(scopeIds.length === v.scope.permitted.length);

	/** This page with the scope and session page it was opened with, changed as given. */
	function href(change: { servers?: string[] | null; sessions?: number }) {
		const q = new URLSearchParams();
		const servers = change.servers === undefined ? (whole ? null : scopeIds) : change.servers;
		if (servers?.length) q.set('servers', servers.join(','));
		const page = change.sessions ?? 1;
		if (page > 1) q.set('sessions', String(page));
		const s = q.toString();
		return `${dossier}/intelligence${s ? `?${s.replace(/%2C/g, ',')}` : ''}`;
	}

	const modeText = (mode: string | null) =>
		mode
			? mode
					.split('+')
					.filter(Boolean)
					.map((e) => expLabel(data.catalog, e))
					.join(' + ')
			: '';
	const cohortText = (r: Pick<WeaponRowView, 'mode' | 'map' | 'modeKnown'>) => {
		if (v.settings.cohort === 'weapon') return 'all modes';
		if (!r.modeKnown) return 'mode unknown';
		const mode = modeText(r.mode);
		return v.settings.cohort === 'weapon_mode_map' && r.map
			? `${mode} · ${mapLabel(data.catalog, r.map)}`
			: mode;
	};
	let byCohort = $derived(new Map(v.weapons.map((r) => [r.cohortId, r])));
	const labelOf = (cohortId: string) => {
		const r = byCohort.get(cohortId);
		return r ? `${r.name} (${cohortText(r)})` : cohortId;
	};
	let flagged = $derived(
		new Set(v.assessment.findings.map((f) => `${f.cohortId}|${f.code}`).filter(Boolean))
	);

	let k = $derived(v.kpis);
	let burst = $derived(k.burst);
	let matchedShare = $derived(
		k.matched.kills ? (100 * k.matched.headshots) / k.matched.kills : null
	);
	let scoringFromDay = $derived(
		v.timeline.find((d) => d.day >= v.windows.scoring.from.slice(0, 10))?.day ?? ''
	);
	let pages = $derived(Math.max(1, Math.ceil(v.sessions.total / v.sessions.pageSize)));
	let burstExcluded = $derived(
		burst.excluded.ambiguousMatch + burst.excluded.clockNotAdvancing + burst.excluded.badClock
	);
	const PRESENCE_TONE = { online: 'ok', unknown: 'warn', offline: '' } as const;
	const COHORT: Record<IntelligenceView['settings']['cohort'], string> = {
		weapon: 'weapon',
		weapon_mode: 'weapon and mode',
		weapon_mode_map: 'weapon, mode and map'
	};
	const REASON = {
		catalog: 'not in the weapon catalog yet',
		class: 'class never scored',
		config: 'left out of the scored weapons'
	};
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div class="min-w-0">
		<a href={dossier} class="caps text-mist-400 hover:text-mist-100">← Dossier</a>
		<h2 class="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
			<span class="truncate">{v.name}</span>
			<span class="text-mist-400">· intelligence</span>
			{#if v.presence.state === 'online'}
				<Badge tone="ok">online · {v.presence.serverName}</Badge>
			{:else if v.presence.state === 'unknown'}
				<span
					title="The poller has not looked at {v.presence.serverName} since {fmtTime(
						v.presence.lastSeen
					)}"><Badge tone={PRESENCE_TONE.unknown}>status unknown</Badge></span
				>
			{/if}
		</h2>
		<div class="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-mist-400">
			<span class="font-mono">{v.steamId}</span>
			<span>
				· {#if v.presence.state === 'offline'}{v.presence.lastSeen
						? `last observed ${fmtAgo(v.presence.lastSeen)}`
						: 'never observed on these servers'}{:else}last observed {fmtAgo(v.presence.lastSeen)} on
					{v.presence.serverName}{/if}
			</span>
			<span>· built {fmtTime(v.generatedAt)}</span>
		</div>
	</div>
</div>

<div class="callout">
	<b>Scope:</b>
	{v.scope.servers.map((s) => s.name).join(', ')}
	{#if v.scope.permitted.length > 1}
		<span class="ml-1 inline-flex flex-wrap gap-2">
			{#if !whole}<a href={href({ servers: null })} class="text-accent hover:underline"
					>all {v.scope.permitted.length} servers you can read</a
				>{/if}
			{#if !(scopeIds.length === 1 && scopeIds[0] === id)}<a
					href={href({ servers: [id] })}
					class="text-accent hover:underline">{data.server.name} only</a
				>{/if}
		</span>
	{/if}
	<span class="block text-[12.5px] text-mist-400">
		Scoring window: the last {v.windows.scoring.days} days. Other players: {fmtTime(
			v.windows.baseline.from
		).slice(0, 12)} to {fmtTime(v.windows.baseline.to)}, compared by {COHORT[v.settings.cohort]}.
		Settings: the built-in defaults, evaluated on demand in shadow mode (nothing is queued).
	</span>
</div>

{#if !v.scope.feedServers}
	<div class="callout border-l-warn">
		None of these servers has a kill feed, so there are no kills to compare. The history below still
		comes from the poller's sessions and the recorded matches.
	</div>
{/if}

<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
	<div
		class="panel py-4"
		title="Kill-feed kills (not suicides) on record on these servers, all time."
	>
		<div class="caps text-mist-400">Kills on record</div>
		<div class="mt-1 font-display text-2xl font-semibold tabular">{fmtNum(k.killsOnRecord)}</div>
		<div class="text-[12px] text-mist-600">
			{fmtNum(k.eligible.kills)} eligible, last {v.windows.scoring.days} d
		</div>
	</div>
	<div
		class="panel py-4"
		title="Headshot kills divided by eligible kills on the matched weapons, against the share other players would have with the same weapon mix. Not shooting accuracy."
	>
		<div class="caps text-mist-400">Headshot share</div>
		<div class="mt-1 font-display text-2xl font-semibold tabular">{pctText(matchedShare)}</div>
		<div class="text-[12px] text-mist-600">
			{#if k.matched.expectedPct !== null}vs {pctText(k.matched.expectedPct)} expected · {pctText(
					k.matched.coveragePct
				)} matched{:else}no matched cohort yet{/if}
		</div>
	</div>
	<div
		class="panel py-4"
		title="Headshots among kills at or beyond each weapon's long-range distance."
	>
		<div class="caps text-mist-400">Long-range headshots</div>
		<div class="mt-1 font-display text-2xl font-semibold tabular">
			{fmtNum(k.longRange.headshots)}
		</div>
		<div class="text-[12px] text-mist-600">of {fmtNum(k.longRange.kills)} long-range kills</div>
	</div>
	<div
		class="panel py-4"
		title="Most eligible kills inside any {burst.windowSeconds}-second window of the match clock, on validated clock segments only."
	>
		<div class="caps text-mist-400">Max in {burst.windowSeconds} s</div>
		<div class="mt-1 font-display text-2xl font-semibold tabular">
			{burst.display ? fmtNum(burst.display.kills) : '—'}
		</div>
		<div class="text-[12px] text-mist-600">
			{#if burst.display}{burst.display.distinctVictims} victim{burst.display.distinctVictims === 1
					? ''
					: 's'}{:else}no validated clock{/if}
		</div>
	</div>
	<div
		class="panel py-4"
		title="The game's scoreboard counters over recorded matches that ended on these servers."
	>
		<div class="caps text-mist-400">Recorded K/D</div>
		<!-- with no deaths the counts are spelled out, which needs the smaller size -->
		<div
			class="mt-1 font-display font-semibold tabular {k.recorded.deaths ? 'text-2xl' : 'text-lg'}"
		>
			{kdText(k.recorded.kills, k.recorded.deaths)}
		</div>
		<div class="text-[12px] text-mist-600">{fmtNum(k.recorded.matches)} recorded matches</div>
	</div>
	<div class="panel py-4" title="From joining to the poller's last look, summed over every stay.">
		<div class="caps text-mist-400">Observed</div>
		<div class="mt-1 font-display text-2xl font-semibold tabular">
			{k.sessions ? fmtMinutes(k.observedMinutes) : '—'}
		</div>
		<div class="text-[12px] text-mist-600">
			{fmtNum(k.sessions)} session{k.sessions === 1 ? '' : 's'}
		</div>
	</div>
	<div class="panel py-4">
		<div class="caps text-mist-400">First seen</div>
		<div class="mt-1 font-display text-lg font-semibold tabular">
			{k.firstSeen ? fmtTime(k.firstSeen).slice(0, 12) : '—'}
		</div>
	</div>
</div>

<div class="space-y-4">
	<ReviewPriority assessment={v.assessment} settings={v.settings} {labelOf} />

	<div class="panel">
		<span class="label-sm">Weapons against other players · last {v.windows.scoring.days} days</span>
		<p class="mb-3 text-[12.5px] text-mist-600">
			Headshot share is headshot kills divided by eligible kills, not shooting accuracy. Other
			players are everyone else with the same weapon and cohort on these servers over the baseline
			window, each counted once however many servers and days they played; this player's own kills
			are left out. A rule judges a row only once every check in its details is met.
		</p>
		<WeaponTable rows={v.weapons} {flagged} cohortLabel={cohortText} />
		{#if v.unscored.length}
			<span class="mt-4 field-label">Kills with weapons that are not scored</span>
			<div class="table-wrap">
				<table>
					<thead
						><tr
							><th>Weapon</th><th>Why</th><th class="num">Kills</th><th class="num">Headshots</th
							></tr
						></thead
					>
					<tbody>
						{#each v.unscored as u (u.weapon)}
							<tr>
								<td><span title={u.weapon || 'no cause'}>{u.name}</span></td>
								<td class="text-mist-400">{REASON[u.reason]}</td>
								<td class="num">{fmtNum(u.kills)}</td>
								<td class="num">{fmtNum(u.headshots)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
		<div class="panel">
			<span class="label-sm">Kills by day · receipt time</span>
			<KillTimeline days={v.timeline} scoringFrom={scoringFromDay} />
		</div>
		<div class="panel">
			<span class="label-sm">Distance · eligible kills, last {v.windows.scoring.days} days</span>
			<DistanceHistogram bins={v.distance.bins} unknown={v.distance.unknown} />
		</div>
	</div>

	<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
		<div class="panel">
			<span class="label-sm"
				>Who they kill · since {fmtTime(v.windows.baseline.from).slice(0, 12)}</span
			>
			<OpponentTable
				rows={v.opponents.victims}
				countLabel="Kills"
				hrefFor={(steamId) => `/server/${encodeURIComponent(id)}/players/${steamId}`}
			/>
		</div>
		<div class="panel">
			<span class="label-sm"
				>Who kills them · since {fmtTime(v.windows.baseline.from).slice(0, 12)}</span
			>
			<OpponentTable
				rows={v.opponents.killers}
				countLabel="Deaths"
				hrefFor={(steamId) => `/server/${encodeURIComponent(id)}/players/${steamId}`}
			/>
		</div>
	</div>

	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0!">Sessions</span>
			<span class="ml-auto text-[12px] text-mist-400"
				>page {v.sessions.page} of {pages} · {fmtNum(v.sessions.total)} in all</span
			>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Joined</th><th>Server</th><th>Name</th><th>Faction</th><th class="num">Observed</th
						><th class="num">K</th><th class="num">D</th><th>Maps played</th>
					</tr>
				</thead>
				<tbody>
					{#each v.sessions.rows as s (s.id)}
						<tr>
							<td class="whitespace-nowrap">{fmtTime(s.joinedAt)}</td>
							<td>{s.serverName}</td>
							<td>{s.name}</td>
							<td>{s.faction || '—'}</td>
							<td class="num"
								>{fmtMinutes(s.observedMinutes)}{#if !s.leftAt}<Badge tone="ok" class="ml-1"
										>open</Badge
									>{/if}</td
							>
							<td class="num">{s.kills}</td>
							<td class="num">{s.deaths}</td>
							<td class="text-mist-400"
								>{s.maps.length
									? s.maps.map((m) => mapLabel(data.catalog, m)).join(' → ')
									: '—'}</td
							>
						</tr>
					{:else}
						<tr
							><td colspan="8" class="py-6 text-center text-mist-600"
								>No sessions on these servers.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
		{#if pages > 1}
			<div class="mt-3 flex justify-end gap-2">
				{#if v.sessions.page > 1}<a
						class="btn btn-sm"
						href={href({ sessions: v.sessions.page - 1 })}>← Newer</a
					>{/if}
				{#if v.sessions.page < pages}<a
						class="btn btn-sm"
						href={href({ sessions: v.sessions.page + 1 })}>Older →</a
					>{/if}
			</div>
		{/if}
		<p class="note">
			A stay runs from joining to the poller's last look, so an outage never lengthens it. The maps
			are those of the recorded matches the stay overlapped; K and D are the scoreboard's counters
			over the stay.
		</p>
	</div>

	<div class="panel">
		<span class="label-sm">Coverage and limits</span>
		<div class="grid gap-x-8 text-[13px] md:grid-cols-2">
			<div class="kv">
				<span class="text-mist-400">Eligible kills, scoring window</span><span class="tabular"
					>{fmtNum(v.coverage.eligibleKills)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Matched to a comparable cohort</span><span class="tabular"
					>{fmtNum(v.coverage.matchedKills)} ({pctText(k.matched.coveragePct)}; rules need {v
						.settings.minComparableCoveragePct}%)</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Mode unknown (not compared)</span><span class="tabular"
					>{fmtNum(v.coverage.unknownModeKills)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">With a known distance</span><span class="tabular"
					>{fmtNum(v.coverage.knownDistanceKills)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Left out: weapon not scored</span><span class="tabular"
					>{fmtNum(v.coverage.excluded.unscored)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Left out: team kill</span><span class="tabular"
					>{fmtNum(v.coverage.excluded.teamKill)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Left out: victim not a known enemy</span><span class="tabular"
					>{fmtNum(v.coverage.excluded.enemyUnknown)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Burst: kills on a validated clock</span><span class="tabular"
					>{fmtNum(burst.used)} in {fmtNum(burst.segments)} segment{burst.segments === 1
						? ''
						: 's'}{#if burstExcluded}, {fmtNum(burstExcluded)} left out{/if}</span
				>
			</div>
		</div>
		{#if v.coverage.clipped}
			<p class="mt-2 text-[13px] text-warn">
				This player has more kills in the window than one read takes, so the comparisons are
				withheld rather than judged on a partial count.
			</p>
		{/if}
		<ul class="note list-disc space-y-1 pl-5">
			<li>
				Eligible kills use a scored weapon, are not suicides or deaths to the environment{v.settings
					.excludeTeamKills
					? ', are not team kills'
					: ''}{v.settings.requireKnownEnemy
					? ', and have a victim known to be on the other side'
					: ''}. Factions come from Warcon's sessions when the kill arrived, not from the game at
				the shot.
			</li>
			<li>
				A kill's mode comes from the recorded match it was attached to, only where that attachment
				is credible (same server, inside the match's time, same map); otherwise the kill is not
				compared.
			</li>
			<li>
				Bursts are counted on the match clock within one server boot and one recorded match, split
				wherever the clock and receipt time disagree. Kills without such a segment are left out, so
				a burst can be undercounted but not invented. The rule needs at least {v.settings.burst
					.minKills} kills against {v.settings.burst.minDistinctVictims} different victims.
			</li>
			<li>
				The recorded K/D is the game's scoreboard over recorded matches; the kill feed covers a
				different period, so the two are never mixed.
			</li>
			<li>
				Thresholds are the built-in defaults until owner settings arrive. Nothing here bans, kicks
				or changes the connect-risk score.
			</li>
		</ul>
	</div>
</div>

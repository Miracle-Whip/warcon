# Warcon player intelligence: implementation handoff

Prepared 26 September 2026 UTC; **revised the same day for merge safety and deployment fit — see section 0.** Original source baseline: Warcon commit [`0bc123cea2aee1e0b5e76c5c278badb2a03ce267`](https://github.com/warcon-app/warcon/tree/0bc123cea2aee1e0b5e76c5c278badb2a03ce267), committed 25 September at 22:31:41 UTC. The attached Shepherd screenshots are the visual feature reference. They are not evidence that its calculations are correct or that it has an additional WARDOGS API.

**Recommendation:** extend Warcon's existing player dossier with an organisation-scoped **Player intelligence** module, a staff review board, and an owner settings page. Keep collection in Warcon's existing ingestion/polling paths and run analysis in its existing worker. Store settings and review history in Postgres. No additional service, Redis, machine-learning model, or game modification is needed for the core dashboard.

This is an implementation specification with concrete foundation code, not a completed Warcon patch. The configuration and scoring modules below passed 19 focused tests and strict TypeScript checking. Both Svelte components compiled without warnings against the repository's Svelte version. Database/API integration, live Steam requests, worker integration, and the full dashboard have not been implemented or tested here. All proposed route names below are **new Warcon routes**, not newly discovered game endpoints.

## 0. Revision notes (26 September 2026, deployment review)

This plan was reviewed against Warcon `main` at migration `0034_json_webhooks` and against the actual deployment it will run on: a fork at `github.com/Miracle-Whip/warcon`, images published by the fork's `release.yml` to `ghcr.io/miracle-whip/warcon`, and a single `WARCON_ROLE=all` container on a 1 GB RAM / 8.7 GB disk VPS. Every helper the appendix code imports (`route`, `apiJson`, `ApiError`, `param`, `readJson`, `userAgent`, `requireOrgRole`, `accessibleServers`, `serverAccessFor`, `redact`, `auditLog`) exists with the expected names, and the proposed capability IDs match the repository's dotted format (`players.notes`, `bans.manage`). The technical analysis in sections 1, 2, 4, 5, 7, 8, 9 and 11 stands. The changes below are about sequencing, merge safety and fit to this deployment; where they conflict with later sections, these notes win.

| # | Change | Why |
|---|---|---|
| R1 | **Phases reordered to ship visible value first.** Phase 1 is a read-only dossier extension computed on demand from existing tables, using `DEFAULT_CONFIG` constants and touching no schema. Rollups, dirty-work queue, data epochs, snapshots, preview jobs, import/export and co-join analysis are deferred until a measured need (see revised section 3). | The whole database is ~155 MB. Subject queries hit the existing `kills_killer_idx (killer_steam_id, ts desc)`; fleet baselines are identical for every player and can be memoised in-process. The deferred machinery exists to make large-scale caching correct, and it is the part most likely to be built wrong by a first-time contributor. The plan's own item 15 says to choose limits from measurement. |
| R2 | **Separate migration track.** Intelligence migrations live in `drizzle/intel/` with their own `meta/_journal.json` and their own tracking table `drizzle.__intel_migrations`, run by a three-line hook in upstream's `runMigrations()` (`src/lib/server/db/index.ts`). Intelligence tables are defined outside `src/lib/server/db/schema.ts`. | Adding `0035_intel_*` to upstream's journal guarantees a conflict on `drizzle/meta/_journal.json`, and a duplicate `0035` index, the next time upstream ships a migration. Upstream shipped seven in one week. `drizzle/intel/` is inside the directory the Dockerfile already copies, so no Dockerfile edit is needed. |
| R3 | **Upstream-touch budget.** Only the files listed in revised section 10 may change; every touch is recorded in `docs/intelligence/UPSTREAM-TOUCHES.md`. | Each upstream file touched is a future merge conflict. The list makes conflicts predictable and reviewable. |
| R4 | **No built-in role migration for the MVP.** | Warcon's README states org owners and the site owner hold every capability. Owners can use the feature immediately; staff are granted `players.intelligence.read` / `.review` through the existing role editor. |
| R5 | **Weapon catalog replaces the placeholder allowlist.** `src/lib/intelligence/weapons.ts` (supplied separately) maps every tag seen in this deployment's feed to its in-game shop name and class, decides which classes are scored, and seeds `DEFAULT_CONFIG.filters.scoredWeaponTags` (`SCORED_WEAPON_TAGS`, 26 tags) and `weaponOverrides` (`DEFAULT_WEAPON_OVERRIDES`). The seeded config passes `IntelligenceConfigSchema`. Stored `kills.cause` values are never rewritten; the UI displays `weaponInfo(tag).name` with the raw tag available on hover. Tags not in the catalog fall back to upstream's `causeLabel()` and are shown but unscored. | The game sends internal tags (`Id.Item.WEPN_029`, `Id.Item.Vector`), not shop names (Galil, Super-45). Tags are the stable identifier and must stay the grouping key; names are presentation. Upstream's `src/lib/causes.ts` labels some tags with real-world names that differ from the shop (Glock 17 vs GGX 17, TAR-21 vs T-21) and lacks many; editing it in the fork would conflict whenever upstream adds a label, so the module keeps its own catalog. Upstream's `causeKind()` classifies grenades, AT mines, hammers and defibrillators as `weapon`, which is why scoring uses an explicit catalog. |
| R10 | **Long-range cutoff per weapon class.** Assault rifle and LMG 150 m, marksman 200 m, sniper 300 m; the rule is off for SMGs, pistols and shotguns. Implemented as `weaponOverrides` seeded from the catalog. | On this deployment's data the Mosin averages 166 m and the SV98 256 m per kill, so with one 150 m cutoff most sniper kills are already "long range" and the rule cannot separate a strong sniper from anyone else. SMGs (24-31 m) and pistols (5-20 m) essentially never reach 150 m, so the rule could only report "no evidence" for them. |
| R6 | **Development with a copy of production data must use a different `ENCRYPTION_KEY`.** | RCON passwords and webhook addresses are encrypted with that key. A dev instance holding the production key and production data will poll live game servers, enforce bans on sight and post to real webhooks. A fresh key makes those decrypts fail harmlessly. Never point a dev instance at the production database. |
| R7 | **Deployment rewritten for the actual pipeline** (revised section 10). Upstream syncs go through a pull request so CI runs *before* anything reaches `main`. | `release.yml` publishes on every push to `main` and does not wait for CI. GitHub's Sync fork button pushes straight to `main`, so a sync that breaks custom code would publish a broken `latest`. |
| R8 | **Resource ceiling.** 1 GB RAM, ~3 GB free disk, no local builds. Background work stays bounded and off by default; snapshot/rollup tables are the main new disk consumer when they arrive. | Upstream migration `0030` removed kill/sample retention, so disk growth is already permanent on this box. |
| R9 | **Expect "insufficient sample" for weeks.** | The kill feed on this deployment was enabled 24 September 2026. The default minimums (500 peer kills, 30 peer players per cohort) will not be met immediately. The UI must show the unmet requirement, not a finding. This is the correct initial state, not a bug. |

## 1. What to implement from the screenshots

| Screenshot feature | Current foundation | Recommended implementation |
|---|---|---|
| Name/SteamID search, avatar, aliases, first/last seen | Dossier and organisation player search; `players.ts`, `steam.ts` | Reuse them. Keep SteamID64 a string, never a JavaScript number. Add an Intelligence tab/link to the existing player page. |
| Online/offline and server | Observed player sessions and live state | Show last observation time. A stale or disconnected poller produces “status unknown”, not a reliable offline assertion. |
| Kills, deaths, K/D, playtime | `match_players`, `matches`, `player_sessions` | Keep recorded-match K/D consistent with careers/leaderboards. Label its observed server scope and dates; it is not the player's worldwide game career. With zero deaths, show “N kills / 0 deaths” rather than a misleading numerical K/D. |
| Headshot share, long-range headshots, weapon comparison | Individual `kills` rows already contain cause, headshot, distance, attacker and victim | Add weapon/cohort comparisons and explicit denominators. Headshot share means headshot kills divided by eligible kills; it is not shooting accuracy. |
| Highest kills in 60 seconds | Kill events have match-clock seconds; existing `kill-rate.ts` handles rolling counts | Build a true rolling-window calculation. Validate clock segments; batching, map changes and clock resets must not create fake bursts. |
| Kill timeline and distance histogram | Retained kill rows | Add bounded, cached aggregates with configurable bins and date ranges. Separate receipt-time charts from trustworthy event-time burst calculations. |
| Activity by hour | Sessions and observed times | Show presence and combat activity separately. Time zone is a display preference; unusual playing hours do not add suspicion points. |
| Session history with server/map/K/D | Sessions exist; matches and match-player stats exist | Paginate. A login session can span several maps: show the maps it overlapped, or nested match rows, rather than inventing one map for the entire visit. |
| “Who they kill” and “Who kills them” | `combatSummary()` already has victims and nemeses | Extend the staff view with headshot share, known-distance average and drill-through events. Keep these additions separate from the public career DTO. |
| Steam account age, visibility, bans, friend-ban counts | Already fetched and cached | Reuse the existing basic cache. Its friends data stores summary counts, not the friend-ID graph needed for friend links. |
| Steam level, badges/XP, games, playtime, achievements | Additional public Steam Web API methods | Add a separately cached enrichment service with per-field status and refresh controls. Private/unavailable means unknown, not zero. |
| Steam friends who have visited your servers | Need retained friend IDs plus existing local sessions | Add an optional friend-edge cache. Display only the intersection with players observed on the reader's permitted servers. |
| Repeated co-joins/shared playtime | Derivable from sessions | Add optional bounded overlap analysis. Overlapping sessions suggest shared presence; they do not prove a party, friendship, account ownership or coordinated cheating. |
| Suspect/review board, case status, copy case | New workflow | Build a review queue with assignment, notes, evidence links, dismissal/reopening and versioned snapshots. Call it Review board. |
| Reports and external case IDs | No report source demonstrated by these images or inspected modules | Implement staff-entered reports/evidence first. Add an authenticated importer only when there is a real source and documented payload. Notes, reports and independent reporters are different counts. |
| Active ban, reason, author, expiry, per-server enforcement | Existing organisation lists, list membership and list-sync state | Reuse the authoritative ban/list workflows. A current ban is context, not another statistical reason to declare the player a cheater. |
| “Chance legitimate: 1 in …” | Not supported by the available telemetry | Replace with review priority, observed rates, sample size, comparison population and data coverage. Do not label a hand-tuned score as a probability. |

The screenshots also show navigation labels such as Marshal and Battle Suite. Their behavior is not visible, so they are not separate defined features in this specification.

## 2. Existing code to reuse and the boundary to preserve

The inspected application uses Bun, SvelteKit/Svelte 5, Drizzle, Postgres and optional TimescaleDB. Zod is already a dependency.

| Existing path | Integration decision |
|---|---|
| `src/lib/server/feed.ts` | Preserve feed authentication and deduplication. It writes kills on the web process. Add durable dirty-work markers within the existing ingestion transaction after accepted rows are inserted. |
| `src/lib/server/feed-events.ts` | Continue existing SSE/live and trigger behavior. It can wake analysis, but must not be the sole durable work source: a lost notification must not lose analysis work. |
| `src/lib/server/players.ts` | Reuse dossier identity/history and visibility rules. Add a separate staff intelligence service rather than enlarging the public `combatSummary()` response with cases or scores. |
| `src/lib/server/leaderboards.ts`, `match-players.ts` | Use recorded match counters for career K/D; do not replace them with a partial kill feed. |
| `src/lib/server/steam.ts` | Keep basic profile/bans behavior stable. Add optional enrichment around it, with separately budgeted requests. |
| `src/lib/server/kill-rate.ts` | Reuse concepts and test cases for rolling windows. Do not assume receipt timestamps are event timestamps. |
| `src/lib/server/risk.ts`, `trigger-rules.ts` | **Do not route the new review score into `assessRisk()` or `risk_kick`.** Existing risk can cause kicks. The new score is for investigation and must have its own DTO and configuration. |
| `src/lib/server/poller.ts`, `leadership.ts` | Run bounded analysis work only under the current worker ownership lease; use `withOwnedTransaction()` for worker commits. |
| `src/lib/capabilities.ts`, `src/lib/server/access.ts` | Register and enforce the new permissions in both routes and UI. |
| `src/lib/server/stats.ts` | Purging server statistics must also invalidate/delete derived intelligence so deleted evidence cannot reappear from caches. |
| `src/lib/server/lists.ts`, `lists-sync.ts`, existing ban dialogs | Preserve the existing explicit ban action and its permission checks. The intelligence module does not become a second ban authority. |

Organise new code under `src/lib/intelligence/` for shared types/validation/pure scoring and `src/lib/server/intelligence/` for queries, settings, jobs, cache and cases. Add UI components under `src/lib/components/intelligence/`. This keeps changes to upstream files small and easier to merge when Warcon updates. The permitted upstream touches are enumerated in revised section 10 (R3).

## 3. Implement in this order (revised, see R1)

Each phase ends with a deploy to the VPS. Phase 1 deliberately changes no schema, so the first trip through branch → pull request → CI → GHCR → VPS cannot damage data.

**Phase 0 — Guard rails (no deploy).** Development environment per R6; baseline `bun test`, `bun run check`, `bun run lint` and `bun run build` passing on unmodified code; `docs/intelligence/plan.md` (this file) and `docs/intelligence/UPSTREAM-TOUCHES.md` committed; weapon tags inventoried per R5.

**Phase 1 — Read-only dossier extension, computed on demand.** Register `players.intelligence.read` and `players.intelligence.review` (upstream touch: `src/lib/capabilities.ts`). Add `GET /api/servers/:id/players/:steamId/intelligence` and a page at `/server/[id]/players/[steamId]/intelligence`, linked from the existing dossier only when the read capability is held (upstream touch: the dossier `+page.svelte`, one link). Contents: KPI strip (kills on record, headshot share vs matched fleet, long-range headshots, max kills in a validated 60 s window, recorded-match K/D, observed minutes, first seen), weapons-vs-fleet table with the section 5 definitions and sample-size gating, kill timeline, distance histogram, and the existing sessions and opponent data. Scoring via the appendix `score.ts` is displayed as review priority with every unmet requirement named. Thresholds come from `DEFAULT_CONFIG`; changing them needs a code change until phase 2. Fleet baselines are memoised in-process for ten minutes keyed by sorted server set, lookback and algorithm version; clear the memo on stats purge. No new tables, no worker changes.

**Phase 2 — Persisted settings.** Add the intelligence migration track (R2, appendix), `intelligence_settings` and `intelligence_settings_revisions`, the appendix settings route and generic editor at `/orgs/[id]/intelligence`. The dossier reads the saved config, falling back to defaults. Save, reload, load defaults and revision history; preview/import/export stay deferred.

**Phase 3 — Review board, manual first.** `intelligence_cases`, `intelligence_case_events`, `intelligence_reports`; board at `/intelligence/[orgId]`; staff create cases from a dossier, assign, note, clear or escalate; copy-case text with the as-of warning. The board lists open cases, not a background scan of every player.

**Phase 4 — Background evaluation, only if phase 3 shows the need.** A bounded worker job under the existing lease (`poller.ts`, `withOwnedTransaction()`) evaluates recently active players and upserts automatic cases in review mode. This is where `intelligence_dirty`, `intelligence_data_epochs` and `intelligence_snapshots` become necessary, with the purge fencing from section 6. Measure memory and query time on the VPS before enabling.

**Phase 5 — Steam enrichment and relationships.** Section 8 enrichment, then friend edges, then co-join analysis. Each fails independently of the combat dossier.

**Deferred until measured need:** `intelligence_rollups`, preview jobs, JSON import/export. Revisit rollups only if dossier queries on the VPS exceed roughly 500 ms at realistic data volume.

The boundaries and tests from the original plan still apply to whatever phase introduces them. This work does not supply missing chat, shot trajectories, mouse input, aim angles or line-of-sight telemetry.

## 4. Configuration must be a saved product feature

The owner-facing page should be **Organisation → Player intelligence settings**. Sections: Collection and comparisons; Review rules; Weapon overrides; Display; Steam; Relationships; Review board; Processing. Numeric controls show units and allowed ranges; rules have enable switches; saving shows the persisted revision.

Use one shared Zod schema for browser validation, API validation, worker reads, imports and previews. Defaults only initialise an organisation that has no settings. Updating the application must not overwrite existing values. New schema versions need explicit migrations; rejecting an unknown future schema is safer than silently resetting settings.

| Editable controls | Why they belong in the interface |
|---|---|
| Enabled and shadow/review mode | Stop the module or evaluate without creating review work. |
| Player/baseline lookback, minimum peer players/kills, comparable coverage | Adapt to population and retained evidence. |
| Weapon/mode/map cohort, baseline start time and label | Avoid mixing different play contexts or weapon balance eras. The current kill schema has no dependable game-build field; allow an owner to start a new baseline after a patch. |
| Per-rule samples, ratios, percentage-point gaps and weights | Tune behavior without recompiling. |
| Per-weapon overrides and scored weapon tags | Sniper rifles, shotguns, pistols and new game weapons need different treatment. Unknown tags remain visible but unscored until classified. |
| Long-range distance and burst window/count/distinct victims | Make the actual definition editable, with the definition shown beside the result. |
| Watch/review/priority boundaries | Control queue priority; the labels do not authorize punishment. |
| Panels, time zone, distance bins and pagination | Configure the dashboard presentation. |
| Steam fields/refresh intervals/friend limits | Control external requests and optional context. |
| Co-join window, overlap count, shared minutes and lookback | Tune relationship summaries while leaving them non-scoring. |
| Queue threshold, cooldown, snapshot retention and refresh cadence | Limit repetitive review work and storage. Snapshot retention is separate from the existing raw kill history. |

Include **Save**, **Reload saved**, **Load defaults into draft**, **Preview on recorded data**, **Export JSON**, **Import JSON**, and **Revision history / restore as a new revision**. Preview must accept an unsaved draft, return a job ID, and report affected players and changed levels. It must never write cases or execute RCON. A restore is a new revision, not a rewrite of the audit history.

The appendix provides a functional generic settings editor covering all fields, with JSON text areas for tag lists and weapon overrides. For the polished interface, replace the tag JSON area with a searchable multi-select and the override JSON area with a weapon table: Add override, Use organisation default, Enabled, Minimum sample, Ratio, Gap, Weight and Distance. These are alternate editors for the same validated data; no additional configuration source is needed. The generic editor does not yet implement preview/import/export/history buttons; their route contracts are specified below.

Save settings to Postgres, not to the container filesystem or compiled constants. Keep `STEAM_API_KEY` server-side using Warcon's existing secret configuration; the browser sees only whether Steam is configured. Site-wide request-budget and concurrency ceilings should extend the existing Admin settings mechanism in `server/settings.ts`. An organisation may lower its workload but cannot exceed those ceilings.

## 5. Define the statistics before drawing them

**Scope:** every aggregate starts with server IDs that the current reader may access with the new intelligence-read capability. Intersect an optional requested server filter with that set; reject forbidden explicit IDs. The worker can prepare per-server aggregates, but never hand a reader a cached whole-organisation score and merely hide its server labels.

**Eligible events:** start with the explicit scored weapon allowlist. Always exclude environment deaths and suicides from offensive comparisons; apply the configured team-kill and known-enemy filters identically to player and peers. Factions in current kill rows were joined from observation at receipt, not supplied as authoritative faction-at-shot telemetry. Mark that limitation. Null distance is unknown, not zero metres. Keep raw tags and show unmapped weapon counts.

**Peer cohorts:** group by raw weapon tag plus configured mode/map context. Join the recorded match only where its association is credible; unknown mode is its own unavailable comparison, not silently the default mode. Exclude the subject player's own kills from the peer numerator, denominator and unique-player count. Deduplicate peer SteamIDs across servers/days. Show the number of other players and kills used. No automatic fallback from a sparse mode/map cohort to a broader cohort without a separate labelled option.

**Weapon-mix expected headshots:** for each eligible subject weapon/cohort cell, multiply that cell's subject kills by the peer headshot share, sum, and divide by the subject's kills in matched cells. Show which proportion of subject kills had an eligible comparison. Compute the displayed observed comparison on those same matched cells. A headline overall headshot share across all kills can be shown separately. Never compare a sniper-heavy player's rate directly with an unrelated pooled weapon mix.

**Long range:** the supplied rule uses headshot kills at or beyond that weapon's configured distance divided by eligible kills with known distance at or beyond it. The screen must say “headshots among long-range kills”. Also show the raw long-range headshot count. If you add “long-range headshots / all weapon kills” as another column, give it that separate label and denominator. Do not quietly substitute it into this rule.

**Burst:** the feed's `ts` is receipt time, `eventTime` is seconds on the match clock, and raw `matchId` has been observed to persist for a server boot. `matchRow` is attached from the open match at receipt and can be ambiguous around transitions. Establish a validated clock segment using server, instance, recorded match and clock continuity; split at resets and exclude ambiguous transitions from burst scoring. Keep no-clock/estimated-clock states. Reuse `killTimes()` only where its assumptions hold; it is not a guarantee that arbitrary historical batches have exact timestamps. The appendix uses a half-open rolling interval `(latest - window, latest]`. For display calculate the overall maximum; for the burst rule calculate the maximum among windows that meet the distinct-victim floor. Do not let a larger farmed-one-victim window hide a different qualifying window.

**Score:** use `max(eligible headshot/long-range findings) + burst weight`, capped at 100. The aim-related findings are correlated and contribute once, even across several weapons. They are heuristic review signals, not independent probabilities. Existing bans, report counts, private profiles, names, friends and playing hours are displayed context and do not enter this new score. A report can create a manual review case without pretending to raise statistical confidence. If no rule has usable evidence, return `score: null`, not “low risk”. Show which rules were unavailable even when another rule produced a score.

**History:** match-player K/D and feed combat counts have different coverage. Display both honestly and never combine headshots from a partial feed with a scoreboard denominator to call it the feed's headshot rate. Session durations should stop at last trustworthy observation during poller outages. Time zone changes do not change stored timestamps or scores.

## 6. Data model and background work

Use ordinary Postgres tables for module state. Preserve the existing kills table and its Timescale behavior.

**Revised phasing of these tables (R1, R2).** Phase 1 creates none of them. Phase 2 adds the two settings tables; phase 3 the case, event and report tables; phase 4 the dirty, epoch and snapshot tables; phase 5 the Steam tables. `intelligence_rollups` is deferred. Every table is created through the separate `drizzle/intel/` migration track, defined outside upstream's `schema.ts`, and additive only: an unmodified upstream image must still boot against a database that contains them.

The following are implementation contracts, not already-existing tables:

| New table | Key / data / lifecycle |
|---|---|
| `intelligence_settings` | Organisation primary key; validated JSON, revision, author, timestamp. Reference DDL and route code below. |
| `intelligence_settings_revisions` | Organisation + revision; immutable configuration history. |
| `intelligence_dirty` | Server primary key; monotonically increasing generation, processed generation, requested time. Mark in the kill transaction and when recorded match/session data changes. |
| `intelligence_data_epochs` | Server primary key + epoch. Increment on stats purge/reset; reject stale worker results against the epoch. |
| `intelligence_rollups` | Organisation, server, UTC day, player, weapon, mode, map, configuration revision, algorithm version and data epoch. Counts for kills/headshots, known-distance sum/count, long-range kills/headshots, configured histogram bins. Keep source population dimensions so scoped comparisons are reconstructible. |
| `intelligence_snapshots` | Organisation, scope hash, player, config revision, algorithm version, as-of time and data epoch set; score, findings, coverage and summary JSON. Store contributing server IDs. Index board/filter fields. |
| `intelligence_cases` | Text UUID, organisation, player, scope/server set, status, assigned user, revision, timestamps. Partial unique index for one active automatic case per organisation/player/scope. |
| `intelligence_case_events` | Case ID, event ID, author, timestamp, event type, structured content. Append-only assignment/status/note/evidence history. Snapshot links preserve what was shown when reviewed. |
| `intelligence_reports` | Case/player, organisation, server scope, reporter identity when known, source, external source ID, body, evidence URL, submitted time. Unique `(org, source, external_id)` where external ID is non-null. |
| `steam_enrichment` / `steam_friend_edges` | Cached enrichment with field statuses/freshness; friend source/target IDs and cache generation. Store only when enabled; mark partial lists and expire according to the configured policy. |

A generation must be captured when a worker claims dirty work. Acknowledge only that generation after a successful commit; if another kill arrives meanwhile, the later generation remains pending. Errors leave work retryable with bounded backoff. Startup scans dirty generations and changed configuration revisions, so correctness does not depend on an in-memory notification surviving a restart.

Recompute bounded changed day buckets and replace their results transactionally; do not blindly increment counters on replay. Skip/flag suspicious legacy duplicate events, using `(server_id, instance_id, event_id)` as the analysis identity. The current ingest code already serializes server writes and deduplicates recent retries, so preserve it.

Use rollups for complete UTC days and raw, bounded queries for partial boundary days and burst details. For peer populations, first merge the selected rollups per distinct player/cohort, then exclude the subject and count peers; summing daily “distinct player” counts is wrong. A configuration change that affects filters, distance cutoffs or bins must rebuild affected aggregates under the new revision before publishing a matching snapshot. GC superseded rollups after the replacement succeeds; do not retain every revision's duplicate rollups for the full case-retention window.

Cache identity must include organisation, the requested player, sorted permitted server set, effective filters/time range, configuration revision, algorithm version and data epochs. A new configuration can show “recalculating” with the previous snapshot explicitly labelled; it must not relabel an old result as new. A preview also includes a hash of its unsaved draft. Permission checks happen before every cache read/export/SSE subscription and again at mutation time. The appendix includes a scoped player-cache helper; board queries assemble authorised player snapshots and are separately paginated.

On a small VPS, start with one intelligence job at a time, a two-minute refresh, bounded pages/batches and on-demand Steam enrichment. Avoid analysing all players synchronously when someone opens the Players page. Use query plans and measured load to decide on extra compound indexes, starting with `(server_id, killer_steam_id, ts)` and `(server_id, victim_steam_id, ts)` only if the existing indexes are insufficient. Do not run two wide raw-table scans per player on every web refresh.

Purging server stats must remove its rollups, mark/delete affected snapshots and redact/remove copied combat evidence in cases according to the purge operation's documented scope. Increment its data epoch in the purge transaction and fence the worker commit against it, so a job that started before the purge cannot resurrect deleted data. Keep the administrative audit that a purge occurred. Deleting/moving a server and deleting an organisation need equivalent cache/scope cleanup.

## 7. Routes and permissions

Register `players.intelligence.read` and `players.intelligence.review` in `CAPABILITIES`, `CAPABILITY_INFO`, role-editor tests and permission suites. Read opens intelligence; review permits cases/reports. Require read in addition to review. Organisation settings remain owner-only. Do not assume changing built-in defaults upgrades saved roles: provide a deliberate migration for untouched built-in admin roles, preserve customised roles, and explain any newly available permission in the owner interface. API keys need explicit new grants.

The existing `/orgs/[id]` layout admits list managers/owners via `requireListsRole()`. Do not accidentally require ban-list authority just to review intelligence. Put the board at `/intelligence/[orgId]` with its own layout/access checks; keep owner settings at `/orgs/[id]/intelligence`. Embed the player card in the existing dossier only when the read capability is held. Public career pages receive none of this staff data.

| Proposed route | Contract |
|---|---|
| `GET/PATCH /api/orgs/:id/intelligence/settings` | Owner; `{revision, config}`. Full validated replacement with compare-and-swap; stale revision → 409. Code below. |
| `GET /api/orgs/:id/intelligence/settings/history` | Owner; bounded revision history. Restore by posting the chosen configuration through PATCH with the current revision. |
| `POST /api/orgs/:id/intelligence/preview` | Owner; `{config, from, to, serverIds}`. Validate and limit range/players; queue read-only analysis; return 202 + job ID. |
| `GET /api/orgs/:id/intelligence/preview/:jobId` | Owner of the same organisation; pending/result with applied scope, limits, before/after levels and excluded-data counts. Expire jobs. |
| `GET /api/servers/:id/players/:steamId/intelligence` | Intelligence read on anchor server; only intelligence-readable requested servers in the same organisation. Return snapshot revision/freshness, coverage, graphs, findings and pagination links. 202 can signal first build. |
| `GET /api/orgs/:id/intelligence/board` | Intelligence read; scoped, paginated filters by priority, case state, server, active/last seen, assigned reviewer. An empty permitted scope returns no data. |
| `POST /api/orgs/:id/intelligence/cases` | Read + review on every server included in the case; create manual case or attach an eligible snapshot. |
| `PATCH /api/orgs/:id/intelligence/cases/:caseId` | Same scope checks and case revision; assignment/status change, required reason when dismissing or escalating. |
| `POST /api/orgs/:id/intelligence/cases/:caseId/events` | Same scope checks; notes/evidence; request idempotency key. Enforce lengths and allowed URL schemes. |
| `GET /api/orgs/:id/intelligence/cases/:caseId/export` | Same scope checks; plain text/JSON with evidence time, scope, versions and limitations. |
| `POST /api/servers/:id/players/:steamId/intelligence/steam-refresh` | Intelligence read + request throttle; enqueue allowed enrichment, return 202 and cached status. |

Cases/snapshots with contributing hidden servers cannot be shown to a narrower reader merely by removing server names. Either the entire case scope is authorised or provide a separately recomputed scoped dossier; do not expose the broader score, peer counts, reports, assignments or export. Recheck access after a role/grant changes. Use Warcon's `api()` browser helper, which carries its CSRF header, rather than a bare fetch mutation.

No new request in this table contacts game RCON. It reads/writes Warcon's database or queues Steam reads. If a reviewer clicks the existing Ban button, the existing list/dispatcher flow modifies the selected server or organisation list and synchronizes enforcement as it does today.

## 8. Steam enrichment: exact sources and limits

Use the existing server-side key and public host `https://api.steampowered.com/`. Default WARDOGS AppID is **1867240**, verified from its [Steam store page](https://store.steampowered.com/app/1867240/WARDOGS/); keep it editable for a separate playtest app and allow null to disable game-specific enrichment.

| Information | Read method | Handling |
|---|---|---|
| Profile/avatar/creation/visibility | `ISteamUser/GetPlayerSummaries/v2/` | Already in Warcon. Profile creation can be unavailable. |
| VAC/game/community ban summary | `ISteamUser/GetPlayerBans/v1/` | Already in Warcon. A game-ban count does not identify the game or prove a WARDOGS ban. |
| Friend IDs | `ISteamUser/GetFriendList/v1/` | Existing code uses it to count friend bans; add optional retained IDs for local matching. Mark list truncation. |
| Steam level | `IPlayerService/GetSteamLevel/v1/` | Optional cached field. |
| Badges/XP | `IPlayerService/GetBadges/v1/` | Store only summary fields the card needs. |
| Owned games / available playtime | `IPlayerService/GetOwnedGames/v1/` | Visibility-dependent. A filtered WARDOGS request cannot also supply an accurate total games-owned count; request an unfiltered visible list if that card is enabled. |
| Recent games / recent playtime | `IPlayerService/GetRecentlyPlayedGames/v1/` | An app missing from recent results is not proof the player never played it. |
| Achievements | `ISteamUserStats/GetPlayerAchievements/v1/`; `GetSchemaForGame/v2/` | Optional; cache app schema separately; do not assume every achievement is visible for every user. |

Use `input_json` for the IPlayerService request parameters as documented. Avoid `GetSingleGamePlaytime` for ordinary public-key enrichment: Valve documents an app-associated-key restriction on that method. Methods existing in documentation do not guarantee a successful answer for a particular private profile.

Return `{state: 'available'|'private'|'unavailable'|'error'|'partial', value, fetchedAt, stale}` per field group. Unknown errors retain last successful data with a stale/error indicator. Refresh buttons enqueue deduplicated jobs; they do not bypass caching, backoff or the global budget. Keep one shared budget across workers/web processes so extra panel replicas do not multiply requests. Optional Steam work must not consume capacity reserved for existing connect-risk lookups.

The two official references used for these method choices are [IPlayerService](https://partner.steamgames.com/doc/webapi/IPlayerService) and [ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats).

For co-joins, match sessions on the same server whose joins are within the configurable window and whose presence intervals overlap. Compute intersections with `max(join times)` and `min(end times)`; merge overlaps before summing to prevent double-counting reconnects or overlapping observations. Use last trustworthy observation for stale open sessions. Exclude reconnects around server/poller restarts from co-join counts; bulk joins after a restart are not strong relationship evidence. Query only the subject's bounded recent sessions against indexed nearby sessions, never every player pair in the organisation.

## 9. Dashboard and case behavior

Desktop: player header and search; KPI strip; wide combat/history column; narrow Steam/context column. Mobile: stack cards. Use Warcon's own components/style and accessible HTML tables. Charts must have text summaries, keyboard-accessible filters and empty/error states; adopt an existing chart library only if one is already present or the added dependency is justified.

The header shows score/priority, case status, last built time, selected scope and sample coverage separately. Do not combine them into “confidence high”. A finding expands to its numerator/denominator, peer cohort, threshold, config revision and event drill-through. Unknown/private data uses a dash plus an explanation.

The review board supports open → reviewing → cleared/escalated, with reopening as an explicit event. Escalated means staff attention, not banned. Add evidence links and a reason before an explicit existing ban action; preserve case provenance. Copy case includes an as-of snapshot and a warning that statistics are review signals. Escape player names and report text; do not render arbitrary HTML or fetch pasted evidence URLs server-side.

Automatic threshold crossings upsert one open case for the same player/scope and attach updated findings only after the configured cooldown or a meaningful escalation. Rebuilding after a config change should produce a labelled rescore, not hundreds of pretend new incidents. Staff-entered reports are deduplicated by real report identity; repeated messages from one source do not become several independent witnesses. Leave external notifications off initially; if later enabled, use the existing authorised outbox/webhook system with a new explicitly registered event and no game-action mapping.

## 10. Deployment and keeping upstream updates (revised, see R2, R3, R7)

**Branches.** `upstream/main` is `warcon-app/warcon` and is never written to. The fork's `main` is what deploys: upstream plus the intelligence module. Work happens on short-lived branches (`intel/phase-1`, `sync/2026-10-02`) that reach `main` only through a pull request whose base is **`Miracle-Whip/warcon` `main`** — GitHub defaults a fork's pull requests to the upstream repository, and that default must be changed every time.

**Pipeline.** `ci.yml` runs lint, check, tests, build and smoke on every pull request. Merging into `main` triggers `release.yml`, which publishes `ghcr.io/miracle-whip/warcon:latest` and an immutable `sha-<commit>` tag. On the VPS, `/opt/warcon/update.sh` backs up the database, pulls `latest`, restarts the single `WARCON_ROLE=all` container (which applies upstream migrations and then the intelligence track), waits for health and reports migration levels. Rollback is pinning the previous `sha-` tag plus the script's pre-update dump. `release.yml` does not wait for CI, so a green pull request is the gate; nothing reaches `main` without one.

**Upstream syncs.** Stop using the Sync fork button once custom code exists: it pushes straight to `main`, publishes without tests, and its "Discard commits" option would delete the entire module. Instead, merge `upstream/main` into a `sync/<date>` branch locally, resolve conflicts, run the checks, and open a pull request. Conflicts should be confined to the upstream-touch list below; a conflict anywhere else means the module has leaked into upstream code.

**Upstream-touch budget.** Only these upstream files may change, each with the smallest possible edit, each recorded in `docs/intelligence/UPSTREAM-TOUCHES.md` with the reason:

| Upstream file | Change | Phase |
|---|---|---|
| `.github/workflows/release.yml` | Trigger on push to `main`; `type=sha` tag. Already done. | — |
| `src/lib/capabilities.ts` | Two capability IDs and their `CAPABILITY_INFO` entries | 1 |
| `src/routes/(app)/server/[id]/players/[steamId]/+page.svelte` | One capability-gated link to the intelligence page | 1 |
| `src/lib/server/db/index.ts` | Intelligence migration hook in `runMigrations()` (appendix) | 2 |
| `src/lib/server/stats.ts` | Purge invalidates intelligence caches and derived tables | 1 (memo), 4 (tables) |
| `src/lib/server/poller.ts` | Register the bounded evaluation job | 4 |

**Rules carried over.** Never edit code inside a running container. Settings, revisions and cases live in the backed-up database. Back up before every update; `update.sh` does this and aborts if the dump fails. Intelligence migrations are additive so a rollback image tolerates them; never delete database volumes to roll back code. The module analyses already-ingested events and must not increase game-server polling.

## 11. Acceptance tests and definition of done

The 19 appendix tests cover the pure configuration/scoring foundation. These integration tests remain mandatory for the actual implementation:

1. No feed, private Steam, missing distance, unknown factions, unmapped weapons, missing mode and partial collection all produce accurate unavailable/coverage states.
2. Two concurrent copies of a feed event do not double any aggregate, even across process restart. Rebuilding a day produces the same counts as a clean single pass.
3. Self-exclusion removes the subject from peer kills, headshots and distinct player totals. A player seen on several servers/days counts once in a cohort.
4. Filters, per-weapon distance changes, lookback, epoch reset and display bins invalidate the right results. Older snapshots remain labelled with their original configuration.
5. Mixed weapons and modes do not distort the weapon-mix expected rate. Minimum matched coverage and per-cell samples are enforced, not just displayed.
6. Map reset, same-map restart, delayed batches, out-of-order delivery, identical receipt timestamps and raw per-boot match IDs do not create fake burst findings. Ambiguous data is suppressed.
7. Partial-role members and API keys cannot read other servers through player summaries, cohort baselines, relationship lists, cases, exports, preview jobs or SSE. Revoked grants stop cached reads. Public careers remain clean.
8. Non-owners cannot change settings. Two owners saving revision N yield one success and one 409. The losing draft remains visible. Invalid JSON/enums/NaN/ranges never enter the database.
9. Save a rule weight through the UI; restart web and worker; confirm the saved value is still effective. Test defaults, import, preview, history restore and an upgrade that adds one schema field without resetting custom values.
10. Changing these review thresholds never changes `risk_kick` outcomes. Shadow mode never creates review cases or game actions. Existing manual bans/list synchronization continue to pass their tests.
11. Queued work survives lost notifications/restarts. A worker that loses its lease or whose data epoch changed cannot publish stale results. Purge does not resurrect case evidence.
12. Steam 401/privacy, 429, timeouts, unavailable achievements and partial friends lists do not block dossier loading, leak the key or exhaust reserved connect-risk capacity.
13. Co-join overlaps are merged correctly; reconnects and mass joins during restarts do not inflate counts. Time-zone changes affect labels only.
14. Case creation, reports and retries are idempotent; assignment/status history is attributable; clipped/page-limited results disclose their limit. CSV exports, if added, escape spreadsheet formulas.
15. Run `bun run check`, relevant Bun unit/integration suites, the full existing permission/risk/list regression suites, `bun run build`, and Docker migration/role smoke checks. Test fresh install and upgrade of a populated database. On the intended VPS, measure ingestion/polling latency, memory and query plans while rebuilding; choose limits from results instead of claiming a capacity estimate as fact.

16. **Merge isolation (R2, R3).** Upstream's `drizzle/meta/_journal.json` and `src/lib/server/db/schema.ts` are byte-identical to `upstream/main`. A fresh install applies upstream migrations then the intelligence track. An upgrade of a populated database does the same. The unmodified upstream image boots against a database that contains the intelligence tables. `git diff upstream/main --stat` with the module's folders excluded (use `:(exclude,literal)` pathspecs so SvelteKit's `[id]` folders are not read as glob patterns; the guide has the exact command) lists only the upstream-touch budget.

The feature is done when a staff member can find a player, inspect a correctly scoped dossier, understand each finding, change thresholds through the owner UI, preview and save them, see revised results without a code rebuild, manage a case, and continue updating the container without losing configuration. Every screenshot feature above must be either implemented with its stated data source or shown as explicitly unavailable; do not fill gaps with fabricated endpoints or statistics.

## Appendix: code foundation

The following files are new code for this plan. Copy them to the specified target paths during implementation. The weapon catalog `src/lib/intelligence/weapons.ts` (R5, R10) is supplied as a separate file alongside this plan rather than inlined here; copy it to that path unchanged. They establish the configuration/scoring/save/edit mechanism; implement the remaining services, routes and dashboard described above around them. In the pure files, `./config.ts` imports work in Bun; adapt extension style to the repository's lint convention if required.

The example settings route writes an atomic local audit row and configuration revision. It does not send notifications. During integration, the worker must poll revisions and enqueue missing builds as specified; adding only this route will persist settings but will not run any analysis. Do not claim live configuration is finished until that worker path is wired.

### src/lib/intelligence/config.ts

```typescript
import { z } from 'zod';

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const rule = z.object({
  enabled: z.boolean(),
  weight: integer(0, 100),
  minKills: integer(1, 100000),
  ratio: z.number().min(1).max(20),
  gapPoints: z.number().min(0).max(100)
}).strict();
const longRule = rule.extend({
  distanceM: integer(1, 5000),
  minPeerKills: integer(10, 1000000),
  minPeerPlayers: integer(2, 10000)
});
const overrides = z.object({
  headshots: rule.partial().optional(),
  longRange: longRule.partial().optional()
}).strict();

export const IntelligenceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(['shadow', 'review']),
  lookbackDays: integer(1, 90),
  baseline: z.object({
    lookbackDays: integer(1, 90),
    cohort: z.enum(['weapon', 'weapon_mode', 'weapon_mode_map']),
    minPeerKills: integer(10, 1000000),
    minPeerPlayers: integer(2, 10000),
    minComparableCoveragePct: integer(0, 100),
    sinceUtc: z.iso.datetime().nullable(),
    label: z.string().max(100)
  }).strict(),
  filters: z.object({
    requireKnownEnemy: z.boolean(),
    excludeTeamKills: z.boolean(),
    // Explicit allowlist: causeKind('weapon') also includes explosives and tools.
    scoredWeaponTags: z.array(z.string().min(1).max(160)).min(1).max(200)
  }).strict(),
  rules: z.object({
    headshots: rule,
    longRange: longRule,
    burst: z.object({
      enabled: z.boolean(), weight: integer(0, 100),
      windowSeconds: integer(10, 300), minKills: integer(2, 1000),
      minDistinctVictims: integer(2, 1000)
    }).strict()
  }).strict(),
  weaponOverrides: z.record(z.string().min(1).max(160), overrides),
  thresholds: z.object({
    watch: integer(1, 98), review: integer(2, 99), priority: integer(3, 100)
  }).strict(),
  display: z.object({
    timezone: z.string().max(100).refine((v) => {
      try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; }
      catch { return false; }
    }, 'Use an IANA time zone, such as UTC or America/New_York'),
    distanceEdgesM: z.array(integer(1, 5000)).min(2).max(20),
    sessionPageSize: integer(10, 100),
    panels: z.object({
      timeline: z.boolean(), distance: z.boolean(), activity: z.boolean(),
      weapons: z.boolean(), sessions: z.boolean(), opponents: z.boolean(),
      steam: z.boolean(), network: z.boolean()
    }).strict()
  }).strict(),
  steam: z.object({
    enabled: z.boolean(), appId: integer(1, 2147483647).nullable(),
    refreshHours: integer(1, 168), friendsRefreshDays: integer(1, 30),
    maxFriends: integer(0, 500),
    fields: z.object({
      level: z.boolean(), badges: z.boolean(), ownedGames: z.boolean(),
      recentGames: z.boolean(), achievements: z.boolean(), friendLinks: z.boolean()
    }).strict()
  }).strict(),
  network: z.object({
    enabled: z.boolean(), lookbackDays: integer(1, 30),
    coJoinSeconds: integer(10, 600), minOverlaps: integer(2, 100),
    minSharedMinutes: integer(1, 1440), maxPeers: integer(5, 100)
  }).strict(),
  board: z.object({
    minLevel: z.enum(['watch', 'review', 'priority']),
    cooldownMinutes: integer(1, 1440), snapshotRetentionDays: integer(7, 365)
  }).strict(),
  worker: z.object({
    refreshSeconds: integer(30, 3600), maxPlayersPerJob: integer(1, 100)
  }).strict()
}).strict().superRefine((c, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  if (!(c.thresholds.watch < c.thresholds.review && c.thresholds.review < c.thresholds.priority))
    issue(['thresholds'], 'Require watch < review < priority');
  if (c.rules.burst.minDistinctVictims > c.rules.burst.minKills)
    issue(['rules', 'burst'], 'Distinct-victim minimum cannot exceed kill minimum');
  if (c.display.distanceEdgesM.some((v, i, a) => i > 0 && v <= a[i - 1]))
    issue(['display', 'distanceEdgesM'], 'Distance edges must increase strictly');
  if (Object.keys(c.weaponOverrides).length > 200)
    issue(['weaponOverrides'], 'At most 200 weapon overrides');
  for (const tag of Object.keys(c.weaponOverrides))
    if (!c.filters.scoredWeaponTags.includes(tag))
      issue(['weaponOverrides', tag], 'Add this tag to scoredWeaponTags first');
  if (new Set(c.filters.scoredWeaponTags).size !== c.filters.scoredWeaponTags.length)
    issue(['filters', 'scoredWeaponTags'], 'Remove duplicate tags');
});

export type IntelligenceConfig = z.infer<typeof IntelligenceConfigSchema>;
export const DEFAULT_CONFIG: IntelligenceConfig = IntelligenceConfigSchema.parse({
  schemaVersion: 1, enabled: false, mode: 'shadow', lookbackDays: 7,
  baseline: { lookbackDays: 30, cohort: 'weapon_mode', minPeerKills: 500,
    minPeerPlayers: 30, minComparableCoveragePct: 80, sinceUtc: null, label: '' },
  filters: { requireKnownEnemy: true, excludeTeamKills: true,
    // REVISED (R5): placeholder. At implementation, set scoredWeaponTags to
    // SCORED_WEAPON_TAGS and weaponOverrides to DEFAULT_WEAPON_OVERRIDES from
    // src/lib/intelligence/weapons.ts.
    scoredWeaponTags: ['Id.Item.AK74M', 'Id.Item.M4', 'Id.Item.M500',
      'Id.Item.MP43', 'Id.Item.SKS', 'Id.Item.SVDM', 'Id.Item.KH2002',
      'Id.Item.TAR21', 'Id.Item.A91', 'Id.Item.SV98', 'Id.Item.MK22',
      'Id.Item.Glock17', 'Id.Item.WEPN_029'] },
  rules: {
    headshots: { enabled: true, weight: 40, minKills: 100, ratio: 1.8, gapPoints: 15 },
    longRange: { enabled: true, weight: 55, minKills: 30, ratio: 2.5,
      gapPoints: 15, distanceM: 150, minPeerKills: 200, minPeerPlayers: 20 },
    burst: { enabled: true, weight: 25, windowSeconds: 60, minKills: 10,
      minDistinctVictims: 5 }
  },
  weaponOverrides: {}, thresholds: { watch: 20, review: 40, priority: 70 },
  display: { timezone: 'UTC', distanceEdgesM: [25, 50, 100, 150, 250],
    sessionPageSize: 25, panels: { timeline: true, distance: true, activity: true,
      weapons: true, sessions: true, opponents: true, steam: true, network: true } },
  steam: { enabled: true, appId: 1867240, refreshHours: 24, friendsRefreshDays: 7,
    maxFriends: 200, fields: { level: true, badges: false, ownedGames: true,
      recentGames: true, achievements: false, friendLinks: false } },
  network: { enabled: false, lookbackDays: 7, coJoinSeconds: 60, minOverlaps: 3,
    minSharedMinutes: 10, maxPeers: 30 },
  board: { minLevel: 'watch', cooldownMinutes: 60, snapshotRetentionDays: 90 },
  worker: { refreshSeconds: 120, maxPlayersPerJob: 25 }
});

export function weaponRules(c: IntelligenceConfig, tag: string) {
  const o = c.weaponOverrides[tag];
  return { headshots: { ...c.rules.headshots, ...o?.headshots },
    longRange: { ...c.rules.longRange, ...o?.longRange } };
}
```

### src/lib/intelligence/score.ts

```typescript
import type { IntelligenceConfig } from './config.ts';
import { weaponRules } from './config.ts';

export interface Counts { kills: number; headshots: number }
// One row per weapon + resolved cohort, not one blended row across different modes/maps.
export interface Comparison {
  cohortId: string; weapon: string;
  subject: Counts; peers: Counts & { players: number };
  longRange: { subject: Counts; peers: Counts & { players: number } };
}
export interface Finding {
  code: 'headshots' | 'longRange' | 'burst'; group: 'aim' | 'burst';
  weight: number; weapon?: string; cohortId?: string; detail: string;
}
export interface Burst {
  // A maximum from a rolling window with reliable ordering within one match-clock segment.
  kills: number; distinctVictims: number; windowSeconds: number; reliable: boolean;
}
export interface Evidence {
  comparisons: Comparison[];
  comparableCoveragePct: number;
  burst: Burst | null;
}

function valid(c: Counts): boolean {
  return Number.isSafeInteger(c.kills) && Number.isSafeInteger(c.headshots) &&
    c.kills >= 0 && c.headshots >= 0 && c.headshots <= c.kills;
}
function high(subject: Counts, peers: Counts, ratio: number, gapPoints: number) {
  const observed = subject.headshots / subject.kills;
  const expected = peers.headshots / peers.kills;
  // A zero observed peer rate is not an infinite-strength signal.
  return expected > 0 && observed / expected >= ratio &&
    100 * (observed - expected) >= gapPoints;
}

export function assessIntelligence(c: IntelligenceConfig, e: Evidence) {
  const findings: Finding[] = [];
  const unavailable: string[] = [];
  let eligibleRules = 0;
  if (c.enabled) for (const row of e.comparisons) {
    if (!c.filters.scoredWeaponTags.includes(row.weapon)) continue;
    const rules = weaponRules(c, row.weapon);
    const coverageOk = Number.isFinite(e.comparableCoveragePct) && e.comparableCoveragePct <= 100 &&
      e.comparableCoveragePct >= c.baseline.minComparableCoveragePct;
    const evaluate = (code: 'headshots' | 'longRange', s: Counts,
      p: Counts & { players: number }, minPeers: number, minPlayers: number) => {
      const r = rules[code];
      if (!r.enabled) return;
      if (!coverageOk || !valid(s) || !valid(p) || s.kills < r.minKills ||
          p.kills < minPeers || p.players < minPlayers || p.players > p.kills || !Number.isSafeInteger(p.players) ||
          p.headshots === 0) {
        unavailable.push(`${row.cohortId}: ${code} has insufficient comparable evidence`);
        return;
      }
      eligibleRules++;
      if (high(s, p, r.ratio, r.gapPoints)) findings.push({
        code, group: 'aim', weight: r.weight, weapon: row.weapon, cohortId: row.cohortId,
        detail: `${s.headshots}/${s.kills} headshots versus ${p.headshots}/${p.kills} ` +
          `among ${p.players} other players` +
          (code === 'longRange' ? ` at ${rules.longRange.distanceM}m or farther` : '')
      });
    };
    evaluate('headshots', row.subject, row.peers,
      c.baseline.minPeerKills, c.baseline.minPeerPlayers);
    evaluate('longRange', row.longRange.subject, row.longRange.peers,
      rules.longRange.minPeerKills, rules.longRange.minPeerPlayers);
  }
  const b = e.burst, r = c.rules.burst;
  if (c.enabled && r.enabled) {
    if (b?.reliable && b.windowSeconds === r.windowSeconds &&
        Number.isSafeInteger(b.kills) && Number.isSafeInteger(b.distinctVictims) &&
        b.kills >= 0 && b.distinctVictims >= 0 && b.distinctVictims <= b.kills) {
      eligibleRules++;
      if (b.kills >= r.minKills && b.distinctVictims >= r.minDistinctVictims)
        findings.push({ code: 'burst', group: 'burst', weight: r.weight,
          detail: `${b.kills} kills against ${b.distinctVictims} distinct victims ` +
            `within ${b.windowSeconds} seconds` });
    } else unavailable.push('Burst timing or victim coverage is unavailable');
  }
  // Correlated headshot findings, including different weapons, contribute once.
  const aim = Math.max(0, ...findings.filter(f => f.group === 'aim').map(f => f.weight));
  const burst = Math.max(0, ...findings.filter(f => f.group === 'burst').map(f => f.weight));
  const score = !c.enabled || !eligibleRules ? null : Math.min(100, aim + burst);
  const level = score === null ? null : score >= c.thresholds.priority ? 'priority' :
    score >= c.thresholds.review ? 'review' : score >= c.thresholds.watch ? 'watch' : 'clear';
  return { algorithmVersion: 1, mode: c.mode, score, level,
    state: !c.enabled ? 'disabled' : !eligibleRules ? 'insufficient_data' : 'ready',
    eligibleRules, findings, unavailable };
}

export interface TimedKill { segment: string; seconds: number; victim: string }
// Segments must distinguish server boot AND actual match-clock epoch.
// Do not pass the feed's raw matchId alone: it has been observed to be per-boot.
export function maxRollingBurst(events: TimedKill[], seconds: number, minDistinctVictims = 1): Burst | null {
  if (!(seconds > 0) || !events.length) return null;
  const segments = new Map<string, TimedKill[]>();
  for (const e of events) {
    if (!e.segment || !Number.isFinite(e.seconds) || e.seconds < 0 || !e.victim) return null;
    const rows = segments.get(e.segment) ?? [];
    rows.push(e); segments.set(e.segment, rows);
  }
  let best = { kills: 0, distinctVictims: 0, windowSeconds: seconds, reliable: true };
  for (const rows of segments.values()) {
    rows.sort((a, b) => a.seconds - b.seconds);
    let left = 0;
    const victims = new Map<string, number>();
    for (let right = 0; right < rows.length; right++) {
      const victim = rows[right].victim;
      victims.set(victim, (victims.get(victim) ?? 0) + 1);
      // Half-open interval (latest - window, latest].
      while (rows[right].seconds - rows[left].seconds >= seconds) {
        const old = rows[left++].victim;
        const n = victims.get(old)! - 1;
        if (n) victims.set(old, n); else victims.delete(old);
      }
      const kills = right - left + 1;
      if (victims.size >= minDistinctVictims &&
          (kills > best.kills || (kills === best.kills && victims.size > best.distinctVictims)))
        best = { ...best, kills, distinctVictims: victims.size };
    }
  }
  return best;
}
```

### Reference settings migration (revised: separate `drizzle/intel/` track, see R2)

```sql
-- drizzle/intel/0000_intel_settings.sql  (phase 2)
-- Separate track: do NOT add this to upstream's drizzle/meta/_journal.json and do
-- NOT define these tables in src/lib/server/db/schema.ts. For typed queries, define
-- the tables in src/lib/server/intelligence/db.ts. Separate statements with
-- '--> statement-breakpoint' lines, as upstream's migrations do.
CREATE TABLE intelligence_settings (
  org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  updated_by text REFERENCES "user"(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE intelligence_settings_revisions (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, revision)
);
```

**Track journal** — `drizzle/intel/meta/_journal.json`. The Drizzle migrator reads only this journal and the `.sql` files, so it can be written by hand. `when` is epoch milliseconds and must strictly increase with each entry; the migrator applies entries newer than the last one recorded in `drizzle.__intel_migrations`.

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    { "idx": 0, "version": "7", "when": 1790400000000, "tag": "0000_intel_settings", "breakpoints": true }
  ]
}
```

**Migration hook** — the only change to `src/lib/server/db/index.ts`. Both call sites (`src/lib/server/env.ts` for `WARCON_ROLE=all` and `src/worker/migrate.ts` for the `migrate` role) go through this function, so one edit covers both. It is a no-op until the track exists.

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
	await migrate(db, { migrationsFolder });
	// warcon-intel: separate track so upstream's journal never conflicts (plan R2).
	const intel = join(migrationsFolder, 'intel');
	if (existsSync(join(intel, 'meta', '_journal.json')))
		await migrate(db, { migrationsFolder: intel, migrationsTable: '__intel_migrations' });
}
```

Verify after the first deploy: `SELECT * FROM drizzle.__intel_migrations;` returns one row per applied intelligence migration, and `drizzle.__drizzle_migrations` is unchanged in count.

### src/routes/api/orgs/[id]/intelligence/settings/+server.ts

```typescript
// src/routes/api/orgs/[id]/intelligence/settings/+server.ts
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getEnv } from '$lib/server/env';
import { requireOrgRole } from '$lib/server/access';
import { ApiError, apiJson, param, readJson, route, userAgent } from '$lib/server/http';
import { auditLog } from '$lib/server/db/schema';
import { redact } from '$lib/server/audit';
import { DEFAULT_CONFIG, IntelligenceConfigSchema, type IntelligenceConfig }
  from '$lib/intelligence/config';

const Save = z.object({
  revision: z.number().int().nonnegative(), config: IntelligenceConfigSchema
}).strict();

export const GET = route(async (event) => {
  const env = getEnv();
  const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
  const [row] = await env.db.execute<{ revision: number; config: IntelligenceConfig }>(sql`
    SELECT revision, config FROM intelligence_settings WHERE org_id = ${org.id}`);
  if (row && !IntelligenceConfigSchema.safeParse(row.config).success)
    throw new ApiError(409, 'Stored intelligence settings need a compatible schema migration.',
      'stored_config_version');
  return apiJson({ ok: true, revision: row?.revision ?? 0,
    config: row?.config ?? structuredClone(DEFAULT_CONFIG) });
});

export const PATCH = route(async (event) => {
  const env = getEnv();
  const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
  const parsed = Save.safeParse(await readJson(event.request));
  if (!parsed.success)
    throw new ApiError(400, 'Check the intelligence settings.', 'invalid_config',
      parsed.error.flatten());
  const { revision: expected, config } = parsed.data;
  const revision = await env.db.transaction(async (tx) => {
    // Also serializes creation when this org has no settings row yet.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${'intelligence-config:' + org.id}, 0))`);
    const [old] = await tx.execute<{ revision: number }>(sql`
      SELECT revision FROM intelligence_settings WHERE org_id = ${org.id} FOR UPDATE`);
    if ((old?.revision ?? 0) !== expected)
      throw new ApiError(409, 'Another administrator saved changes. Reload before saving.',
        'config_conflict');
    const next = expected + 1;
    await tx.execute(sql`
      INSERT INTO intelligence_settings (org_id, revision, config, updated_by)
      VALUES (${org.id}, ${next}, ${JSON.stringify(config)}::jsonb, ${user.id})
      ON CONFLICT (org_id) DO UPDATE SET revision = excluded.revision,
        config = excluded.config, updated_by = excluded.updated_by, updated_at = now()`);
    await tx.execute(sql`
      INSERT INTO intelligence_settings_revisions (org_id, revision, config, created_by)
      VALUES (${org.id}, ${next}, ${JSON.stringify(config)}::jsonb, ${user.id})`);
    // Atomic local audit. The worker/notification integration is specified in the handoff.
    await tx.insert(auditLog).values({
      actorId: user.id, actorName: user.username, orgId: org.id,
      category: 'org', action: 'intelligence.settings.save', outcome: 'ok',
      target: org.id, message: `Saved intelligence settings revision ${next}`,
      detail: redact({ previousRevision: expected, revision: next }),
      userAgent: userAgent(event.request)
    });
    return next;
  });
  return apiJson({ ok: true, revision, config });
});
```

### src/lib/server/intelligence/scope.ts

```typescript
// src/lib/server/intelligence/scope.ts
// Requires the capability registration described in the implementation handoff.
import { createHash } from 'node:crypto';
import type { Env } from '$lib/server/env';
import { accessibleServers, serverAccessFor, type SessionUser } from '$lib/server/access';
import { ApiError } from '$lib/server/http';

export async function intelligenceServerIds(
  env: Env, user: SessionUser, orgId: string, requested?: string[]
): Promise<string[]> {
  const visible = await accessibleServers(env, user, orgId);
  const checked = await Promise.all(visible.map(async (s) => ({
    id: s.id, access: await serverAccessFor(env, user, s.id)
  })));
  const allowed = new Set(checked.filter(s => s.access?.caps.has('players.intelligence.read'))
    .map(s => s.id));
  if (requested?.some(id => !allowed.has(id)))
    throw new ApiError(403, 'The requested intelligence scope is not available.');
  return [...new Set(requested ?? allowed)].sort();
}

// Cache identity never replaces authorization. Compute permitted IDs anew on each request.
export function intelligenceCacheKey(input: {
  orgId: string; steamId: string; filtersHash: string;
  serverIds: string[]; revision: number; algorithmVersion: number;
  from: string; to: string; dataEpochs: Record<string, number>;
  draftHash?: string;
}) {
  const serverIds = [...new Set(input.serverIds)].sort();
  if (serverIds.some(id => !Number.isSafeInteger(input.dataEpochs[id])))
    throw new Error('Every scoped server needs a data epoch before reading its cache.');
  const dataEpochs = serverIds.map(id => [id, input.dataEpochs[id]]);
  return createHash('sha256').update(JSON.stringify({ ...input, serverIds, dataEpochs })).digest('hex');
}
```

### src/lib/components/intelligence/ConfigField.svelte

```svelte
<script lang="ts">
  import ConfigField from './ConfigField.svelte';
  let { name, path, value, onvalue, oninvalid }: {
    name: string; path: string; value: unknown;
    onvalue: (value: unknown) => void;
    oninvalid: (path: string, error: string) => void;
  } = $props();
  const label = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
  function jsonInput(text: string) {
    try { onvalue(JSON.parse(text)); oninvalid(path, ''); }
    catch { oninvalid(path, `${label(name)} needs valid JSON.`); }
  }
</script>

{#if name === 'schemaVersion'}
  <p>Configuration format: {String(value)}</p>
{:else if path.endsWith('weaponOverrides') || Array.isArray(value)}
  <label class="block my-3">
    <span>{label(name)} (JSON)</span>
    <textarea class="input w-full font-mono" rows="4"
      value={JSON.stringify(value, null, 2)}
      oninput={(e) => jsonInput(e.currentTarget.value)}></textarea>
  </label>
{:else if value !== null && typeof value === 'object'}
  <fieldset class="border border-white/10 rounded p-3 my-3">
    <legend>{label(name)}</legend>
    {#each Object.entries(value) as [key, child] (key)}
      <ConfigField name={key} path={`${path}.${key}`} value={child}
        onvalue={(next) => onvalue({ ...value, [key]: next })} {oninvalid} />
    {/each}
  </fieldset>
{:else if typeof value === 'boolean'}
  <label class="flex gap-2 my-2">
    <input type="checkbox" checked={value}
      onchange={(e) => onvalue(e.currentTarget.checked)} /> {label(name)}
  </label>
{:else if typeof value === 'number' || name === 'appId'}
  <label class="block my-2">
    {label(name)}
    <input class="input" type="number" step="any" value={value as number | null}
      oninput={(e) => onvalue(e.currentTarget.value === '' && name === 'appId' ?
        null : e.currentTarget.valueAsNumber)} />
  </label>
{:else if ['mode', 'cohort', 'minLevel'].includes(name)}
  <label class="block my-2">
    {label(name)}
    <select class="input" value={String(value)} onchange={(e) => onvalue(e.currentTarget.value)}>
      {#each name === 'mode' ? ['shadow', 'review'] : name === 'cohort' ?
        ['weapon', 'weapon_mode', 'weapon_mode_map'] : ['watch', 'review', 'priority'] as option}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </label>
{:else}
  <label class="block my-2">
    {label(name)}
    <input class="input" type="text" value={value === null ? '' : String(value)}
      oninput={(e) => onvalue(name === 'sinceUtc' && e.currentTarget.value === '' ?
        null : e.currentTarget.value)} />
  </label>
{/if}
```

### src/lib/components/intelligence/IntelligenceSettings.svelte

```svelte
<script lang="ts">
  import { untrack } from 'svelte';
  import { api, errorMessage } from '$lib/api';
  import { DEFAULT_CONFIG, IntelligenceConfigSchema, type IntelligenceConfig }
    from '$lib/intelligence/config';
  import ConfigField from './ConfigField.svelte';
  let { orgId, initial }: { orgId: string;
    initial: { revision: number; config: IntelligenceConfig } } = $props();
  // Render this editor in a {#key orgId} block when navigating between organisations.
  let draft = $state<unknown>(untrack(() => structuredClone(initial.config)));
  let revision = $state(untrack(() => initial.revision));
  let saved = $state(untrack(() => JSON.stringify(initial.config)));
  let parseErrors = $state<Record<string, string>>({});
  let busy = $state(false), message = $state('');
  let validation = $derived(IntelligenceConfigSchema.safeParse(draft));
  let dirty = $derived(JSON.stringify(draft) !== saved);
  let valid = $derived(validation.success && !Object.values(parseErrors).some(Boolean));
  const path = () => `/api/orgs/${encodeURIComponent(orgId)}/intelligence/settings`;
  function invalid(path: string, error: string) { parseErrors = { ...parseErrors, [path]: error }; }
  async function save() {
    if (!validation.success || !valid) return;
    busy = true; message = '';
    try {
      const result = await api<{ revision: number; config: IntelligenceConfig }>('PATCH', path(),
        { revision, config: validation.data });
      revision = result.revision; draft = structuredClone(result.config);
      saved = JSON.stringify(result.config);
      message = `Saved revision ${revision}. Results are refreshed by the worker.`;
    } catch (e) { message = errorMessage(e); } finally { busy = false; }
  }
  async function reload() {
    busy = true;
    try {
      const result = await api<{ revision: number; config: IntelligenceConfig }>('GET', path());
      revision = result.revision; draft = structuredClone(result.config);
      saved = JSON.stringify(result.config); parseErrors = {}; message = 'Reloaded saved settings.';
    } catch (e) { message = errorMessage(e); } finally { busy = false; }
  }
</script>

<form onsubmit={(e) => { e.preventDefault(); void save(); }}>
  <p>Review priority helps staff decide where to look. It is not a cheating probability.</p>
  <p>Shadow mode calculates results without adding players to the review queue.</p>
  <fieldset disabled={busy}>
    <ConfigField name="Intelligence settings" path="config" value={draft}
      onvalue={(v) => { draft = v; }} oninvalid={invalid} />
  </fieldset>
  {#if !validation.success}
    <ul role="alert">
      {#each validation.error.issues as issue}
        <li>{issue.path.join('.')}: {issue.message}</li>
      {/each}
    </ul>
  {/if}
  {#each Object.values(parseErrors).filter(Boolean) as error}<p role="alert">{error}</p>{/each}
  <p aria-live="polite">{message}</p>
  <div class="flex flex-wrap gap-2">
    <button class="btn" type="submit" disabled={busy || !valid || !dirty}>Save settings</button>
    <button class="btn" type="button" disabled={busy} onclick={reload}>Reload saved settings</button>
    <button class="btn" type="button" disabled={busy}
      onclick={() => { draft = structuredClone(DEFAULT_CONFIG); parseErrors = {}; }}>
      Load defaults into draft
    </button>
  </div>
  <p>Unsaved changes: {dirty ? 'yes' : 'no'} · Saved revision {revision}</p>
</form>
```

### src/lib/intelligence/score.test.ts (Node test version; adapt to Bun suite conventions)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, IntelligenceConfigSchema } from './config.ts';
import { assessIntelligence, maxRollingBurst, type Comparison, type Evidence } from './score.ts';

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), enabled: true });
const row = (): Comparison => ({
  cohortId: 'M4:modeA', weapon: 'Id.Item.M4',
  subject: { kills: 100, headshots: 60 }, peers: { kills: 1000, headshots: 200, players: 50 },
  longRange: { subject: { kills: 40, headshots: 25 },
    peers: { kills: 500, headshots: 100, players: 30 } }
});
const evidence = (): Evidence => ({ comparisons: [row()], comparableCoveragePct: 100,
  burst: { kills: 10, distinctVictims: 5, windowSeconds: 60, reliable: true } });

test('defaults validate and start disabled in shadow mode', () => {
  assert.equal(IntelligenceConfigSchema.safeParse(DEFAULT_CONFIG).success, true);
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.equal(DEFAULT_CONFIG.mode, 'shadow');
});
test('thresholds must increase; unknown properties rejected', () => {
  const c = config(); c.thresholds.review = 10;
  assert.equal(IntelligenceConfigSchema.safeParse(c).success, false);
  assert.equal(IntelligenceConfigSchema.safeParse({ ...config(), autoban: true }).success, false);
});
test('invalid distance edges and timezone rejected', () => {
  const c = config(); c.display.distanceEdgesM = [50, 25];
  assert.equal(IntelligenceConfigSchema.safeParse(c).success, false);
  c.display.distanceEdgesM = [25, 50]; c.display.timezone = 'Moon/Base';
  assert.equal(IntelligenceConfigSchema.safeParse(c).success, false);
});
test('correlated aim flags count once, plus burst: 55 + 25', () => {
  const result = assessIntelligence(config(), evidence());
  assert.equal(result.findings.length, 3); assert.equal(result.score, 80);
  assert.equal(result.level, 'priority');
});
test('duplicate/weapons aim flags never multiply the aim contribution', () => {
  const e = evidence(); e.comparisons.push(row());
  assert.equal(assessIntelligence(config(), e).score, 80);
});
test('configuration takes effect without changing score code', () => {
  const c = config(); c.rules.longRange.enabled = false; c.rules.headshots.weight = 20;
  assert.equal(assessIntelligence(c, evidence()).score, 45);
});
test('weapon overrides are applied', () => {
  const c = config(); c.weaponOverrides['Id.Item.M4'] = {
    headshots: { weight: 10 }, longRange: { enabled: false } };
  assert.equal(assessIntelligence(c, evidence()).score, 35);
});
test('missing evidence is unknown, not zero risk', () => {
  const e: Evidence = { comparisons: [], comparableCoveragePct: 0, burst: null };
  const result = assessIntelligence(config(), e);
  assert.equal(result.score, null); assert.equal(result.state, 'insufficient_data');
});
test('disabled module cannot return findings', () => {
  const r = assessIntelligence(DEFAULT_CONFIG, evidence());
  assert.equal(r.score, null); assert.deepEqual(r.findings, []);
});
test('small cohort is insufficient, not suspicious', () => {
  const e = evidence(); e.burst = null;
  e.comparisons[0].peers.players = 1; e.comparisons[0].longRange.peers.players = 1;
  assert.equal(assessIntelligence(config(), e).score, null);
});
test('zero peer headshots is not infinite-strength evidence', () => {
  const e = evidence(); e.burst = null;
  e.comparisons[0].peers.headshots = 0; e.comparisons[0].longRange.peers.headshots = 0;
  assert.equal(assessIntelligence(config(), e).score, null);
});
test('insufficient comparable coverage disables comparisons', () => {
  const e = evidence(); e.burst = null; e.comparableCoveragePct = 20;
  assert.equal(assessIntelligence(config(), e).score, null);
});
test('invalid headshot count is not scored', () => {
  const e = evidence(); e.burst = null;
  e.comparisons[0].subject.headshots = 200; e.comparisons[0].longRange.subject.headshots = 200;
  assert.equal(assessIntelligence(config(), e).score, null);
});
test('unreliable timing blocks burst, still permits other evidence', () => {
  const e = evidence(); e.burst!.reliable = false;
  assert.equal(assessIntelligence(config(), e).score, 55);
});
test('one repeated victim cannot satisfy a burst rule', () => {
  const e = evidence(); e.comparisons = []; e.burst!.distinctVictims = 1;
  assert.equal(assessIntelligence(config(), e).score, 0);
});
test('sliding window works across minute boundaries and excludes exact left edge', () => {
  const r = maxRollingBurst([59, 61, 119].map((seconds, i) =>
    ({ segment: 'boot1:round1', seconds, victim: String(i) })), 60);
  assert.equal(r!.kills, 2);
});
test('different clock segments never combine', () => {
  const r = maxRollingBurst([{ segment: 'A', seconds: 5, victim: 'x' },
    { segment: 'B', seconds: 6, victim: 'y' }], 60);
  assert.equal(r!.kills, 1);
});
test('rule scan can find a qualifying window even if the maximum farms one victim', () => {
  const events = Array.from({ length: 20 }, (_, seconds) =>
    ({ segment: 'A', seconds, victim: 'same' }));
  events.push(...Array.from({ length: 10 }, (_, i) =>
    ({ segment: 'A', seconds: 200 + i, victim: String(i) })));
  assert.equal(maxRollingBurst(events, 60)!.kills, 20);
  assert.equal(maxRollingBurst(events, 60, 5)!.kills, 10);
});
test('unknown clock segment suppresses burst output', () => {
  assert.equal(maxRollingBurst([{ segment: '', seconds: 2, victim: 'x' }], 60), null);
});
```


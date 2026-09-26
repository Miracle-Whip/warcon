# Upstream files changed by the intelligence module

| File | Change | Why |
|---|---|---|
| .github/workflows/release.yml | push-to-main trigger, sha tag | publish our images |
| src/lib/capabilities.ts | `players.intelligence.read` and `players.intelligence.review` appended to the end of `CAPABILITIES`, with their `CAPABILITY_INFO` entries (groups `read` and `moderate`), marked `warcon-intel` | phase 1: gate the intelligence page and API; review is registered now for the phase 3 board. The built-in admin role is `[...CAPABILITIES]`, so new organisations' admin roles and any role reset to built-in gain both; existing saved roles do not change (plan R4) |
| src/routes/(app)/server/[id]/players/[steamId]/+page.svelte | one `Intelligence →` link beside the Steam profile link, shown only with `players.intelligence.read`, marked `warcon-intel` | phase 1: the entry point from the dossier |
| src/lib/server/stats.ts | import `clearFleetMemo` and call it after the purge transaction commits, marked `warcon-intel` | phase 1: purged kills must not live on in the memoised fleet baselines |

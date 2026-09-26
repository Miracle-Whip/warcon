# Upstream files changed by the intelligence module

| File | Change | Why |
|---|---|---|
| .github/workflows/release.yml | push-to-main trigger, sha tag | publish our images |
| src/lib/capabilities.ts | `players.intelligence.read` and `players.intelligence.review` appended to the end of `CAPABILITIES`, with their `CAPABILITY_INFO` entries (groups `read` and `moderate`); the built-in admin is every capability except those two instead of `[...CAPABILITIES]`; each marked `warcon-intel` | phase 1: gate the intelligence page and API; review is registered now for the phase 3 board. Keeping them out of the built-in admin means new organisations, stored admin roles and roles reset to built-in all agree, and staff get intelligence only by an owner's grant (plan R4). Org owners and the site owner hold every capability regardless |
| src/routes/(app)/server/[id]/players/[steamId]/+page.svelte | one `Intelligence →` link beside the Steam profile link, shown only with `players.intelligence.read`, marked `warcon-intel` | phase 1: the entry point from the dossier |
| src/lib/server/stats.ts | import `clearFleetMemo` and call it after the purge transaction commits, marked `warcon-intel` | phase 1: purged kills must not live on in the memoised fleet baselines |
| src/test/api-matrix.test.ts | one `MATRIX` line: `GET api/servers/[id]/players/[steamId]/intelligence` is `cap:players.intelligence.read` | phase 1: every API route must have a line, and the line runs the new route's permission check against the whole cast |
| src/lib/capabilities.test.ts | in `built-ins nest`, `expect(admin.length).toBe(CAPABILITIES.length)` replaced by `expect(admin).toEqual(CAPABILITIES.filter((c) => !c.startsWith('players.intelligence.')))` | the built-in admin deliberately excludes the intelligence capabilities, so this assertion states the new rule |
| src/test/load-matrix.test.ts | one `MATRIX` line: `server/[id]/players/[steamId]/intelligence/+page.server.ts` is `cap:players.intelligence.read`, placed above the dossier's line so no existing line changes | phase 1: every page load under (app) must have a line, and the line runs the new load's permission check |

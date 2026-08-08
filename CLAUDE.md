# dingodirt — agent notes

## Code index (codebase-memory)

Use the codebase-memory index first for code questions about this repo. Do not start with Grep for symbol or structure lookups.

1. The indexed project name is `Users-grant-Desktop-Projects-dingodirt`.
2. Check freshness before you rely on the index. Compare the index `head_sha` (from `index_status`) with `git rev-parse HEAD`. If they differ, run `index_repository` on this repo (mode `moderate`, about 20 seconds).
3. After you merge a PR or pull `main`, run `index_repository` again. The next session then starts with a fresh index.

## Layout

- `apps/nav`, `apps/plan`, `apps/site`, `apps/studio` — the four apps.
- `core/rust` — the Rust workspace (daemon, ingest, geo, export, …).
- `core/basemap`, `core/schemes`, `core/appliers` — shared map assets behind symlinks; see `tests/no-stray-presets.test.mjs`.
- `server/migrations` — SQL migrations. The daemon applies them at boot with `sqlx::migrate!`; CI applies them with `psql` before it compiles.

## Gotchas

- The daemon reads `.env` from its working directory. Start it with CWD `~/DingoData`.
- Concurrent sessions share one checkout and one git index. Stage and commit atomically, and verify with `git show --stat` after each commit.

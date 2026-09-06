# dingodirt — agent notes

## Code index (codebase-memory)

Use the codebase-memory index first for code questions about this repo. Do not start with Grep for symbol or structure lookups.

1. The indexed project name is `Users-grant-Desktop-Projects-dingodirt`.
2. Check freshness before you rely on the index. Compare the index `head_sha` (from `index_status`) with `git rev-parse HEAD`. If they differ, run `index_repository` on this repo (mode `moderate`, about 20 seconds).
3. After you merge a PR or pull `main`, run `index_repository` again. The next session then starts with a fresh index.

## Workflow — branch, PR, merge

Every code change follows this sequence. Do not take a shorter path.

Local, nothing on GitHub yet:

1. Agree the change first. For large work, write a design doc into `docs/plans/`.
2. Do the index freshness check above.
3. Make a branch. Never commit work to `main`. One topic per branch.
4. Write the code. If Rust code or a migration changed, rebuild the daemon and restart it with CWD `~/DingoData`.
5. Verify in a real browser through the dev server, and show proof (screenshot or log).

GitHub:

6. Stage exact file paths, then commit. Never a bare `git commit` — see Gotchas.
7. Push the branch and open a PR (`gh pr create`).
8. Wait for the CI and Deploy checks to go green.

Land:

9. Merge the PR with squash, and delete the branch.
10. `git checkout main && git pull`.
11. Run `index_repository` again.

Ask first. Stop and ask before you:

- push anything the owner has not seen to this repo — it is public, design and scoping docs included;
- graft full history into this repo, run a deploy cutover, or change a domain or DNS record.

Parallel sessions each take their own branch. PRs merge one at a time and are reconciled onto `origin/main`.

## Layout

- `apps/nav`, `apps/plan`, `apps/site`, `apps/studio` — the four apps.
- `core/rust` — the Rust workspace (daemon, ingest, geo, export, …).
- `core/basemap`, `core/schemes`, `core/appliers` — shared map assets behind symlinks; see `tests/no-stray-presets.test.mjs`.
- `server/migrations` — SQL migrations. The daemon applies them at boot with `sqlx::migrate!`; CI applies them with `psql` before it compiles.

## Gotchas

- The daemon reads `.env` from its working directory. Start it with CWD `~/DingoData`.
- Concurrent sessions share one checkout and one git index. Stage and commit atomically, and verify with `git show --stat` after each commit.

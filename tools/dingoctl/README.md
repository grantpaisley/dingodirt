# dingoctl — start and stop the Dingo stack

A small local control panel for the seven processes that make up Dingo. It has
a web page and a command line. Both use the same manager, so you can start a
service in the terminal and stop it in the browser.

```bash
npm run panel          # from the repo root: opens http://localhost:8100
```

```bash
node tools/dingoctl/cli.mjs status
node tools/dingoctl/cli.mjs start db daemon plan
node tools/dingoctl/cli.mjs stop            # everything, in reverse order
node tools/dingoctl/cli.mjs restart daemon
node tools/dingoctl/cli.mjs log daemon
```

## The services

| id | Port | What it is |
|---|---|---|
| `db` | 5433 | PostGIS 16 in Docker (`server/docker-compose.yml`) |
| `daemon` | 3000 | The Rust API. Runs with `~/DingoData` as its folder, because it reads `.env` from there |
| `plan` | 5173 | Plan — Vite dev server |
| `nav` | 8138 | Nav — static server |
| `studio` | 8139 | Studio — static server |
| `site` | 3001 | The website — Next.js dev server |
| `tiles` | 8787 | PMTiles range server for local basemap work |

Studio gets 8139 and the site gets 3001. Their own defaults (8138 and 3000)
collide with Nav and the daemon.

Start order is the table order. `Start all` follows it, `Stop all` reverses it.
The daemon will not start until the database answers on 5433.

## How it decides that a service runs

The panel opens a TCP connection to the port, on `127.0.0.1` **and** on `::1`.
If either answers, the service runs. Both families matter: Vite binds
`localhost` as IPv6 only, so an IPv4-only probe would call Plan "stopped" and
then start a second copy on the next free port. This is why it also sees a daemon you started by hand in a terminal — it
marks that one **external** (amber). You can still stop an external service:
the panel finds the process that owns the port and stops it.

A service the panel started is **running** (green), and the panel shows its PID
and its log.

## Files and settings

- Logs go to `tools/dingoctl/logs/<id>.log` (not in git).
- PIDs go to `tools/dingoctl/.state.json` (not in git).
- `DINGO_SERVER_BIN` — the path to a built `dingo-server`. Without it the panel
  looks in `core/rust/target/release` then `core/rust/target/debug`, and falls
  back to `cargo run --release`. In a git worktree the target folder is usually
  empty, so set this variable, or accept the first slow build.
- `DINGO_DATA_DIR` — the daemon's working folder. Default `~/DingoData`.
- `DINGOCTL_PORT` — the panel's port. Default 8100.

## Safety

The panel binds to `127.0.0.1` only. Its API starts and stops processes, so it
must never listen on a public address.

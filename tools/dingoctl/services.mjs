// The Dingo local stack, in start order. Each entry is one process the panel
// can start, stop and watch. Status comes from a TCP probe on `port`, so a
// service you started by hand in a terminal shows as running here too.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Prefer a built binary; fall back to `cargo run` (slow first time). */
function daemonCommand(repoRoot) {
    const built = [
        process.env.DINGO_SERVER_BIN,
        join(repoRoot, 'core/rust/target/release/dingo-server'),
        join(repoRoot, 'core/rust/target/debug/dingo-server'),
    ].filter(Boolean).find((p) => existsSync(p))
    if (built) return { command: built, args: [] }
    return {
        command: 'cargo',
        args: ['run', '--release', '--manifest-path', join(repoRoot, 'core/rust/Cargo.toml'), '-p', 'dingo_daemon'],
    }
}

export function services(repoRoot) {
    const dataDir = process.env.DINGO_DATA_DIR || join(homedir(), 'DingoData')
    return [
        {
            id: 'db',
            name: 'Database',
            note: 'PostGIS 16 in Docker. Start this before the daemon.',
            port: 5433,
            // Docker owns the lifetime, so the panel never holds a PID for it.
            docker: true,
            cwd: join(repoRoot, 'server'),
            command: 'docker',
            args: ['compose', 'up', '-d'],
            stopCommand: { command: 'docker', args: ['compose', 'stop'] },
        },
        {
            id: 'daemon',
            name: 'Daemon',
            note: 'The Rust API. Its .env comes from the working folder, so it runs in ' + dataDir + '.',
            port: 3000,
            needs: ['db'],
            cwd: dataDir,
            ...daemonCommand(repoRoot),
            url: 'http://localhost:3000/api/rides',
        },
        {
            id: 'plan',
            name: 'Plan',
            note: 'React/Vite dev server. Needs `npm install` in apps/plan.',
            port: 5173,
            needs: ['daemon'],
            cwd: join(repoRoot, 'apps/plan'),
            command: 'npm',
            args: ['run', 'dev'],
            url: 'http://localhost:5173',
        },
        {
            id: 'nav',
            name: 'Nav',
            note: 'Static server for the ride app.',
            port: 8138,
            cwd: join(repoRoot, 'apps/nav'),
            command: 'node',
            args: ['serve.js', '8138'],
            url: 'http://localhost:8138',
        },
        {
            id: 'studio',
            name: 'Studio',
            note: 'Static server. Port 8139, because Nav has 8138 by default.',
            port: 8139,
            cwd: join(repoRoot, 'apps/studio'),
            command: 'node',
            args: ['serve.js', '8139'],
            url: 'http://localhost:8139',
        },
        {
            id: 'site',
            name: 'Site',
            note: 'Next.js dev server on 3001, because the daemon has 3000.',
            port: 3001,
            cwd: join(repoRoot, 'apps/site'),
            command: 'npm',
            args: ['run', 'dev', '--', '--port', '3001'],
            url: 'http://localhost:3001',
        },
        {
            id: 'tiles',
            name: 'Tiles',
            note: 'Range-request PMTiles server for local basemap work.',
            port: 8787,
            cwd: repoRoot,
            command: 'node',
            args: ['tools/dev-tile-server.js', '8787'],
        },
    ]
}

// Start, stop and watch the Dingo local stack.
//
// Two facts make a service "running":
//   * its port answers  — the truth, and it also sees processes started by hand;
//   * we hold its PID   — then we can show its log and stop it cleanly.
// A service can answer on its port without a PID here. The panel calls that
// "external", and it can still stop it by the port owner's PID.
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, statSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { services } from './services.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// DINGO_REPO_ROOT lets a copy of this code drive another checkout — a git
// worktree can then run the panel against the main checkout, which is where
// the built daemon and the installed node_modules live.
export const REPO_ROOT = process.env.DINGO_REPO_ROOT || join(HERE, '..', '..')
// State and logs belong to the checkout under control, not to the code that
// runs. So a panel started from a worktree keeps the PIDs the last panel wrote.
const STATE_DIR = join(REPO_ROOT, 'tools', 'dingoctl')
const LOG_DIR = join(STATE_DIR, 'logs')
const STATE_FILE = join(STATE_DIR, '.state.json')
const WINDOWS = process.platform === 'win32'

export const SERVICES = services(REPO_ROOT)
export const byId = (id) => SERVICES.find((s) => s.id === id)

// ---------- state ----------

function readState() {
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    } catch {
        return {}
    }
}

function writeState(state) {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function alive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

// ---------- ports ----------

function hostAnswers(host, port, timeout) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host })
        const done = (result) => {
            socket.destroy()
            resolve(result)
        }
        socket.setTimeout(timeout)
        socket.once('connect', () => done(true))
        socket.once('timeout', () => done(false))
        socket.once('error', () => done(false))
    })
}

/**
 * Probe IPv4 and IPv6 together. A server that binds `localhost` can listen on
 * `[::1]` only — Vite does. An IPv4-only probe misses it, reports "stopped",
 * and the panel then starts a second copy on the next free port.
 */
export async function portOpen(port, timeout = 400) {
    const answers = await Promise.all([
        hostAnswers('127.0.0.1', port, timeout),
        hostAnswers('::1', port, timeout),
    ])
    return answers.some(Boolean)
}

async function waitForPort(port, up, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if ((await portOpen(port)) === up) return true
        await new Promise((r) => setTimeout(r, 300))
    }
    return false
}

/** The PID that listens on a port, for a process the panel did not start. */
function pidOnPort(port) {
    return new Promise((resolve) => {
        // lsof -i covers both address families, so an IPv6-only listener
        // (Vite) is found here too.
        const [cmd, args] = WINDOWS
            ? ['netstat', ['-ano', '-p', 'TCP']]
            : ['lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN']]
        execFile(cmd, args, (err, stdout) => {
            if (err && !stdout) return resolve(null)
            if (!WINDOWS) {
                const pid = parseInt(String(stdout).split('\n')[0], 10)
                return resolve(Number.isFinite(pid) ? pid : null)
            }
            for (const line of String(stdout).split('\n')) {
                const parts = line.trim().split(/\s+/)
                if (parts.length >= 5 && parts[3] === 'LISTENING' && parts[1].endsWith(':' + port)) {
                    const pid = parseInt(parts[4], 10)
                    if (Number.isFinite(pid)) return resolve(pid)
                }
            }
            resolve(null)
        })
    })
}

function killTree(pid, signal = 'SIGTERM') {
    if (WINDOWS) {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
        return
    }
    // The child is a process-group leader (detached), so the whole tree goes —
    // `npm run dev` and its Vite/Next child included.
    try {
        process.kill(-pid, signal)
    } catch {
        try {
            process.kill(pid, signal)
        } catch {
            /* already gone */
        }
    }
}

// ---------- status ----------

export async function status(service) {
    const state = readState()
    const entry = state[service.id]
    const owned = entry && alive(entry.pid) ? entry : null
    const up = await portOpen(service.port)
    return {
        id: service.id,
        name: service.name,
        note: service.note,
        port: service.port,
        url: service.url || null,
        needs: service.needs || [],
        up,
        managed: Boolean(owned),
        external: up && !owned && !service.docker,
        docker: Boolean(service.docker),
        pid: owned ? owned.pid : null,
        since: owned ? owned.startedAt : null,
        command: [service.command, ...(service.args || [])].join(' '),
        cwd: service.cwd,
        cwdMissing: !existsSync(service.cwd),
        logSize: logSize(service.id),
    }
}

export async function statusAll() {
    return Promise.all(SERVICES.map(status))
}

// ---------- logs ----------

function logPath(id) {
    return join(LOG_DIR, id + '.log')
}

function logSize(id) {
    try {
        return statSync(logPath(id)).size
    } catch {
        return 0
    }
}

export function readLog(id, lines = 200) {
    try {
        const text = readFileSync(logPath(id), 'utf8')
        return text.split('\n').slice(-lines).join('\n')
    } catch {
        return '(no log yet — this service has not been started from the panel)'
    }
}

// ---------- start / stop ----------

export async function start(id) {
    const service = byId(id)
    if (!service) throw new Error('unknown service: ' + id)
    if (await portOpen(service.port)) return { id, ok: true, message: 'already running' }
    if (!existsSync(service.cwd)) {
        return { id, ok: false, message: 'folder not found: ' + service.cwd }
    }

    for (const need of service.needs || []) {
        const dep = byId(need)
        if (!(await portOpen(dep.port))) {
            return { id, ok: false, message: 'start ' + dep.name + ' first' }
        }
    }

    mkdirSync(LOG_DIR, { recursive: true })
    const out = openSync(logPath(id), 'a')
    const child = spawn(service.command, service.args || [], {
        cwd: service.cwd,
        detached: !WINDOWS,
        stdio: ['ignore', out, out],
        env: process.env,
    })
    child.unref()

    if (service.docker) {
        // `docker compose up -d` returns at once; the container needs a moment.
        const ready = await waitForPort(service.port, true, 60000)
        return { id, ok: ready, message: ready ? 'started' : 'Docker did not open port ' + service.port }
    }

    const state = readState()
    state[id] = { pid: child.pid, startedAt: new Date().toISOString() }
    writeState(state)

    // A build (cargo, next) can take a while, so wait generously. But stop the
    // wait the moment the process dies — a missing node_modules fails in a
    // second, and the panel must say so at once. The log holds the reason.
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
        if (await portOpen(service.port)) return { id, ok: true, message: 'started' }
        if (!alive(child.pid)) {
            delete state[id]
            writeState(state)
            return { id, ok: false, message: 'the process stopped — read the log' }
        }
        await new Promise((r) => setTimeout(r, 300))
    }
    return { id, ok: false, message: 'still starting after 3 minutes — read the log' }
}

export async function stop(id) {
    const service = byId(id)
    if (!service) throw new Error('unknown service: ' + id)

    if (service.docker) {
        await new Promise((resolve) => {
            execFile(service.stopCommand.command, service.stopCommand.args, { cwd: service.cwd }, () => resolve())
        })
        const down = await waitForPort(service.port, false, 30000)
        return { id, ok: down, message: down ? 'stopped' : 'the port still answers' }
    }

    const state = readState()
    const entry = state[id]
    let pid = entry && alive(entry.pid) ? entry.pid : null
    if (!pid) pid = await pidOnPort(service.port)
    if (!pid) {
        delete state[id]
        writeState(state)
        return { id, ok: true, message: 'not running' }
    }

    killTree(pid, 'SIGTERM')
    let down = await waitForPort(service.port, false, 8000)
    if (!down) {
        killTree(pid, 'SIGKILL')
        down = await waitForPort(service.port, false, 5000)
    }
    delete state[id]
    writeState(state)
    return { id, ok: down, message: down ? 'stopped' : 'the port still answers' }
}

/** Start every service in order, or stop every service in reverse order. */
export async function startAll(ids) {
    const wanted = ids && ids.length ? SERVICES.filter((s) => ids.includes(s.id)) : SERVICES
    const results = []
    for (const service of wanted) results.push(await start(service.id))
    return results
}

export async function stopAll(ids) {
    const wanted = ids && ids.length ? SERVICES.filter((s) => ids.includes(s.id)) : SERVICES
    const results = []
    for (const service of [...wanted].reverse()) results.push(await stop(service.id))
    return results
}

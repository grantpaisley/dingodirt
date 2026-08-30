// The panel starts the daemon from a built binary. Release used to win even
// when it was months old, so a stale release build ran instead of the fresh
// debug one and the daemon died at boot with `VersionMissing` — its embedded
// migrations lacked a version the database already had. Newest build wins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonCommand } from '../tools/dingoctl/services.mjs'

/** A fake repo root holding the named daemon builds, oldest first. */
function repoWith(builds) {
    const root = mkdtempSync(join(tmpdir(), 'dingoctl-bin-'))
    builds.forEach((profile, i) => {
        const dir = join(root, 'core/rust/target', profile)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'dingo-server')
        writeFileSync(path, '')
        // Seconds apart, so the order is unambiguous on a coarse mtime clock.
        const when = new Date(2026, 0, 1, 0, 0, i)
        utimesSync(path, when, when)
    })
    return root
}

const daemonPath = (root) => daemonCommand(root).command

test('the newer debug build beats a stale release build', () => {
    const root = repoWith(['release', 'debug'])
    assert.equal(daemonPath(root), join(root, 'core/rust/target/debug/dingo-server'))
})

test('the newer release build beats a stale debug build', () => {
    const root = repoWith(['debug', 'release'])
    assert.equal(daemonPath(root), join(root, 'core/rust/target/release/dingo-server'))
})

test('one build alone is used', () => {
    const root = repoWith(['debug'])
    assert.equal(daemonPath(root), join(root, 'core/rust/target/debug/dingo-server'))
})

test('no build falls back to cargo run', () => {
    const { command, args } = daemonCommand(repoWith([]))
    assert.equal(command, 'cargo')
    assert.ok(args.includes('dingo_daemon'))
})

test('DINGO_SERVER_BIN overrides a newer build', (t) => {
    const root = repoWith(['release', 'debug'])
    const override = join(root, 'core/rust/target/release/dingo-server')
    t.after(() => delete process.env.DINGO_SERVER_BIN)
    process.env.DINGO_SERVER_BIN = override
    assert.equal(daemonPath(root), override)
})

test('a DINGO_SERVER_BIN that does not exist falls back to a build', (t) => {
    const root = repoWith(['debug'])
    t.after(() => delete process.env.DINGO_SERVER_BIN)
    process.env.DINGO_SERVER_BIN = join(root, 'nowhere/dingo-server')
    assert.equal(daemonPath(root), join(root, 'core/rust/target/debug/dingo-server'))
})

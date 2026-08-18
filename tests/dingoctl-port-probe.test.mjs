// The panel decides that a service runs by probing its port. Vite binds
// `localhost` as IPv6 only, so an IPv4-only probe reported "stopped" and the
// panel started a second copy on the next free port. Guard both families.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { portOpen } from '../tools/dingoctl/manager.mjs'

/** A listener on one address family only. Resolves to its port. */
function listenOn(host) {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, host, () => resolve({ server, port: server.address().port }))
    })
}

const close = (server) => new Promise((resolve) => server.close(resolve))

test('an IPv6-only listener counts as running', async () => {
    const { server, port } = await listenOn('::1')
    try {
        assert.equal(await portOpen(port), true)
    } finally {
        await close(server)
    }
})

test('an IPv4-only listener counts as running', async () => {
    const { server, port } = await listenOn('127.0.0.1')
    try {
        assert.equal(await portOpen(port), true)
    } finally {
        await close(server)
    }
})

test('a free port counts as stopped', async () => {
    const { server, port } = await listenOn('127.0.0.1')
    await close(server)
    assert.equal(await portOpen(port), false)
})

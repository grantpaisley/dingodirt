// The control panel web server.
//
// It binds to 127.0.0.1 only. The API starts and stops processes, so it must
// never listen on a public address.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { statusAll, start, stop, startAll, stopAll, readLog } from './manager.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const portArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const PORT = parseInt(portArg || process.env.DINGOCTL_PORT || '8100', 10)

function json(res, body, code = 200) {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(text)
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    try {
        if (path === '/' || path === '/index.html') {
            const html = readFileSync(join(HERE, 'public/index.html'))
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            return res.end(html)
        }
        if (path === '/api/status') return json(res, await statusAll())
        if (path === '/api/log') return json(res, { log: readLog(url.searchParams.get('id'), 300) })

        if (req.method === 'POST') {
            const id = url.searchParams.get('id')
            if (path === '/api/start') return json(res, await start(id))
            if (path === '/api/stop') return json(res, await stop(id))
            if (path === '/api/start-all') return json(res, await startAll())
            if (path === '/api/stop-all') return json(res, await stopAll())
        }

        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
    } catch (err) {
        json(res, { ok: false, message: String(err && err.message ? err.message : err) }, 500)
    }
})

server.listen(PORT, '127.0.0.1', () => {
    const address = 'http://localhost:' + PORT
    console.log('Dingo control panel on ' + address)
    if (process.argv.includes('--open')) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        const child = spawn(opener, [address], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
        // No browser to open in a headless environment: don't let that take the panel down.
        child.on('error', () => {})
        child.unref()
    }
})

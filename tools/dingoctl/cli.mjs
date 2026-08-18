// Terminal front end for the same manager the web panel uses.
//   node tools/dingoctl/cli.mjs status
//   node tools/dingoctl/cli.mjs start plan
//   node tools/dingoctl/cli.mjs stop            (stops everything, in reverse)
import { statusAll, start, stop, startAll, stopAll, readLog, SERVICES } from './manager.mjs'

const [action, ...ids] = process.argv.slice(2)
const pad = (text, width) => String(text).padEnd(width)

function usage() {
    console.log('usage: node tools/dingoctl/cli.mjs <status|start|stop|restart|log> [service ...]')
    console.log('services: ' + SERVICES.map((s) => s.id).join(', '))
}

async function show() {
    const rows = await statusAll()
    console.log(pad('SERVICE', 10) + pad('PORT', 7) + pad('STATE', 12) + 'URL')
    for (const row of rows) {
        const state = row.up ? (row.managed ? 'running' : row.docker ? 'running' : 'external') : 'stopped'
        console.log(pad(row.id, 10) + pad(row.port, 7) + pad(state, 12) + (row.url || ''))
    }
}

function report(results) {
    for (const result of [].concat(results)) {
        console.log((result.ok ? '  ok  ' : ' FAIL ') + pad(result.id, 10) + result.message)
    }
}

switch (action) {
    case 'status':
    case undefined:
        await show()
        break
    case 'start':
        report(ids.length ? await Promise.all(ids.map(start)) : await startAll())
        break
    case 'stop':
        report(ids.length ? await Promise.all(ids.map(stop)) : await stopAll())
        break
    case 'restart':
        report(await stopAll(ids))
        report(await startAll(ids))
        break
    case 'log':
        console.log(readLog(ids[0], 300))
        break
    default:
        usage()
        process.exitCode = 1
}

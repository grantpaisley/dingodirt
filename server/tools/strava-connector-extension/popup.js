// Reads the three httpOnly CloudFront cookies Strava sets for the global
// heatmap and POSTs them to the Dingo daemon, which then proxies authenticated
// tiles. httpOnly cookies are invisible to page scripts / bookmarklets, but the
// extension `cookies` permission can read them — that's the whole point of this.

const KEY = 'CloudFront-Key-Pair-Id';
const POLICY = 'CloudFront-Policy';
const SIGNATURE = 'CloudFront-Signature';
const NEEDED = [KEY, POLICY, SIGNATURE];

// A concrete authenticated tile URL. getAll({url}) returns exactly the cookies
// the browser would send to it — so we only ever see the set that actually
// signs tile requests, not stale copies scoped to unrelated paths.
const TILE_URL = 'https://heatmap-external-a.strava.com/tiles-auth/all/hot/14/0/0.png';

const statusEl = document.getElementById('status');
const retryEl = document.getElementById('retry');
const daemonEl = document.getElementById('daemon');

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

// Return the three CloudFront values from ONE coherent cookie set. Duplicate
// copies exist across scopes — e.g. Strava's content-CDN set on `.strava.com`
// path `/` alongside the heatmap signing set on a deeper path; mixing a
// Key-Pair-Id from one set with a Policy/Signature from another yields
// CloudFront "InvalidKey / Unknown Key". So we group candidates by
// (domain, path) and only accept a scope that carries all three, preferring
// the most specific path, then domain — what the browser sends first.
function coherentSet(cookies) {
  const byScope = new Map();
  for (const c of cookies) {
    if (!NEEDED.includes(c.name)) continue;
    const scope = c.domain.replace(/^\./, '') + '|' + (c.path || '/');
    if (!byScope.has(scope)) byScope.set(scope, {});
    byScope.get(scope)[c.name] = c.value;
  }
  const complete = [...byScope.entries()]
    .filter(([, s]) => NEEDED.every(n => s[n]))
    .sort(([a], [b]) => {
      const [ad, ap] = a.split('|'), [bd, bp] = b.split('|');
      return bp.length - ap.length || bd.length - ad.length;
    });
  if (!complete.length) return null;
  const s = complete[0][1];
  return { key_pair_id: s[KEY], policy: s[POLICY], signature: s[SIGNATURE] };
}

async function connect() {
  retryEl.disabled = true;
  try {
    setStatus('Reading Strava cookies…');
    // Cookies the browser would send to the tile host, plus the broader jar as a
    // fallback (older Chrome scoping quirks).
    const [forTile, forDomain] = await Promise.all([
      chrome.cookies.getAll({ url: TILE_URL }),
      chrome.cookies.getAll({ domain: 'strava.com' }),
    ]);
    const body = coherentSet(forTile) || coherentSet(forDomain);

    if (!body) {
      setStatus(
        '⚠️ Couldn’t find a complete CloudFront cookie set.\n\nOpen strava.com/maps/global-heatmap (logged in) and let the map draw tiles once, then click Connect again.',
        'err');
      return;
    }

    const base = (daemonEl.value || 'http://localhost:3000').replace(/\/+$/, '');
    setStatus('Sending to Dingo…');
    const res = await fetch(`${base}/api/strava-heatmap/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setStatus('✅ Connected. Strava heatmap cookies sent to Dingo.\nRe-run this weekly when the overlay goes blank.', 'ok');
    } else {
      setStatus(`❌ Daemon rejected it (${res.status}):\n${await res.text()}`, 'err');
    }
  } catch (e) {
    setStatus(
      `❌ Couldn’t reach the Dingo daemon at ${daemonEl.value}.\nIs dingo-server running?\n\n(${e})`,
      'err');
  } finally {
    retryEl.disabled = false;
  }
}

retryEl.addEventListener('click', connect);
// Auto-run on open so the common case is truly one click (open popup → done).
connect();

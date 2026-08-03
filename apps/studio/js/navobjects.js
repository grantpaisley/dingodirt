/* Nav objects workspace — object-first editing of the nav UI.
   Left pane: the chrome/behaviour objects. Right panel: the selected object's
   details, merging its scheme tokens (look/placement) and behaviour params
   (when/how it acts). The stage preview gets a selection overlay: click an
   element to select it, drag anchored elements (speedo, re-centre) between
   corner slots to move them — dropping writes the chrome.*Pos token. */

import { TOKEN_DEFS } from './scheme.js';
import { PARAM_DEFS, bv, behaviorWarnings } from './behavior.js';
import { ED, tokenRow, setToken, setParam, setBehaviorProfile, saveBehaviorToLibrary,
  behaviorLibrary, loadBehavior, exportBehavior, toast } from './editor.js';

const $ = id => document.getElementById(id);

/* Object registry: el = chrome selector inside the NavView (null = logic-only),
   drag = anchored placement (token + slots), tokens = scheme keys, params = behaviour keys. */
const OBJECTS = [
  { id: 'turnPanel', label: 'Next-turn panel', glyph: '⬒', el: '.nv-hudBox',
    tokens: ['chrome.turnPanel', 'chrome.turnPanelBg', 'hud.arrow', 'hud.arrowOp'],
    params: ['hud.nextTurnPanel', 'guidance.stackCues', 'guidance.laneGuidance'] },
  { id: 'speedo', label: 'Speedometer', glyph: '◷', el: '.nv-speed',
    drag: { token: 'chrome.speedoPos', slots: { topLeft: [0, 0], bottomLeft: [0, 1], bottomRight: [1, 1] } },
    tokens: ['chrome.speedoStyle', 'chrome.speedoPos'],
    params: ['hud.speedo', 'hud.units'] },
  { id: 'limit', label: 'Speed limit sign', glyph: '◙', el: '.nv-limit',
    tokens: ['chrome.limitSign'],
    params: ['hud.speedLimit', 'hud.speedAlert', 'hud.speedAlertKmh'] },
  { id: 'eta', label: 'ETA / stats panel', glyph: '▭', el: '.nv-eta',
    tokens: ['chrome.etaStyle'],
    params: ['hud.etaPanel'] },
  { id: 'banner', label: 'Off-track banner', glyph: '▬', el: '.nv-banner',
    tokens: ['marks.banner'],
    params: ['offroute.banner', 'offroute.detectM', 'offroute.rejoinM', 'offroute.alert',
      'offroute.repeatSecs', 'offroute.guideLine', 'offroute.maxDeviationM'] },
  { id: 'bigArrows', label: 'Big side arrows', glyph: '⮘', el: '.nv-bigL',
    tokens: ['chrome.bigArrows', 'hud.arrow', 'hud.arrowOp'], params: [] },
  { id: 'recentre', label: 'Re-centre button', glyph: '▣', el: '.nv-dot',
    drag: { token: 'chrome.recentrePos', slots: { bottomLeft: [0, 1], bottomRight: [1, 1] } },
    tokens: ['chrome.recentrePos', 'chrome.recentreStyle'], params: [] },
  { id: 'zoom', label: 'Zoom buttons', glyph: '±', el: '.nv-zoom',
    tokens: ['chrome.zoomButtons'], params: [] },
  { id: 'marker', label: 'Position marker & trail', glyph: '➤', el: null,
    tokens: ['overlays.breadcrumb'],
    params: ['position.marker', 'position.snapToRoute', 'position.breadcrumb', 'position.breadcrumbSpacingM'] },
  { id: 'camera', label: 'Camera', glyph: '⌖', el: null, tokens: ['chrome.scale'],
    params: ['camera.followMode', 'camera.pauseOnGesture', 'camera.pitch', 'camera.autoZoom',
      'camera.zoomMode', 'camera.zoomCurve', 'camera.maxZoom', 'camera.approachZoom',
      'camera.approachSecs', 'camera.approachMul', 'camera.approachFloorM',
      'camera.lookAhead', 'camera.easeMs'] },
  { id: 'guidance', label: 'Guidance & cue timing', glyph: '⑃', el: null, tokens: [],
    params: ['guidance.mode', 'guidance.cueSource', 'guidance.strictOrder', 'guidance.waypointAdvance',
      'cues.farSecs', 'cues.farMinM', 'cues.farMaxM', 'cues.nearSecs', 'cues.nearMinM', 'cues.nearMaxM',
      'cues.dangerFarM', 'cues.dangerNearM', 'cues.confirmAfterM'] },
  { id: 'voice', label: 'Voice & sound', glyph: '♪', el: null, tokens: [],
    params: ['voice.mode', 'voice.density', 'voice.streetNames'] },
  { id: 'reroute', label: 'Rerouting', glyph: '⇌', el: null, tokens: [],
    params: ['reroute.mode', 'reroute.triggerM', 'reroute.retrySecs', 'reroute.confirm'] },
];

/* behaviour param row — sibling of the editor's tokenRow, no night overlay */
function paramRow(key) {
  const def = PARAM_DEFS[key];
  const cur = bv(ED.behavior, key);
  const row = document.createElement('div');
  row.className = 'trow';
  const lab = document.createElement('label'); lab.textContent = def.label;
  row.appendChild(lab);
  if (def.type === 'number') {
    const inp = document.createElement('input'); inp.type = 'range';
    inp.min = def.min; inp.max = def.max; inp.step = def.step; inp.value = cur;
    const val = document.createElement('span'); val.className = 'tval'; val.textContent = cur;
    inp.oninput = () => { val.textContent = inp.value; setParam(key, parseFloat(inp.value)); };
    row.appendChild(inp); row.appendChild(val);
  } else if (def.type === 'bool') {
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!cur;
    inp.onchange = () => setParam(key, inp.checked);
    row.appendChild(inp);
  } else if (def.type === 'select') {
    const seg = document.createElement('span'); seg.className = 'seg';
    for (const o of def.opts) {
      const b = document.createElement('button'); b.textContent = o;
      b.classList.toggle('active', cur === o);
      b.onclick = () => { setParam(key, o);
        for (const x of seg.children) x.classList.toggle('active', x === b); };
      seg.appendChild(b);
    }
    row.appendChild(seg);
  } else if (def.type === 'curve') {
    row.classList.add('curverow');
    const box = document.createElement('div'); box.className = 'curve';
    const render = () => {
      const c = bv(ED.behavior, key);
      box.innerHTML = '<div class="crow chead"><span>km/h</span><span>view m</span><span></span></div>';
      c.forEach((p, i) => {
        const r = document.createElement('div'); r.className = 'crow';
        const mk = (v, j) => {
          const inp = document.createElement('input'); inp.type = 'number'; inp.value = v;
          inp.onchange = () => {
            const next = bv(ED.behavior, key).map(q => [...q]);
            next[i][j] = parseFloat(inp.value) || 0;
            next.sort((a, b) => a[0] - b[0]);
            setParam(key, next); render();
          };
          return inp;
        };
        r.appendChild(mk(p[0], 0)); r.appendChild(mk(p[1], 1));
        const x = document.createElement('button'); x.className = 'reset'; x.textContent = '✕';
        x.onclick = () => { const next = bv(ED.behavior, key).filter((_, j) => j !== i);
          if (next.length) { setParam(key, next); render(); } };
        r.appendChild(x);
        box.appendChild(r);
      });
      if (c.length < 8) {
        const add = document.createElement('button'); add.className = 'cadd'; add.textContent = '+ point';
        add.onclick = () => { const c2 = bv(ED.behavior, key);
          const last = c2[c2.length - 1];
          setParam(key, [...c2.map(q => [...q]), [last[0] + 20, last[1] * 1.5 | 0]]); render(); };
        box.appendChild(add);
      }
    };
    render();
    row.appendChild(box);
  }
  return row;
}

export class NavObjects {
  constructor() {
    this.sel = OBJECTS[0];
    this.active = false;
    this._syncT = null;
    ED.onBehavior = () => { if (this.active) { this.buildDetail(); } };
  }

  open() {
    this.active = true;
    ED.view.setChromePreview(true);
    this.buildList();
    this.buildDetail();
    this._ensureOverlay();
    this._syncT = setInterval(() => this._syncOverlay(), 400); // chrome moves with edits + rides
  }
  close() {
    this.active = false;
    ED.view.setChromePreview(false);
    clearInterval(this._syncT);
    if (this.overlay) this.overlay.style.display = 'none';
  }

  select(obj) {
    this.sel = obj;
    for (const li of $('objects').querySelectorAll('.obj'))
      li.classList.toggle('active', li.dataset.id === obj.id);
    this.buildDetail();
    this._syncOverlay();
  }

  buildList() {
    const el = $('objects');
    el.innerHTML = '<div class="objhead">Nav objects</div>';
    for (const o of OBJECTS) {
      const li = document.createElement('div');
      li.className = 'obj' + (o === this.sel ? ' active' : '');
      li.dataset.id = o.id;
      li.innerHTML = `<span class="oglyph">${o.glyph}</span>${o.label}` +
        (o.drag ? '<span class="odrag" title="Draggable on the preview">⠿</span>' : '');
      li.onclick = () => this.select(o);
      el.appendChild(li);
    }
  }

  buildDetail() {
    const el = $('detail');
    el.innerHTML = '';
    // behaviour identity bar — the profile these params belong to
    const head = document.createElement('div'); head.className = 'bhead';
    head.innerHTML = `
      <input id="behName" placeholder="Behaviour name" title="Behaviour profile name">
      <div class="brow">
        <select id="behLibrary"><option value="">Behaviour…</option></select>
        <button id="behSave" title="Save to library">Save</button>
        <button id="behExport" title="Export .dingobehavior">Export</button>
      </div>`;
    el.appendChild(head);
    head.querySelector('#behName').value = ED.behavior.name;
    head.querySelector('#behName').onchange = e => { ED.behavior.name = e.target.value.trim() || 'Untitled behaviour'; setBehaviorProfile(ED.behavior); };
    head.querySelector('#behSave').onclick = () => saveBehaviorToLibrary();
    head.querySelector('#behExport').onclick = exportBehavior;
    const libSel = head.querySelector('#behLibrary');
    behaviorLibrary().then(({ builtins, recs }) => {
      libSel.innerHTML = '<option value="">Behaviour…</option>' +
        '<optgroup label="Built-in">' + builtins.map(b => `<option value="builtin:${b.id}">${b.label}</option>`).join('') + '</optgroup>' +
        (recs.length ? '<optgroup label="My library">' + recs.map(r => `<option value="${r.id}">${r.behavior.name}</option>`).join('') + '</optgroup>' : '');
    });
    libSel.onchange = e => { const v = e.target.value; e.target.value = ''; if (v) loadBehavior(v).catch(err => toast('Load failed: ' + err.message)); };

    const o = this.sel;
    const title = document.createElement('div'); title.className = 'objtitle';
    title.textContent = o.label;
    el.appendChild(title);

    if (o.tokens.length) {
      const s = document.createElement('div'); s.className = 'osec'; s.textContent = 'Look & layout — scheme';
      el.appendChild(s);
      for (const k of o.tokens) if (TOKEN_DEFS[k]) el.appendChild(tokenRow(k, TOKEN_DEFS[k]));
    }
    if (o.params.length) {
      const s = document.createElement('div'); s.className = 'osec'; s.textContent = 'Behaviour — profile';
      el.appendChild(s);
      for (const k of o.params) if (PARAM_DEFS[k]) el.appendChild(paramRow(k));
    }
    const warns = behaviorWarnings(ED.behavior);
    if (warns.length) {
      const w = document.createElement('div'); w.className = 'owarn';
      w.innerHTML = warns.map(m => '⚠ ' + m).join('<br>');
      el.appendChild(w);
    }
    if (o.drag) {
      const hint = document.createElement('div'); hint.className = 'ohint';
      hint.textContent = 'Drag this element on the preview to move it between corners.';
      el.appendChild(hint);
    }
  }

  /* ---------------- stage overlay: select + drag-to-anchor ---------------- */
  _ensureOverlay() {
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = 'objOverlay';
      $('frame').appendChild(this.overlay);
    }
    this.overlay.style.display = '';
    this._syncOverlay();
  }

  _syncOverlay() {
    if (!this.active || !this.overlay || !ED.view) return;
    if (this._dragging) return; // don't rebuild under the pointer
    const frame = $('frame').getBoundingClientRect();
    this.overlay.innerHTML = '';
    for (const o of OBJECTS) {
      if (!o.el) continue;
      const node = ED.view.$(o.el);
      if (!node || !node.offsetParent && getComputedStyle(node).position !== 'absolute') continue;
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') continue;
      const box = document.createElement('div');
      box.className = 'obox' + (o === this.sel ? ' sel' : '') + (o.drag ? ' draggable' : '');
      Object.assign(box.style, {
        left: (r.left - frame.left) + 'px', top: (r.top - frame.top) + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      box.title = o.label + (o.drag ? ' — drag to move' : '');
      box.onpointerdown = e => this._pointerDown(e, o, box);
      this.overlay.appendChild(box);
    }
  }

  _pointerDown(e, o, box) {
    // flag BEFORE select(): its overlay resync would destroy this box mid-gesture
    if (o.drag) this._dragging = true;
    this.select(o);
    if (!o.drag) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const frame = $('frame').getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: parseFloat(box.style.left), top: parseFloat(box.style.top) };
    let moved = false, zones = null, nearest = null;
    const mkZones = () => {
      zones = [];
      for (const [slot, [ax, ay]] of Object.entries(o.drag.slots)) {
        const z = document.createElement('div');
        z.className = 'oanchor';
        const w = Math.min(120, frame.width * 0.3), h = Math.min(120, frame.height * 0.22);
        Object.assign(z.style, {
          left: (ax ? frame.width - w - 6 : 6) + 'px',
          top: (ay ? frame.height - h - 6 : 6) + 'px',
          width: w + 'px', height: h + 'px',
        });
        z.dataset.slot = slot;
        this.overlay.appendChild(z);
        zones.push(z);
      }
    };
    box.onpointermove = ev => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!moved) { moved = true; box.classList.add('drag'); mkZones(); }
      box.style.left = (start.left + ev.clientX - start.x) + 'px';
      box.style.top = (start.top + ev.clientY - start.y) + 'px';
      const cx = ev.clientX - frame.left, cy = ev.clientY - frame.top;
      nearest = null; let bd = Infinity;
      for (const z of zones) {
        const zx = parseFloat(z.style.left) + parseFloat(z.style.width) / 2;
        const zy = parseFloat(z.style.top) + parseFloat(z.style.height) / 2;
        const d = Math.hypot(cx - zx, cy - zy);
        z.classList.toggle('near', false);
        if (d < bd) { bd = d; nearest = z; }
      }
      if (nearest) nearest.classList.add('near');
    };
    box.onpointerup = () => {
      box.onpointermove = box.onpointerup = null;
      this._dragging = false;
      if (moved && nearest) {
        setToken(o.drag.token, nearest.dataset.slot);
        this.buildDetail(); // the position seg in the panel follows the drop
      }
      this._syncOverlay();
    };
  }
}

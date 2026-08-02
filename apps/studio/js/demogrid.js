/* Multi-view demo grid (design: "one replay engine, N map instances").
   Each view is a full independent Nav render — own MapLibre instance, own
   auto-zoom (landscape frames differently than portrait, which is the point),
   own HUD scaled to its frame — fed by the one shared Replay engine.
   Per-view scheme dropdown makes it an A/B comparison rig: remix vs original,
   in motion. Powers the editor's Multi-view framing and the public #demo. */

import { NavView } from './navview.js';
import { validateScheme, resolveScheme } from './scheme.js';

const VPS = ['portrait', 'landscape', 'square'];

export class DemoGrid {
  /* opts: {
       engine, trk, heat,
       builtins: [{id,label,file}],
       current: () => scheme | null   — the scheme being edited (editor only)
       extra: { label, scheme } | null — a ?scheme= URL install (demo only)
       mode: () => 'day'|'night'
     } */
  constructor(container, opts) {
    this.opts = opts;
    this.views = [];
    this.el = document.createElement('div');
    this.el.className = 'dg';
    this.el.innerHTML = `
      <div class="dg-add"><span class="dg-lbl">Add view</span>
        ${VPS.map(v => `<button data-vp="${v}">+ ${v}</button>`).join('')}
      </div>
      <div class="dg-grid"></div>`;
    container.appendChild(this.el);
    this.gridEl = this.el.querySelector('.dg-grid');
    this.el.querySelector('.dg-add').onclick = e => {
      if (e.target.dataset.vp) this.addView(e.target.dataset.vp).catch(console.error);
    };
    this._schemeCache = new Map(); // builtin id → validated scheme
  }

  _defaultSel() {
    return this.opts.current ? 'current' : this.opts.extra ? 'extra' : 'builtin:default';
  }
  _options() {
    const o = [];
    if (this.opts.current) o.push(['current', 'Editing now']);
    if (this.opts.extra) o.push(['extra', this.opts.extra.label]);
    for (const b of this.opts.builtins) o.push(['builtin:' + b.id, b.label]);
    return o;
  }
  async _resolve(sel) {
    const mode = this.opts.mode ? this.opts.mode() : 'day';
    if (sel === 'current' && this.opts.current) return resolveScheme(this.opts.current(), mode);
    if (sel === 'extra' && this.opts.extra) return resolveScheme(this.opts.extra.scheme, mode);
    if (sel.startsWith('builtin:')) {
      const id = sel.slice(8);
      if (!this._schemeCache.has(id)) {
        const b = this.opts.builtins.find(x => x.id === id);
        this._schemeCache.set(id, validateScheme(await (await fetch('schemes/' + b.file)).json()));
      }
      return resolveScheme(this._schemeCache.get(id), mode);
    }
    throw new Error('unknown scheme selector ' + sel);
  }

  async addView(vp = 'portrait', sel = this._defaultSel()) {
    const panel = document.createElement('div');
    panel.className = 'dgv';
    panel.dataset.vp = vp;
    panel.innerHTML = `
      <div class="dgv-bar">
        <select class="dgv-scheme">${this._options().map(([v, l]) =>
          `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <span class="dgv-vp">${vp}</span>
        <button class="dgv-x" title="Remove view">✕</button>
      </div>
      <div class="dgv-frame"></div>`;
    this.gridEl.appendChild(panel);
    const view = { panel, sel, vp, nav: null, unsub: null };
    this.views.push(view);
    const nav = new NavView(panel.querySelector('.dgv-frame'), { scheme: await this._resolve(sel), orient: 'course' });
    view.nav = nav;
    await nav.init();
    nav.setData({ trk: this.opts.trk, heat: this.opts.heat });
    nav.fitTrack();
    view.unsub = this.opts.engine.addSink((...a) => nav.onFix(...a));
    if (this.opts.engine.playing || this._navving) nav.startNav();
    panel.querySelector('.dgv-x').onclick = () => this.removeView(view);
    panel.querySelector('.dgv-scheme').onchange = async e => {
      view.sel = e.target.value;
      nav.setScheme(await this._resolve(view.sel)).catch(console.error);
    };
    return view;
  }

  removeView(view) {
    const i = this.views.indexOf(view);
    if (i < 0) return;
    this.views.splice(i, 1);
    if (view.unsub) view.unsub();
    view.nav.destroy();
    view.panel.remove();
  }

  /* live edits: re-apply to views tracking the edited scheme */
  async refreshCurrent() {
    for (const v of this.views) if (v.sel === 'current')
      v.nav.setScheme(await this._resolve('current')).catch(console.error);
  }
  /* day/night flip: every view re-resolves */
  async refreshAll() {
    for (const v of this.views)
      v.nav.setScheme(await this._resolve(v.sel)).catch(console.error);
  }

  startNavAll() {
    this._navving = true;
    for (const v of this.views) if (v.nav.ready && !v.nav.navving) { v.nav.clearTrail(); v.nav.startNav(); }
  }
  stopNavAll() {
    this._navving = false;
    for (const v of this.views) if (v.nav.navving) v.nav.stopNav();
  }
  destroy() {
    for (const v of [...this.views]) this.removeView(v);
    this.el.remove();
  }
}

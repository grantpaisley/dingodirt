/* Playback bar wiring — one Replay engine driving the #bottom controls.
   Shared by the editor's test-drive and the #demo page; the surfaces differ
   only in what happens on play start and on finish. */

import { SOUND, unlockAudio } from './navview.js';

const $ = id => document.getElementById(id);
const fmtKm = m => (m / 1000).toFixed(1) + ' km';

export function wirePlayback(engine, { beforePlay, onFinish } = {}) {
  engine.onState = () => {
    $('playBtn').innerHTML = `<svg class="ic"><use href="#i-${engine.playing ? 'pause' : 'play'}"/></svg>`;
    const sc = $('scrub');
    if (engine.trk) { sc.max = Math.round(engine.trk.lengthM); if (!sc._drag) sc.value = Math.round(engine.d); }
    $('scrubLbl').textContent = engine.trk ? fmtKm(engine.d) + ' / ' + fmtKm(engine.trk.lengthM) : '—';
    if (engine.finished && onFinish) onFinish();
  };
  $('playBtn').onclick = () => {
    unlockAudio();
    if (!engine.playing && beforePlay) beforePlay();
    engine.toggle();
  };
  const sc = $('scrub');
  sc.oninput = () => { sc._drag = true; engine.seek(parseFloat(sc.value)); };
  sc.onchange = () => { sc._drag = false; };
  $('rate').onchange = () => engine.setRate(parseFloat($('rate').value));
  $('offBtn').onclick = () => { if (engine.playing) engine.simulateOffTrack(5); else if (window.__toast) window.__toast('Press play first'); };
  $('muteBtn').onclick = () => {
    SOUND.on = !SOUND.on;
    $('muteBtn').innerHTML = `<svg class="ic"><use href="#i-volume-${SOUND.on ? '2' : 'x'}"/></svg>`;
    $('muteBtn').classList.toggle('off', !SOUND.on);
  };
}

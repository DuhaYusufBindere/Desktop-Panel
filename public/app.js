'use strict';
/* =====================================================================
   Masa Paneli — telefon tarafı
   ===================================================================== */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const q = new URLSearchParams(location.search);
const vibrate = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

/* ---------- ayarlar ---------- */
const ALL_PAGES = ['panel', 'hw', 'media', 'focus', 'day', 'tools'];
const S = Object.assign({ geo: 'server', geoPos: null, theme: 'auto', order: ALL_PAGES.slice(), hidden: [], bright: 100, ambient: false, lite: false, wake: false, tts: true, saver: 5, pcs: [], cur: 0 }, store.get('cfg', {}));
S.order = S.order.filter(id => ALL_PAGES.includes(id)).concat(ALL_PAGES.filter(id => !S.order.includes(id)));
const save = () => store.set('cfg', S);
if (S.liteChosen == null) {
  const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3;
  S.lite = weak;
}

/* ---------- bilgisayarlar ve istekler ---------- */
const pcList = () => [{ name: 'Bu bilgisayar', base: '', key: '' }, ...S.pcs];
const curPC = () => pcList()[S.cur] || pcList()[0];
function ep(path) { const pc = curPC(), sep = path.includes('?') ? '&' : '?'; return (pc.base || '') + path + (pc.key ? sep + 'k=' + encodeURIComponent(pc.key) : ''); }
const post = (path, obj) => fetch(ep(path), { method: 'POST', headers: obj ? { 'Content-Type': 'application/json' } : {}, body: obj ? JSON.stringify(obj) : undefined });

/* ---------- tema, renk, parlaklık ---------- */
const colors = {};
const cssv = n => getComputedStyle(document.body).getPropertyValue(n).trim();
function readColors() { for (const n of ['accent', 'accent2', 'hot', 'sage', 'ink', 'faint', 'dim', 'bg', 'a3']) colors[n] = cssv('--' + n); }
let sun = null;
const autoTheme = () => { const now = Date.now(), h = new Date().getHours(); return (sun ? now > sun.rise && now < sun.set : h >= 7 && h < 19) ? 'ice' : 'amber'; };
function applyTheme() {
  const t = S.theme === 'auto' ? autoTheme() : S.theme;
  if (document.body.dataset.theme !== t) {
    document.body.dataset.theme = t;
    document.querySelector('meta[name=theme-color]').content = { amber: '#09080a', ice: '#060a10', paper: '#efe9de' }[t];
  }
  document.body.classList.toggle('lite', !!S.lite);
  readColors();
}
setInterval(() => { if (S.theme === 'auto') applyTheme(); }, 60000);
let ambient = 1, lightSensor = null;
function applyBright() {
  const h = new Date().getHours(), night = h >= 23 || h < 7;
  document.body.style.opacity = Math.max(.12, (S.bright / 100) * (night ? .6 : 1) * (S.ambient ? ambient : 1));
}
setInterval(applyBright, 60000);
function setupAmbient() {
  if (lightSensor) { try { lightSensor.stop(); } catch {} lightSensor = null; }
  ambient = 1; if (!S.ambient) return applyBright();
  try {
    lightSensor = new AmbientLightSensor({ frequency: 1 });
    lightSensor.onreading = () => { ambient = Math.min(1, Math.max(.4, .4 + lightSensor.illuminance / 80)); applyBright(); };
    lightSensor.onerror = () => { lightSensor = null; };
    lightSensor.start();
  } catch {}
  applyBright();
}

/* ---------- küçük yardımcılar ---------- */
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), 2400); }
let bannerT;
function banner(n) {
  $('bnT').textContent = n.title; $('bnB').textContent = n.body || '';
  const b = $('banner'); b.classList.toggle('warn', n.level === 'warn'); b.classList.add('show');
  clearTimeout(bannerT); bannerT = setTimeout(() => b.classList.remove('show'), 6000);
  vibrate(n.level === 'warn' ? [120, 60, 120] : 40);
}
$('banner').onclick = () => $('banner').classList.remove('show');
function fire(el) { el.classList.remove('fire'); void el.offsetWidth; el.classList.add('fire'); }
// sayıları yumuşakça değiştir
function tween(el, to, fmt, dur = 700) {
  if (S.lite) { el._tv = to; const h = fmt(to == null || isNaN(to) ? null : to); if (el.innerHTML !== h) el.innerHTML = h; return; }
  if (to == null || isNaN(to)) { el._tv = null; el.innerHTML = fmt(null); return; }
  const from = el._tv == null ? to : el._tv; el._tv = to;
  const t0 = performance.now(); cancelAnimationFrame(el._raf);
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.innerHTML = fmt(from + (to - from) * e); if (k < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}
const ring = (el, pct) => { if (el) el.style.strokeDashoffset = 94.25 * (1 - Math.max(0, Math.min(100, pct || 0)) / 100); };

/* =====================================================================
   SAAT
   ===================================================================== */
let saverOn = false, lastTouch = Date.now();
function makeDigit() {
  const d = document.createElement('div'); d.className = 'd';
  const s = document.createElement('div'); s.className = 'strip';
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) { const x = document.createElement('span'); x.textContent = n; s.appendChild(x); }
  d.appendChild(s); d._s = s; d._v = null; return d;
}
// Şerit: 0 1 2 … 9 0  (10. konum yine 0). Her zaman bir adım kayar; büyük sıçramalarda dönmeden yerine oturur.
function setDigit(d, v) {
  if (d._v === v) return;
  const s = d._s, from = d._v; d._v = v;
  clearTimeout(d._snap);
  if (from === 0 && /-10em/.test(s.style.transform)) { s.style.transition = 'none'; s.style.transform = 'translateY(0em)'; void s.offsetHeight; }
  const put = (pos, anim) => { s.style.transition = anim ? '' : 'none'; s.style.transform = `translateY(${-pos}em)`; if (!anim) void s.offsetHeight; };
  const settle = () => { d._snap = setTimeout(() => put(d._v, false), 820); };
  if (from === null || document.hidden || saverOn) return put(v, false);
  if (v === from + 1) return put(v, true);                                  // ileri bir adım
  if (v === from - 1) return put(v, true);                                  // geri sayım bir adım
  if (v === 0) { put(9, false); put(10, true); return settle(); }             // 9→0, 5→0, 2→0: yukarı kayıp 0'a otur
  if (from === 0 && v === 9) { put(10, false); put(9, true); return; }      // geri sayımda 0→9
  put(v - 1, false); put(v, true);                                          // diğer sıçramalar: tek adımlık kayma
}
const colon = () => { const c = document.createElement('div'); c.className = 'colon'; c.innerHTML = '<i></i><i></i>'; return c; };
const dg = [makeDigit(), makeDigit(), makeDigit(), makeDigit()];
const secEl = document.createElement('div'); secEl.className = 'sec';
$('clock').append(dg[0], dg[1], colon(), dg[2], dg[3], secEl);
const GUN = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
function tick() {
  const n = new Date(), h = n.getHours(), m = n.getMinutes(), s = n.getSeconds();
  setDigit(dg[0], Math.floor(h / 10)); setDigit(dg[1], h % 10); setDigit(dg[2], Math.floor(m / 10)); setDigit(dg[3], m % 10);
  secEl.textContent = pad2(s);
  const mb = $('minbar');
  if (s === 0) { mb.style.transition = 'none'; mb.style.transform = 'scaleX(0)'; void mb.offsetWidth; mb.style.transition = ''; } else mb.style.transform = `scaleX(${(s / 59).toFixed(4)})`;
  const ds = `<b>${GUN[n.getDay()]}</b> &nbsp;·&nbsp; ${n.getDate()} ${AY[n.getMonth()]}`;
  if (ds !== tick.ds) { tick.ds = ds; $('date').innerHTML = ds; }
  if (saverOn) $('svT').textContent = pad2(h) + ':' + pad2(m);
}
tick(); setInterval(tick, 1000);
setInterval(() => { const r = () => Math.round(Math.random() * 8 - 4); document.querySelector('.hero').style.transform = `translate(${r()}px,${r()}px)`; }, 60000);

/* =====================================================================
   HAVA DURUMU
   ===================================================================== */
const WMO = c => c === 0 ? 'Açık' : c <= 2 ? 'Parçalı bulutlu' : c === 3 ? 'Kapalı' : c <= 48 ? 'Sisli' : c <= 57 ? 'Çiseleme' : c <= 67 ? 'Yağmurlu' : c <= 77 ? 'Karlı' : c <= 82 ? 'Sağanak' : c <= 86 ? 'Kar sağanağı' : 'Gök gürültülü';
function wxIcon(c, day) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="32" y1="8" x2="32" y2="13" transform="rotate(${a} 32 32)"/>`).join('');
  const sunG = (x = 0, y = 0, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><g class="rays">${rays}</g><circle class="core" cx="32" cy="32" r="11"/></g>`;
  const moon = (x = 0, y = 0, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><path class="moon" d="M38 13a19 19 0 1 0 13 30A16 16 0 0 1 38 13z"/></g>`;
  const cloud = (x = 0, y = 0, s = 1, back) => `<g class="cl${back ? ' back' : ''}"><path transform="translate(${x} ${y}) scale(${s})" d="M19 48h28a11 11 0 0 0 1-22 15 15 0 0 0-29-3A11 11 0 0 0 19 48z"/></g>`;
  const drops = [18, 30, 42].map((x, i) => `<line class="drop" style="animation-delay:${i * .35}s" x1="${x}" y1="52" x2="${x - 2}" y2="58"/>`).join('');
  const flakes = [20, 32, 44].map((x, i) => `<circle class="flake" style="animation-delay:${i * .8}s" cx="${x}" cy="54" r="2"/>`).join('');
  let g;
  if (c === 0) g = day ? sunG() : moon();
  else if (c <= 2) g = (day ? sunG(10, -8, .75) : moon(10, -6, .7)) + cloud(0, 4, .95);
  else if (c === 3) g = cloud(10, -8, .8, 1) + cloud(-2, 2);
  else if (c <= 48) g = cloud(0, -6) + '<g class="fog"><line x1="12" y1="50" x2="44" y2="50"/><line x1="20" y1="57" x2="52" y2="57"/></g>';
  else if (c <= 67 || (c >= 80 && c <= 82)) g = cloud(0, -6) + drops;
  else if (c <= 77 || c === 85 || c === 86) g = cloud(0, -6) + flakes;
  else g = cloud(0, -6) + '<path class="bolt" d="M34 40l-8 12h7l-3 10 10-14h-7l4-8z"/>' + drops;
  return `<svg viewBox="0 0 64 64">${g}</svg>`;
}
let server = { lat: 41.01, lon: 28.97, city: '', hasCal: false, actions: [], host: '' };
let wxNow = null;
const geoFresh = () => S.geo === 'phone' && S.geoPos && Date.now() - S.geoPos.at < 24 * 3600e3;
function updateGeo(manual) {
  if (S.geo !== 'phone') return Promise.resolve();
  if (!navigator.geolocation) { if (manual) toast('Bu tarayıcı konum vermiyor (güvenli bağlantı gerekli)'); return Promise.resolve(); }
  return new Promise(res => navigator.geolocation.getCurrentPosition(p => {
    S.geoPos = { lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3), at: Date.now() }; save();
    if (manual) toast('Konum alındı'); weather(); renderSettings(); res();
  }, err => { if (manual) toast(err.code === 1 ? 'Konum izni reddedildi' : 'Konum alınamadı'); S.geoErr = err.code; renderSettings(); res(); },
  { enableHighAccuracy: false, timeout: 15000, maximumAge: 30 * 60e3 }));
}
async function weather() {
  const usePhone = geoFresh();
  const lat = q.get('lat') || (usePhone ? S.geoPos.lat : server.lat), lon = q.get('lon') || (usePhone ? S.geoPos.lon : server.lon);
  const city = usePhone ? '' : server.city;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day,apparent_temperature&daily=sunrise,sunset&forecast_days=1&timezone=auto`);
    const j = await r.json(), c = j.current;
    wxNow = { t: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), c: WMO(c.weather_code), city };
    tween($('wxT'), c.temperature_2m, v => Math.round(v) + '°', 900);
    $('wxC').textContent = wxNow.c + (city ? ' · ' + city : usePhone ? ' · telefon konumu' : '');
    $('wxIcon').innerHTML = wxIcon(c.weather_code, !!c.is_day);
    sun = { rise: new Date(j.daily.sunrise[0]).getTime(), set: new Date(j.daily.sunset[0]).getTime() };
    applyTheme();
  } catch { $('wxC').textContent = 'Hava durumu alınamadı'; }
}

/* =====================================================================
   ÇİZİMLER
   ===================================================================== */
function fit(c) { const r = c.getBoundingClientRect(), p = Math.min(devicePixelRatio || 1, S.lite ? 1.25 : 2); c.width = Math.max(1, r.width * p); c.height = Math.max(1, r.height * p); c._p = p; return c.getContext('2d'); }
const gc = { cpu: $('gCpu'), mem: $('gMem') }, gx = {};
const target = { cpu: 0, mem: 0 }, shown = { cpu: 0, mem: 0 };
const drawn = { cpu: -1, mem: -1 }, numShown = { cpu: -1, mem: -1 };
const A0 = Math.PI * .75, SWEEP = Math.PI * 1.5;
function drawGauge(k, v) {
  const c = gc[k], x = gx[k]; if (!x) return;
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = Math.min(w, h) * .36, p = c._p, lw = R * .12;
  x.clearRect(0, 0, w, h);
  for (let i = 0; i <= 36; i++) {
    const a = A0 + SWEEP * i / 36, on = i / 36 <= v / 100, r0 = R + lw * 1.2, len = i % 6 === 0 ? lw * .9 : lw * .45;
    x.strokeStyle = on ? colors.ink : colors.faint; x.globalAlpha = on ? .45 : .9; x.lineWidth = 1.1 * p;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); x.stroke();
  }
  x.globalAlpha = 1; x.lineCap = 'round'; x.lineWidth = lw;
  x.strokeStyle = colors.faint; x.beginPath(); x.arc(cx, cy, R, A0, A0 + SWEEP); x.stroke();
  if (v > .5) {
    const end = A0 + SWEEP * v / 100, c1 = k === 'cpu' ? colors.accent2 : colors.sage, c2 = v > 85 ? colors.hot : colors.accent;
    let st = c2;
    if (x.createConicGradient) { st = x.createConicGradient(A0 - .15, cx, cy); st.addColorStop(0, c1); st.addColorStop(Math.min(1, .75 * v / 100 + .03), c2); st.addColorStop(1, c2); }
    x.strokeStyle = st; x.shadowColor = c2; x.shadowBlur = lw * 1.6;
    x.beginPath(); x.arc(cx, cy, R, A0, end); x.stroke(); x.shadowBlur = 0;
    x.fillStyle = colors.ink; x.shadowColor = c2; x.shadowBlur = lw * 1.4;
    x.beginPath(); x.arc(cx + Math.cos(end) * R, cy + Math.sin(end) * R, lw * .34, 0, 7); x.fill(); x.shadowBlur = 0;
  }
}
class Spark {
  constructor(id, c1, c2, fixedMax) { this.c = $(id); this.c1 = c1; this.c2 = c2; this.fixed = fixedMax; this.span = 60000; this.h = []; }
  resize() { this.x = fit(this.c); }
  push(v) { this.h.push({ t: performance.now(), v }); }
  draw(now) {
    const x = this.x, c = this.c; if (!x) return;
    const w = c.width, h = c.height, p = c._p, span = this.span, c1 = colors[this.c1], c2 = colors[this.c2];
    x.clearRect(0, 0, w, h);
    this.h = this.h.filter(pt => now - pt.t < span + 2000);
    if (this.h.length < 2) return;
    const max = this.fixed || Math.max(100e3, ...this.h.map(pt => pt.v)) * 1.2;
    const pts = this.h.map(pt => [w - (now - pt.t) / span * w, h - (pt.v / max) * (h * .82) - h * .06]);
    const path = () => { x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) { const m = (pts[i - 1][0] + pts[i][0]) / 2; x.bezierCurveTo(m, pts[i - 1][1], m, pts[i][1], pts[i][0], pts[i][1]); } };
    path(); x.lineTo(pts[pts.length - 1][0], h); x.lineTo(pts[0][0], h); x.closePath();
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, c2 + '55'); g.addColorStop(1, c2 + '00'); x.fillStyle = g; x.fill();
    const s = x.createLinearGradient(0, 0, w, 0); s.addColorStop(0, c1 + '00'); s.addColorStop(.35, c1); s.addColorStop(1, c2);
    x.lineJoin = 'round';
    if (!S.lite) { path(); x.strokeStyle = s; x.globalAlpha = .18; x.lineWidth = 6 * p; x.stroke(); x.globalAlpha = 1; }
    path(); x.strokeStyle = s; x.lineWidth = 2 * p; x.stroke();
    const [lx, ly] = pts[pts.length - 1], ph = (now % 1600) / 1600;
    x.fillStyle = c2; x.globalAlpha = 1 - ph; x.beginPath(); x.arc(Math.min(lx, w - 4 * p), ly, (3 + 7 * ph) * p, 0, 7); x.fill();
    x.globalAlpha = 1; x.fillStyle = colors.ink; x.beginPath(); x.arc(Math.min(lx, w - 4 * p), ly, 2.6 * p, 0, 7); x.fill();
  }
}
const spCpu = new Spark('spark', 'accent2', 'accent', 100), spDown = new Spark('sDown', 'accent2', 'accent', 0), spUp = new Spark('sUp', 'sage', 'sage', 0);
function setupCanvases() { drawn.cpu = drawn.mem = -1; for (const k in gc) gx[k] = fit(gc[k]); [spCpu, spDown, spUp].forEach(s => s.resize()); }
addEventListener('resize', () => { setupCanvases(); moveInd(); });

/* =====================================================================
   BAĞLANTI VE VERİ
   ===================================================================== */
const fmtB = b => b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + ' GB';
const fmtUp = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}g ${h}s` : `${h}s ${m}dk`; };
const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + pad2(s % 60); };
const fmtNet = b => b >= 1e6 ? [(b / 1e6).toFixed(b >= 1e7 ? 1 : 2), 'MB/s'] : [Math.round(b / 1024), 'KB/s'];

let es = null, lastMsg = 0, cal = [], todos = [], notes = [], media = null, heat = 0;
function resetData() {
  cal = []; todos = []; notes = []; media = null; server.hasCal = false; server.actions = [];
  renderCal(); renderTodos(); renderNotes(); renderActs(); renderMedia(); updateStatus();
}
function connect() {
  if (es) es.close();
  resetData(); lastMsg = 0;
  es = new EventSource(ep('/events'));
  es.onopen = () => $('status').classList.add('on');
  es.onerror = () => $('status').classList.remove('on');
  es.onmessage = e => { lastMsg = Date.now(); onStats(JSON.parse(e.data)); };
  es.addEventListener('hello', e => {
    lastMsg = Date.now(); Object.assign(server, JSON.parse(e.data));
    const pc = curPC(); if (pc.base && pc.name !== server.host) { pc.name = server.host; save(); renderSettings(); }
    updateStatus(); renderActs(); renderCal(); weather();
    window.Jarvis && Jarvis.voiceStatus(server.voice);
  });
  es.addEventListener('voice', e => { server.voice = JSON.parse(e.data); window.Jarvis && Jarvis.voiceStatus(server.voice); });
  es.addEventListener('todos', e => { todos = JSON.parse(e.data); renderTodos(); });
  es.addEventListener('cal', e => { cal = JSON.parse(e.data); renderCal(); });
  es.addEventListener('media', e => onMedia(JSON.parse(e.data)));
  es.addEventListener('notes', e => { notes = JSON.parse(e.data); renderNotes(); });
  es.addEventListener('notify', e => { const n = JSON.parse(e.data); notes.unshift(n); notes.length = Math.min(notes.length, 12); renderNotes(); banner(n); });
}
function updateStatus() { const n = pcList().length; $('stxt').textContent = (server.host || curPC().name || 'bağlanıyor').toLowerCase() + (n > 1 ? ` · ${S.cur + 1}/${n}` : ''); }
$('status').onclick = () => { const n = pcList().length; if (n < 2) return toast('Başka bilgisayar eklemek için ayarlara bak'); S.cur = (S.cur + 1) % n; save(); toast(pcList()[S.cur].name); server.host = ''; connect(); };

function onStats(d) {
  target.cpu = d.cpu; target.mem = d.mem.used / d.mem.total * 100;
  heat += (d.cpu / 100 - heat) * .2; if (!S.lite) $('bg').style.setProperty('--heat', heat.toFixed(2));
  spCpu.push(d.cpu);
  server.host = d.host; updateStatus();
  $('memS').textContent = fmtB(d.mem.used);
  if (d.disk) { const pct = d.disk.used / d.disk.total * 100; ring($('diskRing'), pct); $('diskT').textContent = Math.round(pct) + '%'; }
  $('upT').textContent = fmtUp(d.uptime);
  if (d.net) {
    spDown.push(d.net.down); spUp.push(d.net.up);
    tween($('nDown'), d.net.down, v => { const [a, u] = fmtNet(v); return `${a}<small>${u}</small>`; });
    tween($('nUp'), d.net.up, v => { const [a, u] = fmtNet(v); return `${a}<small>${u}</small>`; });
    $('netT').textContent = fmtNet(d.net.down).join(' ');
  }
  hwTiles(d.hw || {});
}
function tile(id, val, unit, pct, sub, hot) {
  const t = $(id), na = val == null;
  t.classList.toggle('na', na); t.classList.toggle('hot', !!hot);
  tween(t.querySelector('b'), na ? null : val, v => v == null ? '—' : `${Math.round(v)}<i>${unit}</i>`);
  ring(t.querySelector('.fg'), na ? 0 : pct);
  t.querySelector('small').textContent = sub || '';
}
function hwTiles(h) {
  tile('tGl', h.load, '%', h.load, [h.name && h.name.replace(/NVIDIA GeForce |Laptop GPU|AMD Radeon /g, '').trim(), h.vram ? fmtB(h.vram) : ''].filter(Boolean).join(' · '), h.load > 90);
  tile('tGt', h.temp, '°C', h.temp, h.temp == null ? 'sensör yok' : 'çekirdek', h.temp > 85);
  tile('tCt', h.cpuTemp, '°C', h.cpuTemp, h.cpuPower != null ? Math.round(h.cpuPower) + ' W' : 'LHM gerekli', h.cpuTemp > 90);
  const fan = h.fan != null ? h.fan : h.fanPct;
  tile('tFn', fan, h.fan != null ? 'rpm' : '%', h.fan != null ? h.fan / 40 : h.fanPct, fan == null ? 'LHM gerekli' : '', false);
  $('hwHint').textContent = !h.lhm && h.cpuTemp == null ? 'CPU sıcaklığı ve fan için: LibreHardwareMonitor → Options → Remote Web Server → Run' : '';
}
setInterval(() => {
  $('wait').classList.toggle('show', Date.now() - lastMsg > 4500);
  $('waitTxt').textContent = (server.host || curPC().name) + ' bekleniyor';
}, 1000);

/* =====================================================================
   ÇALAN MEDYA
   ===================================================================== */
const ICON_PLAY = '<path d="M7 4.5v15l12-7.5z"/>', ICON_PAUSE = '<path d="M6 4.5h4.2v15H6zM13.8 4.5H18v15h-4.2z"/>';
let mAt = 0;
function onMedia(m) {
  if (m.none) media = null; else { media = Object.assign(media || {}, m); mAt = Date.now(); }
  renderMedia(m.thumb);
}
function renderMedia(thumb) {
  const on = !!media, playing = on && media.status === 'Playing';
  const t = $('npTitle'), nt = on ? (media.title || 'Bilinmeyen') : 'Çalan bir şey yok';
  if (t.textContent !== nt) { t.textContent = nt; t.animate?.([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
  $('npArtist').innerHTML = on ? esc(media.artist || media.album || '') || '&nbsp;' : '&nbsp;';
  $('npApp').textContent = on && media.app ? media.app.replace(/\.exe$/i, '').split(/[!.]/).filter(Boolean).pop() : 'Bilgisayar';
  $('ppIcon').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('art').classList.toggle('play', playing); $('eq').classList.toggle('on', playing);
  if (thumb !== undefined) setArt(thumb);
  if (!on) setArt(null);
  $('svN').textContent = playing && media.title ? media.title + (media.artist ? ' — ' + media.artist : '') : '';
}
let artSrc = null;
function setArt(src) {
  const img = $('artImg'), bg = $('artBg'), page = document.querySelector('.p-media');
  if (src === artSrc) return; artSrc = src;
  if (!src) { img.classList.remove('on'); bg.classList.remove('on'); page.style.removeProperty('--np'); return; }
  img.classList.remove('on');
  img.onload = () => { img.classList.add('on'); try { page.style.setProperty('--np', accentFrom(img)); } catch {} };
  bg.onload = () => bg.classList.add('on');
  img.src = src; bg.src = src;
}
function accentFrom(img) {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 16, 16);
  const d = x.getImageData(0, 0, 16, 16).data; let best = null, bs = -1;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    const sc = sat * .75 + (mx / 255) * .25; if (mx > 60 && sc > bs) { bs = sc; best = [r, g, b]; }
  }
  if (!best || bs < .25) return colors.accent;
  const k = 200 / Math.max(...best), f = k > 1 ? k : 1;
  return `rgb(${best.map(v => Math.min(255, Math.round(v * f))).join(',')})`;
}
function mediaProgress() {
  if (!media || !media.dur) { $('npBar').style.transform = 'translateX(-100%)'; $('npPos').textContent = '0:00'; $('npDur').textContent = '0:00'; return; }
  const pos = Math.min(media.dur, (media.pos || 0) + (media.status === 'Playing' ? (Date.now() - mAt) / 1000 : 0));
  $('npBar').style.transform = `translateX(${(pos / media.dur * 100 - 100).toFixed(2)}%)`;
  const a = fmtT(pos), b = fmtT(media.dur); if ($('npPos').textContent !== a) $('npPos').textContent = a; if ($('npDur').textContent !== b) $('npDur').textContent = b;
}
async function sendKey(k) { try { const r = await post('/api/key/' + k); if (!r.ok) toast('Bu tuş yalnızca Windows\'ta çalışır'); return r.ok; } catch { toast('Bilgisayara ulaşılamadı'); return false; } }
const keyAt = {};
document.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.k, now = Date.now();
  if (now - (keyAt[k] || 0) < 450) return;            // titrek çift dokunuş müziği iki kez değiştirmesin
  keyAt[k] = now; fire(b); vibrate(12);
  if (k === 'playpause' && media) {                    // simgeyi beklemeden çevir; bilgisayardan gelen durum sonra düzeltir
    const pos = (media.pos || 0) + (media.status === 'Playing' ? (now - mAt) / 1000 : 0);
    media.pos = pos; mAt = now; media.status = media.status === 'Playing' ? 'Paused' : 'Playing'; renderMedia();
  }
  sendKey(k);
}));

/* =====================================================================
   ODAK (POMODORO)
   ===================================================================== */
const CIRC = 2 * Math.PI * 80; $('pr').style.strokeDasharray = CIRC;
const P = { len: 25 * 60, left: 25 * 60, run: false, end: 0, rest: false };
const pd = [makeDigit(), makeDigit(), makeDigit(), makeDigit()];
$('pt').append(pd[0], pd[1], colon(), pd[2], pd[3]);
const ticksG = $('ticks'), TICKS = [];
for (let i = 0; i < 60; i++) {
  const a = (i / 60) * Math.PI * 2, r0 = 90, r1 = i % 5 === 0 ? 97 : 94;
  const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l.setAttribute('x1', 100 + Math.cos(a) * r0); l.setAttribute('y1', 100 + Math.sin(a) * r0);
  l.setAttribute('x2', 100 + Math.cos(a) * r1); l.setAttribute('y2', 100 + Math.sin(a) * r1);
  ticksG.appendChild(l); TICKS.push(l);
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const focusLog = () => store.get('focus', {});
function renderP() {
  const s = Math.max(0, Math.ceil(P.left)), mm = Math.floor(s / 60), ss = s % 60;
  setDigit(pd[0], Math.floor(mm / 10)); setDigit(pd[1], mm % 10); setDigit(pd[2], Math.floor(ss / 10)); setDigit(pd[3], ss % 10);
  const frac = 1 - P.left / P.len;
  $('pr').style.strokeDashoffset = CIRC * frac;
  const on = Math.round((1 - frac) * 60); TICKS.forEach((l, i) => l.classList.toggle('on', i < on));
  $('pl').textContent = P.rest ? 'Mola' : P.run ? 'Odaklan' : 'Odak';
  $('ring').classList.toggle('rest', P.rest); $('ring').classList.toggle('run', P.run);
  $('pgo').textContent = P.run ? 'Duraklat' : 'Başlat';
  document.title = P.run ? pad2(mm) + ':' + pad2(ss) + ' · Masa Paneli' : 'Masa Paneli';
}
function renderWeek() {
  const log = focusLog(), el = $('week'); el.innerHTML = '';
  const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const max = Math.max(60, ...days.map(d => log[dayKey(d)] || 0));
  days.forEach((d, i) => {
    const m = log[dayKey(d)] || 0, c = document.createElement('div'); if (i === 6) c.className = 'today';
    c.innerHTML = `<i title="${m} dk"></i>${GUN[d.getDay()].slice(0, 2)}`; el.appendChild(c);
    const bar = c.querySelector('i'); setTimeout(() => { bar.style.height = Math.max(4, m / max * 100) + '%'; }, 120 + i * 60);
  });
  $('pm').textContent = log[dayKey()] || 0; $('pc').textContent = store.get('rounds-' + dayKey(), 0);
}
function beep() { try { const a = new AudioContext();[0, .25, .5].forEach(t => { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = t ? 880 : 660; o.connect(g); g.connect(a.destination); g.gain.setValueAtTime(.0001, a.currentTime + t); g.gain.exponentialRampToValueAtTime(.3, a.currentTime + t + .02); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + t + .22); o.start(a.currentTime + t); o.stop(a.currentTime + t + .25); }); } catch {} }
setInterval(() => {
  if (!P.run) return;
  P.left = (P.end - Date.now()) / 1000;
  if (P.left <= 0) {
    P.run = false; P.left = 0; beep(); vibrate([200, 100, 200]);
    $('ring').classList.add('done'); setTimeout(() => $('ring').classList.remove('done'), 3200);
    if (!P.rest) { const log = focusLog(); log[dayKey()] = (log[dayKey()] || 0) + Math.round(P.len / 60); store.set('focus', log); store.set('rounds-' + dayKey(), store.get('rounds-' + dayKey(), 0) + 1); renderWeek(); }
    toast(P.rest ? 'Mola bitti' : 'Tur tamam');
  }
  renderP();
}, 250);
function focusStart() { if (P.run) return; if (P.left <= 0) P.left = P.len; P.end = Date.now() + P.left * 1000; P.run = true; renderP(); }
function focusStop() { P.run = false; renderP(); }
$('pgo').onclick = () => { fire($('pgo')); P.run ? focusStop() : focusStart(); };
$('prs').onclick = () => { fire($('prs')); P.run = false; P.left = P.len; renderP(); };
$('seg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  [...$('seg').children].forEach(x => x.classList.toggle('on', x === b));
  const m = +b.dataset.m; P.len = P.left = m * 60; P.run = false; P.rest = m !== 25; renderP();
};
renderP(); renderWeek();

/* =====================================================================
   GÜN: TAKVİM + YAPILACAKLAR
   ===================================================================== */
const seen = new Set();
function dayLabel(ms) {
  const d = new Date(ms), t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 864e5);
  return diff === 0 ? 'Bugün' : diff === 1 ? 'Yarın' : `${GUN[d.getDay()]} · ${d.getDate()} ${AY[d.getMonth()]}`;
}
const hm = ms => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
function untilText(e, now = Date.now()) {
  if (e.allDay) return '';
  if (e.start <= now && e.end > now) return 'şimdi';
  const mins = Math.round((e.start - now) / 60000);
  return mins < 60 ? mins + ' dk' : mins < 720 ? Math.floor(mins / 60) + ' sa' + (mins % 60 ? ' ' + (mins % 60) + ' dk' : '') : '';
}
function renderCal() {
  const el = $('events'), now = Date.now(); el.innerHTML = '';
  const list = cal.filter(e => e.end > now);
  $('calSub').textContent = list.length ? list.length + ' etkinlik' : '';
  if (!list.length) {
    el.innerHTML = server.hasCal || cal.length ? '<div class="empty">Önümüzdeki günlerde etkinlik yok. “Hey Jarvis, yarın 15’te toplantı ekle” diyebilirsin.</div>'
      : '<div class="empty">Google takvimi bağlı değil, ama Jarvis ile panele etkinlik ekleyebilirsin. Google için <code>config.json</code> içine <code>"icsUrl"</code> yaz.</div>';
    renderNext(); return;
  }
  let last = '', i = 0;
  for (const e of list) {
    const lab = dayLabel(e.start);
    if (lab !== last) { last = lab; const h = document.createElement('div'); h.className = 'dayhead'; h.textContent = lab; el.appendChild(h); }
    const u = untilText(e, now), mins = (e.start - now) / 60000;
    const cls = e.start <= now ? 'now' : mins < 60 && !e.allDay ? 'soon' : '';
    const key = e.start + e.title;
    const d = document.createElement('div'); d.className = 'ev ' + cls; d.style.setProperty('--i', i++);
    if (seen.has(key)) d.style.animation = 'none'; seen.add(key);
    d.innerHTML = `<span class="tm">${e.allDay ? 'Tüm gün' : hm(e.start)}</span><span class="ti">${esc(e.title)}${e.local ? '<span class="tag">PANEL</span>' : ''}${e.loc ? `<small>${esc(e.loc)}</small>` : ''}</span>${u ? `<span class="pill">${u}</span>` : ''}`;
    el.appendChild(d);
  }
  renderNext();
}
function renderNext() {
  const now = Date.now(), e = cal.find(x => !x.allDay && x.end > now && x.start - now < 864e5), card = $('nxCard');
  if (!e) { $('nxT').textContent = 'Önümüzde boş zaman var'; $('nxS').textContent = 'takvim boş'; card.classList.remove('now'); return; }
  $('nxT').textContent = e.title;
  const u = untilText(e, now);
  $('nxS').textContent = e.start <= now ? 'şimdi · ' + hm(e.end) + '’e kadar' : (dayLabel(e.start) === 'Bugün' ? '' : dayLabel(e.start) + ' · ') + hm(e.start) + (u ? ' · ' + u + ' sonra' : '');
  card.classList.toggle('now', e.start <= now);
}
setInterval(renderCal, 30000);

function renderTodos() {
  const el = $('todos'); el.innerHTML = '';
  const open = todos.filter(t => !t.done).length;
  $('todoSub').textContent = todos.length ? `${open} açık` : '';
  if (!todos.length) { el.innerHTML = '<div class="empty">Liste boş. Bir iş ekle ya da “Hey Jarvis, yapılacaklara süt almayı ekle” de.</div>'; return; }
  todos.slice().sort((a, b) => a.done - b.done).forEach((t, i) => {
    const d = document.createElement('div'); d.className = 'todo' + (t.done ? ' done' : ''); d.style.setProperty('--i', i);
    if (seen.has(t.id)) d.style.animation = 'none'; seen.add(t.id);
    d.innerHTML = `<button class="ck" aria-label="Tamamla"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button><span>${esc(t.text)}</span><button class="x" aria-label="Sil">×</button>`;
    const toggle = () => { t.done = !t.done; d.classList.toggle('done', t.done); if (t.done) { d.classList.add('pop'); vibrate(15); } syncTodos(); setTimeout(renderTodos, 650); };
    d.querySelector('.ck').onclick = toggle; d.querySelector('span').onclick = toggle;
    d.querySelector('.x').onclick = () => { d.style.transition = 'opacity .3s, transform .3s'; d.style.opacity = 0; d.style.transform = 'translateX(20px)'; setTimeout(() => { todos = todos.filter(x => x.id !== t.id); syncTodos(); renderTodos(); }, 280); };
    el.appendChild(d);
  });
}
const syncTodos = () => post('/api/todos', { todos }).catch(() => toast('Liste kaydedilemedi'));
function addTodo(text) { const t = { id: Date.now().toString(36), text, done: false }; todos.unshift(t); syncTodos(); renderTodos(); return t; }
$('todoForm').onsubmit = e => { e.preventDefault(); const v = $('todoIn').value.trim(); if (!v) return; addTodo(v); $('todoIn').value = ''; };

/* =====================================================================
   ARAÇLAR
   ===================================================================== */
const ICONS = {
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  shot: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3"/><circle cx="12" cy="12" r="3"/>',
  desk: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  task: '<path d="M3 17l5-6 4 3 4-7 5 5"/><path d="M3 21h18"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h2M12 12h2M8 16h2M12 16h2"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
  def: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
};
function renderActs() {
  const el = $('acts'); el.innerHTML = '';
  if (!server.actions.length) { el.innerHTML = '<div class="empty">Eylem yok.</div>'; return; }
  for (const a of server.actions) {
    const b = document.createElement('button'); b.className = 'act';
    b.innerHTML = `<span class="bd"><svg viewBox="0 0 24 24">${ICONS[a.icon] || ICONS.def}</svg></span>${esc(a.label)}`;
    b.onclick = async () => {
      vibrate(12); fire(b); b.classList.add('ok'); setTimeout(() => b.classList.remove('ok'), 700);
      try { const r = await post('/api/action/' + encodeURIComponent(a.id)); toast(r.ok ? a.label : 'Çalıştırılamadı'); } catch { toast('Bilgisayara ulaşılamadı'); }
    };
    el.appendChild(b);
  }
}
$('clipGo').onclick = async () => {
  fire($('clipGo'));
  const t = $('clipIn').value; if (!t.trim()) return toast('Önce bir şey yaz');
  try { const r = await post('/api/clip', { text: t }); if (r.ok) { toast('Bilgisayarın panosuna kopyalandı'); $('clipIn').value = ''; } else toast('Bu özellik yalnızca Windows\'ta çalışır'); } catch { toast('Bilgisayara ulaşılamadı'); }
};
function renderNotes() {
  const el = $('notes'); el.innerHTML = '';
  if (!notes.length) { el.innerHTML = '<div>Henüz bildirim yok</div>'; return; }
  notes.slice(0, 4).forEach(n => {
    const d = document.createElement('div'); d.className = n.level === 'warn' ? 'warn' : '';
    d.innerHTML = `<time>${hm(n.t)}</time><b>${esc(n.title)}</b>${esc(n.body || '')}`; el.appendChild(d);
  });
}

/* =====================================================================
   SAYFALAR, DOCK, PARALAKS
   ===================================================================== */
const pagesEl = $('pages'), sec = {}, vis = new Set();
document.querySelectorAll('.page').forEach(p => { sec[p.dataset.id] = p; p.querySelectorAll('.rv').forEach((el, i) => el.style.setProperty('--i', i)); });
const DOCK_ICONS = {
  panel: '<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>',
  hw: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  media: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  focus: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  day: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  tools: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
};
const io = new IntersectionObserver(es => es.forEach(e => {
  const id = e.target.dataset.id;
  if (e.intersectionRatio > .15) vis.add(id); else vis.delete(id);
  if (e.intersectionRatio > .55) e.target.classList.add('live'); else if (e.intersectionRatio < .1) e.target.classList.remove('live');
}), { root: pagesEl, threshold: [0, .1, .15, .55, 1] });
let pageIds = [];
function layoutPages() {
  const prevId = currentId();
  pageIds = S.order.filter(id => !S.hidden.includes(id)); if (!pageIds.length) pageIds = ['panel'];
  S.order.forEach(id => { if (!pageIds.includes(id)) { io.unobserve(sec[id]); vis.delete(id); sec[id].remove(); } });
  pageIds.forEach(id => { pagesEl.appendChild(sec[id]); io.observe(sec[id]); });
  const dock = $('dock'); dock.querySelectorAll('button').forEach(b => b.remove());
  pageIds.forEach((id, i) => {
    const b = document.createElement('button'); b.dataset.id = id; b.setAttribute('aria-label', sec[id].dataset.name);
    b.innerHTML = `<svg viewBox="0 0 24 24">${DOCK_ICONS[id]}</svg><span>${sec[id].dataset.name}</span>`;
    b.onclick = () => { vibrate(8); pagesEl.scrollTo({ left: i * pagesEl.clientWidth, behavior: 'smooth' }); };
    dock.appendChild(b);
  });
  setupCanvases();
  const i = Math.max(0, pageIds.indexOf(prevId)); pagesEl.style.scrollBehavior = 'auto'; pagesEl.scrollLeft = i * pagesEl.clientWidth; pagesEl.style.scrollBehavior = '';
  onScroll();
}
function currentId() { const i = Math.round(pagesEl.scrollLeft / (pagesEl.clientWidth || 1)); const c = pagesEl.children[i]; return c && c.dataset.id; }
let activeIdx = -1, indRaf = 0;
function moveInd() {
  const b = $('dock').querySelector('button.on'), ind = $('dockInd'); if (!b) return;
  const t0 = performance.now(); cancelAnimationFrame(indRaf);
  const follow = now => { ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft - 0}px)`; if (now - t0 < 650) indRaf = requestAnimationFrame(follow); };
  ind.style.transition = 'none'; indRaf = requestAnimationFrame(follow);
}
let scrollRaf = 0;
function onScroll() {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const W = pagesEl.clientWidth || 1, sl = pagesEl.scrollLeft;
    if (!S.lite) [...pagesEl.children].forEach((p, k) => {
      const v = Math.max(-1, Math.min(1, (k * W - sl) / W));
      if (Math.abs(v) >= 1 && p._pv === Math.sign(v)) return;       // ekran dışındaki sayfaya dokunma
      p._pv = Math.abs(v) >= 1 ? Math.sign(v) : v;
      // transform yerine ayrı translate/scale: öğelerin kendi animasyonlarıyla çakışmaz
      const tr = `${(v * -7).toFixed(2)}vw 0`, sc = (1 - Math.abs(v) * .05).toFixed(4);
      for (const ch of p.children) { ch.style.translate = tr; ch.style.scale = sc; }
    });
    const i = Math.round(sl / W);
    if (i !== activeIdx) { activeIdx = i; [...$('dock').querySelectorAll('button')].forEach((b, j) => b.classList.toggle('on', j === i)); moveInd(); }
  });
}
pagesEl.addEventListener('scroll', onScroll, { passive: true });
function goPage(id) { const i = pageIds.indexOf(id); if (i >= 0) pagesEl.scrollTo({ left: i * pagesEl.clientWidth, behavior: 'smooth' }); }

/* ---------- çizim döngüsü ---------- */
let lastFrame = 0, running = false, lastColors = '';
function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  const fps = S.lite ? 12 : 30;                         // 60 yerine: göze aynı, pil ve ısı yarı yarıya
  if (now - lastFrame < 1000 / fps - 2) return;
  const dt = Math.min(4, (now - lastFrame) / 16.7); lastFrame = now;
  const cKey = colors.accent + colors.accent2;          // tema değişince göstergeleri yeniden çiz
  if (cKey !== lastColors) { lastColors = cKey; drawn.cpu = drawn.mem = -1; }
  for (const k of ['cpu', 'mem']) {
    shown[k] += (target[k] - shown[k]) * Math.min(1, .08 * dt);
    const r = Math.round(shown[k]);
    if (r !== numShown[k]) { numShown[k] = r; $(k + 'V').firstChild.nodeValue = r; }
    if (vis.has('panel') && Math.abs(shown[k] - drawn[k]) > .08) { drawn[k] = shown[k]; drawGauge(k, shown[k]); }
  }
  if (vis.has('panel')) spCpu.draw(now);
  if (vis.has('hw')) { spDown.draw(now); spUp.draw(now); }
  else { spDown.h = spDown.h.filter(p => now - p.t < 62000); spUp.h = spUp.h.filter(p => now - p.t < 62000); }
  if (vis.has('media')) mediaProgress();
}
// ekran gizliyken / koruyucu açıkken hiç çizme ve CSS animasyonlarını durdur
function setRunning() {
  const want = document.visibilityState === 'visible' && !saverOn;
  document.body.classList.toggle('paused', !want);
  if (want && !running) { running = true; lastFrame = 0; drawn.cpu = drawn.mem = -1; requestAnimationFrame(frame); }
  else if (!want) running = false;
}
document.addEventListener('visibilitychange', setRunning);

/* =====================================================================
   AYARLAR
   ===================================================================== */
const sheet = $('sheet');
function segSet(id, val) { [...$(id).children].forEach(b => b.classList.toggle('on', b.dataset.v === String(val))); }
function renderSettings() {
  segSet('segTheme', S.theme); segSet('segSaver', S.saver); segSet('segGeo', S.geo);
  $('geoNote').textContent = S.geo !== 'phone' ? `Sunucudaki konum kullanılıyor${server.city ? ': ' + server.city : ''}.`
    : geoFresh() ? `Telefon konumu: ${S.geoPos.lat}, ${S.geoPos.lon}`
    : !navigator.geolocation ? 'Bu bağlantıda tarayıcı konum vermiyor. README\'deki Chrome bayrağı adımını uygula.'
    : S.geoErr === 1 ? 'Konum izni reddedildi. Chrome site ayarlarından izin ver.' : 'Konum bekleniyor…';
  $('bright').value = S.bright; $('brV').textContent = S.bright + '%';
  $('swAmb').classList.toggle('on', S.ambient); $('swLite').classList.toggle('on', S.lite);
  $('swWake').classList.toggle('on', S.wake); $('swTts').classList.toggle('on', S.tts);
  if (window.Jarvis) Jarvis.note();
  const L = $('pgList'); L.innerHTML = '';
  S.order.forEach((id, i) => {
    const row = document.createElement('div'); row.className = 'pg';
    row.innerHTML = `<span>${esc(sec[id].dataset.name)}</span><button ${i === 0 ? 'disabled' : ''} aria-label="Yukarı">↑</button><button ${i === S.order.length - 1 ? 'disabled' : ''} aria-label="Aşağı">↓</button><button class="sw ${S.hidden.includes(id) ? '' : 'on'}" aria-label="Göster"></button>`;
    const [up, dn, sw] = row.querySelectorAll('button');
    const move = d => { const j = i + d;[S.order[i], S.order[j]] = [S.order[j], S.order[i]]; save(); layoutPages(); renderSettings(); };
    up.onclick = () => move(-1); dn.onclick = () => move(1);
    sw.onclick = () => { const h = S.hidden.includes(id); if (!h && S.order.length - S.hidden.length <= 1) return toast('En az bir sayfa açık kalmalı'); S.hidden = h ? S.hidden.filter(x => x !== id) : [...S.hidden, id]; save(); layoutPages(); renderSettings(); };
    L.appendChild(row);
  });
  const C = $('pcList'); C.innerHTML = '';
  pcList().forEach((pc, i) => {
    const row = document.createElement('div'); row.className = 'pg';
    row.innerHTML = `<span>${esc(pc.name)}${i === S.cur ? ' · seçili' : ''}</span>${i ? '<button aria-label="Kaldır">×</button>' : ''}`;
    row.querySelector('span').onclick = () => { if (S.cur === i) return; S.cur = i; save(); server.host = ''; connect(); renderSettings(); };
    const rm = row.querySelector('button'); if (rm) rm.onclick = () => { S.pcs.splice(i - 1, 1); if (S.cur >= i) S.cur = Math.max(0, S.cur - 1); save(); server.host = ''; connect(); renderSettings(); };
    C.appendChild(row);
  });
}
$('gear').onclick = () => { renderSettings(); sheet.classList.add('show'); document.body.classList.add('overlay'); };
$('sheetClose').onclick = () => { sheet.classList.remove('show'); document.body.classList.remove('overlay'); };
const segClick = (id, fn) => { $(id).onclick = e => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); }; };
segClick('segTheme', v => { S.theme = v; save(); applyTheme(); renderSettings(); });
segClick('segSaver', v => { S.saver = +v; save(); renderSettings(); });
segClick('segGeo', v => { S.geo = v; S.geoErr = null; save(); renderSettings(); if (v === 'phone') updateGeo(true); else weather(); });
$('bright').oninput = e => { S.bright = +e.target.value; $('brV').textContent = S.bright + '%'; applyBright(); };
$('bright').onchange = save;
$('swAmb').onclick = () => { S.ambient = !S.ambient; save(); setupAmbient(); renderSettings(); if (S.ambient && !('AmbientLightSensor' in window)) toast('Işık sensörü bu tarayıcıda kapalı'); };
$('swLite').onclick = () => { S.lite = !S.lite; S.liteChosen = true; save(); setTimeout(setupCanvases, 50);
  document.querySelectorAll('.page>*').forEach(ch => { ch.style.translate = ''; ch.style.scale = ''; }); document.querySelectorAll('.page').forEach(p => { p._pv = null; }); onScroll(); applyTheme(); renderSettings(); };
$('swWake').onclick = () => { S.wake = !S.wake; save(); renderSettings(); window.Jarvis && Jarvis.setWake(S.wake); };
$('swTts').onclick = () => { S.tts = !S.tts; save(); renderSettings(); };
$('fsBtn').onclick = toggleFull;
$('pcForm').onsubmit = e => {
  e.preventDefault();
  try {
    const u = new URL($('pcIn').value.trim()), key = u.searchParams.get('k'); if (!key) throw 0;
    if (pcList().some(p => p.base === u.origin)) return toast('Bu bilgisayar zaten ekli');
    S.pcs.push({ name: u.host, base: u.origin, key }); save(); $('pcIn').value = ''; renderSettings(); toast('Eklendi: ' + u.host);
  } catch { toast('Geçerli bir eşleştirme bağlantısı değil'); }
};

/* =====================================================================
   EKRAN KORUYUCU, TAM EKRAN, UYANIK KALMA
   ===================================================================== */
['pointerdown', 'keydown', 'wheel'].forEach(t => addEventListener(t, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  const want = S.saver > 0 && !sheet.classList.contains('show') && !$('jv').classList.contains('show') && Date.now() - lastTouch > S.saver * 60000;
  if (want !== saverOn) { saverOn = want; $('saver').classList.toggle('show', saverOn); tick(); setRunning(); }
}, 3000);
$('saver').addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); saverOn = false; lastTouch = Date.now(); $('saver').classList.remove('show'); setRunning(); });
function toggleFull() { if (document.fullscreenElement) document.exitFullscreen(); else { document.documentElement.requestFullscreen?.().catch(() => {}); screen.orientation?.lock?.('landscape').catch(() => {}); } }
let lastTap = 0;
document.addEventListener('click', e => { if (e.target.closest('button,input,textarea,.sheet,.act,.jv,.dock')) return; const n = Date.now(); if (n - lastTap < 350) toggleFull(); lastTap = n; });
let wl = null, nosleepOn = false;
async function keepAwake() {
  if (navigator.wakeLock) { try { wl = await navigator.wakeLock.request('screen'); } catch {} return; }
  if (nosleepOn) return; nosleepOn = true;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 16; const x = c.getContext('2d');
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.setAttribute('playsinline', '');
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.02;pointer-events:none';
    v.srcObject = c.captureStream(5); document.body.appendChild(v);
    setInterval(() => { x.fillStyle = Math.random() > .5 ? '#000' : '#020202'; x.fillRect(0, 0, 16, 16); }, 1000);
    await v.play();
  } catch {}
}
document.addEventListener('pointerdown', () => { if (!wl && !nosleepOn) keepAwake(); }, { once: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.wakeLock && wl) keepAwake(); });

/* ---------- başlat ---------- */
applyTheme(); applyBright(); setupAmbient();
layoutPages(); renderSettings();
connect(); weather(); setInterval(weather, 15 * 60e3);
updateGeo(false); setInterval(() => updateGeo(false), 30 * 60e3);
setRunning();
setTimeout(() => toast('Tam ekran için çift dokun · sesli komut için mikrofon'), 2500);

// Masa Paneli — PC tarafı. Bağımlılık yok: `node server.js`
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QR = require('./public/qr.js');
const sensors = require('./lib/sensors');
const ics = require('./lib/ics');
const voiceBridge = require('./lib/voice');

const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- ayarlar ----------
const DEFAULT_ACTIONS = [
  { id: 'lock', label: 'Kilitle', icon: 'lock', cmd: 'rundll32.exe user32.dll,LockWorkStation' },
  { id: 'shot', label: 'Ekran alıntısı', icon: 'shot', cmd: 'explorer.exe ms-screenclip:' },
  { id: 'desk', label: 'Masaüstü', icon: 'desk', cmd: 'powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).ToggleDesktop()"' },
  { id: 'task', label: 'Görev yöneticisi', icon: 'task', cmd: 'taskmgr.exe' },
  { id: 'calc', label: 'Hesap makinesi', icon: 'calc', cmd: 'calc.exe' },
  { id: 'note', label: 'Not defteri', icon: 'note', cmd: 'notepad.exe' },
];
let config = { port: 7777, lat: null, lon: null, icsUrl: '', lhmUrl: 'http://localhost:8085/data.json', alerts: true, actions: DEFAULT_ACTIONS };
try { Object.assign(config, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))); } catch {}
const PORT = Number(process.env.PORT) || config.port;

// ---------- konum: config.json → Windows konum servisi → IP'den yaklaşık → İstanbul ----------
const locFile = path.join(DATA, 'location.json');
let loc = { lat: 41.01, lon: 28.97, city: 'İstanbul', source: 'varsayılan' };
if (config.lat != null && config.lon != null) loc = { lat: +config.lat, lon: +config.lon, city: config.city || '', source: 'config.json' };
else {
  try { const c = JSON.parse(fs.readFileSync(locFile, 'utf8')); if (Date.now() - c.at < 24 * 3600e3) loc = c; } catch {}
  if (loc.source === 'varsayılan') locate();
}
function locate() {
  const finish = l => { loc = { ...l, at: Date.now() }; fs.writeFile(locFile, JSON.stringify(loc), () => {}); console.log(`  Konum: ${loc.city || ''} ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)} (${loc.source})`); send('hello', hello()); };
  const viaIP = async () => {
    try {
      const j = await (await fetch('https://ipwho.is/?fields=success,latitude,longitude,city', { signal: AbortSignal.timeout(6000) })).json();
      if (j.success) finish({ lat: j.latitude, lon: j.longitude, city: j.city || '', source: 'IP adresinden (yaklaşık)' });
    } catch {}
  };
  if (process.platform !== 'win32') return viaIP();
  const ps = "Add-Type -AssemblyName System.Device; $w=New-Object System.Device.Location.GeoCoordinateWatcher; [void]$w.TryStart($false,[TimeSpan]::FromSeconds(6)); $t=0; while($w.Status -ne 'Ready' -and $t -lt 28){Start-Sleep -Milliseconds 250;$t++}; if(-not $w.Position.Location.IsUnknown){ $l=$w.Position.Location; Write-Output ('{0} {1}' -f $l.Latitude.ToString([Globalization.CultureInfo]::InvariantCulture), $l.Longitude.ToString([Globalization.CultureInfo]::InvariantCulture)) }";
  const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; c.stdout.on('data', d => out += d);
  c.on('exit', () => { const m = out.trim().match(/^(-?[\d.]+) (-?[\d.]+)$/); if (m) finish({ lat: +m[1], lon: +m[2], city: '', source: 'Windows konum servisi' }); else viaIP(); });
  c.on('error', viaIP);
}

// ---------- eşleştirme anahtarı ----------
const tokenFile = path.join(DATA, 'token.txt');
let TOKEN;
try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!TOKEN || TOKEN.length < 16) { TOKEN = crypto.randomBytes(8).toString('hex'); fs.writeFileSync(tokenFile, TOKEN); }

const same = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const isLoop = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
const cookieK = req => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)k=([^;]+)/); return m && m[1]; };
function authState(req, url) {
  if (same(url.searchParams.get('k'), TOKEN)) return 'query';
  if (same(cookieK(req), TOKEN)) return 'cookie';
  if (isLoop(req)) return 'local';
  return null;
}

// ---------- durum ----------
const clients = new Set();
const cache = { media: null, cal: [], todos: [], net: { down: 0, up: 0 }, hw: {}, notes: [] };
try { cache.todos = JSON.parse(fs.readFileSync(path.join(DATA, 'todos.json'), 'utf8')); } catch {}

function send(event, data, only) {
  const msg = (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of only ? [only] : clients) res.write(msg);
}
const voice = voiceBridge({ root: __dirname, onStatus: st => send('voice', st) });
const hello = () => ({ voice: voice.state(), host: os.hostname(), lat: loc.lat, lon: loc.lon, city: loc.city, hasCal: !!config.icsUrl, actions: config.actions.map(({ id, label, icon }) => ({ id, label, icon })), isWin: process.platform === 'win32' });

// ---------- sistem verisi ----------
let prev = os.cpus().map(c => ({ ...c.times }));
function cpuLoad() {
  const now = os.cpus().map(c => ({ ...c.times }));
  let idle = 0, total = 0;
  now.forEach((t, i) => { const p = prev[i]; total += Object.keys(t).reduce((a, k) => a + (t[k] - p[k]), 0); idle += t.idle - p.idle; });
  prev = now;
  return total ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}
async function diskInfo() {
  try { const root = path.parse(process.cwd()).root, s = await fs.promises.statfs(root); const total = s.blocks * s.bsize; return { total, used: total - s.bavail * s.bsize }; } catch { return null; }
}
async function snapshot() {
  const total = os.totalmem(), free = os.freemem();
  return { t: Date.now(), host: os.hostname(), cpu: cpuLoad(), cores: os.cpus().length, mem: { total, used: total - free }, disk: await diskInfo(), uptime: os.uptime(), net: cache.net, hw: cache.hw };
}

// ---------- bildirimler ----------
function notify(n) {
  const note = { id: Date.now() + Math.random(), t: Date.now(), title: String(n.title || '').slice(0, 120), body: String(n.body || '').slice(0, 300), level: n.level || 'info' };
  cache.notes.unshift(note); cache.notes.length = Math.min(cache.notes.length, 12);
  send('notify', note);
  return note;
}
const alertState = { cpuSince: 0, last: {} };
function checkAlerts(s) {
  if (!config.alerts) return;
  const now = Date.now(), cool = (k, ms = 600000) => { if (now - (alertState.last[k] || 0) < ms) return false; alertState.last[k] = now; return true; };
  if (s.cpu > 95) { alertState.cpuSince ||= now; if (now - alertState.cpuSince > 20000 && cool('cpu')) notify({ title: 'İşlemci uzun süredir %95 üstünde', body: 'Bir uygulama sistemi zorluyor olabilir.', level: 'warn' }); } else alertState.cpuSince = 0;
  if (s.mem.used / s.mem.total > 0.93 && cool('mem')) notify({ title: 'Bellek dolmak üzere', body: `%${Math.round(s.mem.used / s.mem.total * 100)} kullanımda.`, level: 'warn' });
  if (s.disk && s.disk.used / s.disk.total > 0.95 && cool('disk', 3600000)) notify({ title: 'Disk neredeyse dolu', body: `%${Math.round(s.disk.used / s.disk.total * 100)} dolu.`, level: 'warn' });
  const t = Math.max(s.hw.cpuTemp || 0, s.hw.temp || 0);
  if (t > 90 && cool('temp')) notify({ title: 'Sıcaklık yüksek', body: `${Math.round(t)} °C`, level: 'warn' });
}
setInterval(async () => {
  if (!clients.size) return;
  const s = await snapshot();
  send(null, s); checkAlerts(s);
}, 1000);

// ---------- sensörler ----------
sensors.netWatcher(n => { cache.net = n; });
sensors.gpuWatcher(h => { cache.hw = h; }, config.lhmUrl);
let mediaThumb = null, lastSent = null;
const media = sensors.mediaWatcher(m => {
  if (m.none) { if (cache.media) { cache.media = null; mediaThumb = null; send('media', { none: true }); } return; }
  if (m.newTrack) mediaThumb = m.thumb || null;
  const out = { key: m.key, title: m.title, artist: m.artist, album: m.album, status: m.status, app: m.app, pos: m.pos, dur: m.dur, thumb: m.newTrack ? mediaThumb : undefined, at: Date.now() };
  cache.media = { ...out, thumb: mediaThumb };
  // yalnızca bir şey değiştiğinde gönder (her saniye göndermek telefonu yoruyordu)
  const L = lastSent, now = Date.now();
  const drift = L && L.status === 'Playing' ? Math.abs((L.pos + (now - L.at) / 1000) - m.pos) : L ? Math.abs(L.pos - m.pos) : 99;
  if (!L || m.newTrack || L.key !== m.key || L.status !== m.status || L.dur !== m.dur || drift > 2.5) { lastSent = { key: m.key, status: m.status, dur: m.dur, pos: m.pos, at: now }; send('media', out); }
});

// ---------- takvim ----------
// Google/ICS etkinlikleri + panelde (sesle ya da elle) eklenen yerel etkinlikler birlikte gönderilir.
const evFile = path.join(DATA, 'events.json');
let icsEvents = [], localEvents = [];
try { localEvents = JSON.parse(fs.readFileSync(evFile, 'utf8')); } catch {}
const saveLocal = () => fs.writeFile(evFile, JSON.stringify(localEvents), () => {});
function mergedCal() {
  const now = Date.now();
  localEvents = localEvents.filter(e => e.end > now - 864e5);
  return [...icsEvents, ...localEvents.filter(e => e.end > now - 600e3).map(e => ({ ...e, local: true }))]
    .sort((a, b) => a.start - b.start).slice(0, 24);
}
const pushCal = () => { cache.cal = mergedCal(); send('cal', cache.cal); };
async function loadCal() {
  if (config.icsUrl) { try { icsEvents = await ics.fetchEvents(config.icsUrl); } catch (e) { console.log('  Takvim okunamadı:', e.message); } }
  pushCal();
}
loadCal(); setInterval(loadCal, 10 * 60 * 1000);

// ---------- eylemler ----------
const KEYS = { playpause: 0xB3, next: 0xB0, prev: 0xB1, mute: 0xAD, voldown: 0xAE, volup: 0xAF };
function pressKey(name) {
  const vk = KEYS[name];
  if (!vk || process.platform !== 'win32') return false;
  lastSent = null;   // bir sonraki durumu mutlaka telefona yolla (iyimser simgeyi düzeltmek için)
  if (media && media.send(name)) return true;   // kalıcı medya döngüsü: anında ve doğru uygulamaya
  const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte s,uint f,int e);' -Name K -Namespace W; [W.K]::keybd_event(${vk},0,0,0); [W.K]::keybd_event(${vk},0,2,0)`;
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  return true;
}
function runAction(id) {
  const a = config.actions.find(x => x.id === id);
  if (!a || !a.cmd) return false;
  const c = spawn(a.cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: false });
  c.on('error', () => {}); c.unref();
  return true;
}
function setClipboard(text) {
  if (process.platform !== 'win32') return false;
  const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  c.on('error', () => {}); c.stdin.end(text, 'utf8');
  return true;
}
const saveTodos = () => fs.writeFile(path.join(DATA, 'todos.json'), JSON.stringify(cache.todos), () => {});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const lanUrls = () => { const l = []; for (const [name, list] of Object.entries(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) l.push({ name, url: `http://${i.address}:${PORT}/?k=${TOKEN}` }); return l; };

function body(req, limit = 65536) {
  return new Promise((ok, no) => { let b = ''; req.on('data', d => { b += d; if (b.length > limit) { no(new Error('big')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); });
}
const json = (res, code, obj, cors) => { res.writeHead(code, { 'Content-Type': 'application/json', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); return res.end(); }

  const auth = authState(req, url);
  if (!auth) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta name=viewport content="width=device-width"><body style="background:#0b0a09;color:#efe8dc;font:16px system-ui;padding:8vw"><h2>Eşleşme gerekli</h2><p>Bilgisayarda <b>http://localhost:' + PORT + '/pair</b> sayfasını aç ve QR kodu telefonla okut.</p>'); }
  // Tarayıcıdaki başka bir sitenin localhost'a istek atmasını engelle
  const origin = req.headers.origin;
  if (auth === 'local' && origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); return res.end(); }
  const cors = auth === 'query';

  if (p === '/' && auth === 'query' && req.method === 'GET') {
    res.writeHead(302, { Location: '/', 'Set-Cookie': `k=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` });
    return res.end();
  }

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) });
    res.write('retry: 1500\n\n');
    clients.add(res);
    send('hello', hello(), res); send('todos', cache.todos, res); send('cal', cache.cal, res);
    send('media', cache.media || { none: true }, res); send('notes', cache.notes, res);
    snapshot().then(s => send(null, s, res));
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/pair') {
    if (!isLoop(req)) { res.writeHead(403); return res.end('Bu sayfa yalnızca bilgisayarın kendisinde açılır.'); }
    const items = lanUrls().map(u => `<figure><div class="qr">${QR.toSVG(u.url, { margin: 2 })}</div><figcaption>${u.name}<br><code>${u.url}</code></figcaption></figure>`).join('') || '<p>Ağ bağlantısı bulunamadı. PC\'yi telefonun hotspot\'una ya da telefonu PC\'nin hotspot\'una bağla.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Eşleştir</title><style>body{margin:0;background:#0b0a09;color:#efe8dc;font:16px system-ui;padding:6vh 6vw}h1{font-weight:300;font-size:2.4rem;margin:0 0 .4em}p{color:#7d756a;max-width:46ch}main{display:flex;gap:4vw;flex-wrap:wrap;margin-top:4vh}figure{margin:0}.qr{width:260px;background:#fff;padding:6px;border-radius:12px}.qr svg{display:block;width:100%}figcaption{margin-top:1em;color:#7d756a;font-size:.85rem;max-width:260px;word-break:break-all}code{color:#ffb03a}</style><h1>Telefonu eşleştir</h1><p>Telefonun kamerasıyla QR kodu okut ve açılan bağlantıyı Chrome'da aç. Telefon ve bilgisayar aynı ağda (hotspot, Wi-Fi veya Bluetooth ağı) olmalı. Bağlantı yalnızca bu anahtarla çalışır.</p><main>${items}</main>`);
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    try {
      const parts = p.split('/').slice(2);
      if (parts[0] === 'key') return json(res, pressKey(parts[1]) ? 200 : 400, { ok: true }, cors);
      if (parts[0] === 'action') return json(res, runAction(parts[1]) ? 200 : 404, { ok: true }, cors);
      if (parts[0] === 'clip') { const t = JSON.parse(await body(req)).text; if (typeof t !== 'string' || !t) return json(res, 400, {}, cors); const ok = setClipboard(t.slice(0, 20000)); if (ok) notify({ title: 'Panoya kopyalandı', body: t.slice(0, 80) }); return json(res, ok ? 200 : 400, { ok }, cors); }
      if (parts[0] === 'todos') { const t = JSON.parse(await body(req)).todos; if (!Array.isArray(t)) return json(res, 400, {}, cors); cache.todos = t.slice(0, 60).map(x => ({ id: String(x.id).slice(0, 24), text: String(x.text).slice(0, 140), done: !!x.done })); saveTodos(); send('todos', cache.todos); return json(res, 200, { ok: true }, cors); }
      if (parts[0] === 'event' && !parts[1]) {
        const e = JSON.parse(await body(req));
        const start = +e.start, end = +e.end || start + 3600e3;
        if (!e.title || !isFinite(start) || end < start) return json(res, 400, {}, cors);
        const ev = { id: 'l' + Date.now().toString(36), title: String(e.title).slice(0, 140), start, end, allDay: !!e.allDay, loc: String(e.loc || '').slice(0, 80) };
        localEvents.push(ev); saveLocal(); pushCal();
        return json(res, 200, ev, cors);
      }
      if (parts[0] === 'event' && parts[1] === 'delete') {
        const { id } = JSON.parse(await body(req)); const n = localEvents.length;
        localEvents = localEvents.filter(e => e.id !== id); saveLocal(); pushCal();
        return json(res, n !== localEvents.length ? 200 : 404, { ok: true }, cors);
      }
      if (parts[0] === 'notify') { const n = JSON.parse(await body(req)); return json(res, 200, notify(n), cors); }
    } catch { return json(res, 400, { error: 'bad request' }, cors); }
    return json(res, 404, {}, cors);
  }

  const file = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// Telefonun mikrofon akışı (Whisper ses servisi)
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const auth = authState(req, url), origin = req.headers.origin;
  const okOrigin = !origin || new URL(origin).host === req.headers.host || auth === 'query';
  if (url.pathname !== '/voice' || !auth || !okOrigin || !voice.installed) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  voice.upgrade(req, socket);
});
process.on('SIGINT', () => { voice.stop(); process.exit(0); });
process.on('exit', () => voice.stop());

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `\n  ${PORT} portu kullanımda. Başka bir panel açık olabilir (PORT=7788 node server.js ile değiştir).\n` : e); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  MASA PANELİ çalışıyor\n');
  const urls = lanUrls();
  if (!urls.length) console.log('  Ağ bulunamadı. PC ve telefonu aynı ağa bağla (hotspot / Bluetooth ağı).\n');
  urls.forEach((u, i) => { console.log(`  ${u.name}: ${u.url}\n`); if (i === 0) console.log(QR.toAscii(u.url).split('\n').map(l => '  ' + l).join('\n')); });
  console.log(`  Tarayıcıda QR sayfası: http://localhost:${PORT}/pair`);
  console.log('  Durdurmak için Ctrl+C\n');
});

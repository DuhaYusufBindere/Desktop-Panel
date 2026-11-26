// Takvim: ICS (iCal) adresinden yaklaşan etkinlikleri okur. Google Takvim'de "iCal biçiminde gizli adres" kullanılabilir.
function unfold(t) { return t.replace(/\r?\n[ \t]/g, ''); }
function unesc(s) { return (s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }

function parseLine(line) {
  const i = line.indexOf(':'); if (i < 0) return null;
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {}; ps.forEach(p => { const [k, v] = p.split('='); params[k.toUpperCase()] = (v || '').replace(/"/g, ''); });
  return { name: name.toUpperCase(), params, val: line.slice(i + 1) };
}

function tzOffset(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = {}; f.formatToParts(ms).forEach(x => { p[x.type] = +x.value; });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const base = Date.UTC(y, mo, d, h, mi, s); let g = base;
  for (let i = 0; i < 2; i++) g = base - tzOffset(g, tz);
  return g;
}
function parseDate(val, params) {
  if (/^\d{8}$/.test(val)) return { ms: new Date(+val.slice(0, 4), +val.slice(4, 6) - 1, +val.slice(6, 8)).getTime(), allDay: true };
  const m = val.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/); if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s) };
  if (params && params.TZID) { try { return { ms: zonedToUtc(y, mo - 1, d, h, mi, s, params.TZID) }; } catch {} }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime() };
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// Basit RRULE açılımı: DAILY / WEEKLY(+BYDAY) / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, EXDATE
function occurrences(ev, from, to) {
  if (!ev.rrule) return ev.end >= from && ev.start <= to ? [ev.start] : [];
  const r = ev.rrule, step = +r.INTERVAL || 1, max = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? (parseDate(r.UNTIL.length === 8 ? r.UNTIL : r.UNTIL, {}) || {}).ms ?? Infinity : Infinity;
  const s = new Date(ev.start), byday = r.BYDAY ? r.BYDAY.split(',').map(x => DAYS[x.slice(-2)]) : [s.getDay()];
  const out = []; let count = 0;
  const startDay = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  for (let i = 0; ; i++) {
    const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
    const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), s.getHours(), s.getMinutes(), s.getSeconds()).getTime();
    if (t > to || t > until) break;
    let ok = false;
    if (r.FREQ === 'DAILY') ok = i % step === 0;
    else if (r.FREQ === 'WEEKLY') ok = Math.floor((i + s.getDay()) / 7) % step === 0 && byday.includes(day.getDay());
    else if (r.FREQ === 'MONTHLY') ok = day.getDate() === s.getDate() && ((day.getFullYear() - s.getFullYear()) * 12 + day.getMonth() - s.getMonth()) % step === 0;
    else if (r.FREQ === 'YEARLY') ok = day.getDate() === s.getDate() && day.getMonth() === s.getMonth() && (day.getFullYear() - s.getFullYear()) % step === 0;
    if (!ok) continue;
    if (++count > max) break;
    if (!ev.ex.has(t) && t + (ev.end - ev.start) >= from) out.push(t);
    if (i > 20000) break;
  }
  return out;
}

function parseICS(text, now = Date.now(), days = 7) {
  const lines = unfold(text).split(/\r?\n/);
  const evs = []; let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { cur = { ex: new Set(), title: '', loc: '' }; continue; }
    if (raw === 'END:VEVENT') { if (cur && cur.start != null) { if (cur.end == null) cur.end = cur.start + (cur.allDay ? 864e5 : 0); evs.push(cur); } cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(raw); if (!p) continue;
    if (p.name === 'SUMMARY') cur.title = unesc(p.val);
    else if (p.name === 'LOCATION') cur.loc = unesc(p.val);
    else if (p.name === 'DTSTART') { const d = parseDate(p.val, p.params); if (d) { cur.start = d.ms; cur.allDay = !!d.allDay; } }
    else if (p.name === 'DTEND') { const d = parseDate(p.val, p.params); if (d) cur.end = d.ms; }
    else if (p.name === 'RRULE') { cur.rrule = {}; p.val.split(';').forEach(kv => { const [k, v] = kv.split('='); cur.rrule[k] = v; }); }
    else if (p.name === 'EXDATE') p.val.split(',').forEach(v => { const d = parseDate(v, p.params); if (d) cur.ex.add(d.ms); });
    else if (p.name === 'STATUS' && /CANCELLED/i.test(p.val)) cur.cancelled = true;
  }
  const from = now - 3600e3, to = now + days * 864e5, out = [];
  for (const e of evs) {
    if (e.cancelled) continue;
    const dur = e.end - e.start;
    for (const t of occurrences(e, from, to)) out.push({ title: e.title || '(başlıksız)', loc: e.loc, start: t, end: t + dur, allDay: e.allDay });
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter(e => e.end >= now - 600e3).slice(0, 14);
}

async function fetchEvents(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseICS(await r.text());
}

module.exports = { parseICS, fetchEvents };

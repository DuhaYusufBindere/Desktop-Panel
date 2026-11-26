// Jarvis — Türkçe sesli komut çözümleyici. Konuşmayı eyleme çevirir; hiçbir şeyi kendisi çalıştırmaz.
// Hem tarayıcıda (window.JarvisCore) hem Node'da (require) çalışır.
(function (root) {
  const L = s => s.toLocaleLowerCase('tr');
  const B = '(?<![\\p{L}\\d])', E = '(?![\\p{L}\\d])';
  const w = (src, f = 'iu') => new RegExp(B + '(?:' + src + ')' + E, f);

  // ---------- uyandırma sözcüğü ----------
  const WAKE = new RegExp(B + '(?:(?:hey|hay|hei|ey|he|hi|hii)\\s+)?(?:j|c|ç|h|y)[ae]a?r?v[iıe][sşz]' + E, 'iu');
  function stripWake(text) {
    const t = L(text || ''), m = t.match(WAKE);
    if (!m) return { woke: false, rest: t };
    return { woke: true, rest: t.slice(m.index + m[0].length).replace(/^[\s,.!?]+/, '') };
  }

  // ---------- sayılar ----------
  const UNITS = { sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, dörd: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9 };
  const TENS = { on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50 };
  const LOC = /^(?:de|da|te|ta)$/, SUFS = /^(?:|e|a|ye|ya|de|da|te|ta|den|dan|ten|tan|ü|u|ı|i)$/;
  const NUMW = /^(sıfır|bir|iki|üç|dörd|dört|beş|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kırk|elli)(.*)$/;
  const CONTEXT_BEFORE = /^(saat|sabah|öğlen|öğle|akşam|gece|sonra|@)$/, CONTEXT_AFTER = /^(buçuk|saat|dakika|dk|gün|hafta|sonra)/;

  function normalize(text) {
    let s = L(text).replace(/[’'`´]/g, '').replace(/[,!?;"“”]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
    // tanıyıcı eki ayırınca: "11.00 a", "11 de", "15:30 da" → "11.00a"
    s = s.replace(/(\d)\s+(de|da|te|ta|e|a|ye|ya)(?![\p{L}\d])/gu, '$1$2');
    s = s.replace(/buçuk(?:ta|da|te|de)(?![\p{L}\d])/gu, 'buçuk @');
    // 15te, 9da, 15.30da → "15 @", "15.30 @" ; 25inde → 25
    s = s.replace(/(\d{1,2}(?:[:.]\d{2})?)(de|da|te|ta)(?![\p{L}\d])/gu, '$1 @');
    s = s.replace(/(\d{1,2}(?:[:.]\d{2})?)(e|a|ye|ya|inde|ında|unda|ünde|inci|ıncı|nci|ncı|ı|i)(?![\p{L}\d])/gu, '$1');
    // sayı sözcükleri
    const t = s.split(' '), out = [];
    for (let i = 0; i < t.length; i++) {
      const m = t[i].match(NUMW);
      if (!m || !SUFS.test(m[2])) { out.push(t[i]); continue; }
      let val, suf = m[2], j = i;
      if (m[1] in TENS && !suf && t[i + 1]) {
        const n = t[i + 1].match(NUMW);
        if (n && n[1] in UNITS && SUFS.test(n[2])) { val = TENS[m[1]] + UNITS[n[1]]; suf = n[2]; j = i + 1; }
      }
      if (val == null) val = m[1] in TENS ? TENS[m[1]] : UNITS[m[1]];
      if (m[1] === 'bir' && j === i && !suf) {
        const prev = out[out.length - 1] || '', next = t[i + 1] || '';
        if (!CONTEXT_BEFORE.test(prev) && !CONTEXT_AFTER.test(next)) { out.push(t[i]); continue; }
      }
      out.push(String(val)); if (LOC.test(suf)) out.push('@');
      i = j;
    }
    return out.join(' ');
  }

  // ---------- tarih ----------
  const MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
  const WD = [['pazartesi', 1], ['salı', 2], ['çarşamba', 3], ['perşembe', 4], ['cumartesi', 6], ['cuma', 5], ['pazar', 0]];
  const dayStart = (ms, add = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + add); };

  function takeDate(st, now) {
    let m;
    const cut = (re) => { st.s = st.s.replace(re, ' '); };
    if ((m = st.s.match(w('(\\d{1,2}) (' + MONTHS.join('|') + ')\\p{L}*(?: (\\d{4}))?')))) {
      const d = +m[1], mo = MONTHS.indexOf(m[2]); let y = m[3] ? +m[3] : new Date(now).getFullYear();
      let dt = new Date(y, mo, d); if (!m[3] && dt < dayStart(now)) dt = new Date(y + 1, mo, d);
      cut(m[0]); return dt;
    }
    if ((m = st.s.match(w('yarından sonra|öbür gün|öbürsü gün|ertesi gün')))) { cut(m[0]); return dayStart(now, 2); }
    if ((m = st.s.match(w('(\\d+) gün sonra')))) { cut(m[0]); return dayStart(now, +m[1]); }
    const next = st.s.match(w('haftaya|gelecek hafta|önümüzdeki hafta|seneye'));
    for (const [name, wd] of WD) {
      const re = w(name + '\\p{L}*(?: günü\\p{L}*)?');
      if ((m = st.s.match(re))) {
        const today = new Date(now).getDay(); let diff;
        if (next) { const iso = today === 0 ? 7 : today, toMon = 8 - iso; diff = toMon + ((wd + 6) % 7); cut(next[0]); }
        else { diff = (wd - today + 7) % 7 || 7; }
        cut(m[0]); return dayStart(now, diff);
      }
    }
    if (next && /hafta/.test(next[0])) { cut(next[0]); return dayStart(now, 7); }
    if ((m = st.s.match(w('yarın\\p{L}*')))) { cut(m[0]); return dayStart(now, 1); }
    if ((m = st.s.match(w('bugün\\p{L}*|bu gün')))) { cut(m[0]); return dayStart(now, 0); }
    return null;
  }

  // ---------- saat ----------
  const PERIOD = 'sabah|öğleden sonra|öğlen|öğle|akşam|gece|bu akşam|bu sabah';
  function takeTime(st, now) {
    let m, h = null, mi = 0, per = null;
    const cut = re => { st.s = st.s.replace(re, ' '); };
    // göreli: "2 saat sonra", "yarım saat sonra", "20 dakika sonra"
    if ((m = st.s.match(w('(\\d+|yarım) (saat|dakika|dk) sonra')))) {
      const n = m[1] === 'yarım' ? .5 : +m[1], ms = n * (m[2] === 'saat' ? 3600e3 : 60e3); cut(m[0]);
      return { rel: now + ms };
    }
    const pm = st.s.match(w('(' + PERIOD + ')(?:\\p{L}*)(?! yeme)'));
    if (pm) { per = pm[1].replace(/^bu /, ''); cut(pm[0]); }
    if ((m = st.s.match(w('(?:saat )?(\\d{1,2})[:.](\\d{2})(?: @)?')))) { h = +m[1]; mi = +m[2]; cut(m[0]); }
    else if ((m = st.s.match(w('saat (\\d{1,2})( buçuk)?(?: @)?')))) { h = +m[1]; mi = m[2] ? 30 : 0; cut(m[0]); }
    else if ((m = st.s.match(/(?:^|\s)(\d{1,2})( buçuk)? @/u))) { h = +m[1]; mi = m[2] ? 30 : 0; cut(m[0]); }
    else if ((m = st.s.match(w('(\\d{1,2}) buçuk')))) { h = +m[1]; mi = 30; cut(m[0]); }
    else if (per && (m = st.s.match(/^\s*(\d{1,2})(?=\s|$)/u))) { h = +m[1]; cut(m[0]); }
    st.s = st.s.replace(/ @/g, ' ');
    if (h == null && !per) return null;
    if (h == null) h = { sabah: 9, öğlen: 12, öğle: 12, 'öğleden sonra': 15, akşam: 19, gece: 22 }[per];
    if (h > 23 || mi > 59) return null;
    if (per === 'gece') { if (h === 12) h = 0; else if (h >= 6 && h < 12) h += 12; }
    else if (per && /akşam|öğleden sonra/.test(per) && h < 12) h += 12;
    else if (per === 'öğlen' || per === 'öğle') { if (h < 6) h += 12; }
    else if (!per && h >= 1 && h <= 6) h += 12; // "saat 3" büyük olasılıkla 15:00
    return { h, mi, guessedPm: !per && h >= 13 && h <= 18 && !/:/.test(String(m && m[0])) };
  }

  // ---------- başlık temizliği ----------
  const STRIP = [
    'hey|jarvis', 'yapılacaklar(?:ım)?(?: listesi(?:ne|me)?)?(?:a|e)?|yapılacaklara|yapılacaklar listeme|listeme|listeye|listesine|listem(?:e)?|görevlere|göreve|görev olarak',
    'takvim(?:e|ime|imize|de|imde|imize)?', 'etkinlik(?: olarak)?|etkinliği|hatırlatıcı(?: olarak)?|hatırlatma(?:sı)?(?: kur)?',
    'ekle(?:r misin| misin|yebilir misin|yin|sene|r mısın|rsin)?|oluştur(?:ur musun)?|kaydet(?:ir misin)?|ayarla(?:r mısın)?|planla|koy(?:ar mısın)?|hatırlat(?:ır mısın|sana|)?|not al|yaz(?:ar mısın)?',
    'lütfen|bana|benim için|için|adında|isimli|diye|şunu|bunu|olarak|bir tane|bi|saat|tamam|var|olacak|yap|de|da|a|e',
  ].map(x => w(x, 'giu'));
  const tidy = s => { let t = s; for (const re of STRIP) t = t.replace(re, ' '); t = t.replace(/(?:^|\s)bir(?=\s|$)/u, ' ').replace(/\s+/g, ' ').trim(); return t ? t[0].toLocaleUpperCase('tr') + t.slice(1) : ''; };

  // ---------- ana çözümleyici ----------
  function parse(text, now = Date.now()) {
    const raw = stripWake(text).rest.trim();
    if (!raw) return { type: 'empty' };
    const s = normalize(raw);
    const has = src => w(src).test(s);

    if (has('geri al|vazgeç|iptal et|son ekleneni sil|son eklediğini sil')) return { type: 'undo' };
    if (has('saat kaç')) return { type: 'time' };
    if (has('hava (?:nasıl|durumu)|kaç derece|dışarısı nasıl')) return { type: 'weather' };

    // medya
    if (has('sonraki (?:şarkı|parça)|şarkıyı geç|sonrakine geç|ileri sar|sıradaki şarkı')) return { type: 'media', key: 'next' };
    if (has('önceki (?:şarkı|parça)|önceki|başa sar')) return { type: 'media', key: 'prev' };
    if (has('sesi (?:aç|yükselt|artır)|sesi biraz aç')) return { type: 'media', key: 'volup' };
    if (has('sesi (?:kıs|azalt|düşür)')) return { type: 'media', key: 'voldown' };
    if (has('sessize al|sesi kapat|sustur')) return { type: 'media', key: 'mute' };
    if (has('(?:müziği|şarkıyı|müzik)?\\s*(?:duraklat|durdur|devam ettir|devam et|oynat|çal)') && has('müzik|şarkı|duraklat|devam|oynat|çal')) return { type: 'media', key: 'playpause' };

    // odak
    if (has('pomodoro|odak(?: modu)?|çalışma sayacı') && has('başlat|aç|başla')) return { type: 'focus', action: 'start' };
    if (has('pomodoro|odak(?: modu)?|çalışma sayacı') && has('durdur|bitir|kapat')) return { type: 'focus', action: 'stop' };

    // sorgular
    if (has('yapılacak\\p{L}*|listem\\p{L}*|görevler\\p{L}*') && has('neler|ne var|oku|söyle|listele|neler kaldı') && !has('ekle')) return { type: 'todo.list' };
    if (has('sıradaki (?:etkinlik|toplantı|randevu)|sırada ne var|sıradaki ne')) return { type: 'event.next' };
    if (has('neler var|ne var|programım|programımda|takvimimde|toplantım var mı|planım|planlarım') && !has('ekle')) return { type: 'event.list', day: has('yarın\\p{L}*') ? 1 : 0 };

    // tamamlama
    let m = s.match(w('(.+?) (?:tamamladım|tamamlandı|tamamla|bitirdim|bitti|yapıldı|yaptım|hallettim|hallet|işaretle|tamam olarak işaretle)'));
    if (m && !has('ekle')) return { type: 'todo.done', query: tidy(m[1].replace(w('yapılacaklardan|listeden|görevlerden'), ' ')) };

    const wantsAdd = has('ekle\\p{L}*|oluştur\\p{L}*|kaydet\\p{L}*|ayarla\\p{L}*|planla|koy|hatırlat\\p{L}*|not al|yaz');
    const todoish = has('yapılacak\\p{L}*|listem\\p{L}*|listeye|listesine|görev\\p{L}*|not al');
    const calish = has('takvim\\p{L}*|randevu\\p{L}*|toplantı\\p{L}*|etkinlik\\p{L}*|buluşma\\p{L}*|hatırlat\\p{L}*');

    if (wantsAdd && todoish && !has('takvim\\p{L}*')) {
      const text = tidy(s.replace(/ @/g, ' '));
      return text ? { type: 'todo.add', text } : { type: 'unknown', text: raw };
    }

    // etkinlik
    const st = { s };
    const date = takeDate(st, now), time = takeTime(st, now);
    if ((wantsAdd && (date || time || calish)) || (time && (date || calish))) {
      const title = tidy(st.s) || (has('hatırlat\\p{L}*') ? 'Hatırlatma' : 'Etkinlik');
      if (time && time.rel) return { type: 'event.add', title, start: time.rel, end: time.rel + 30 * 60e3, allDay: false };
      if (!time && has('hatırlat\\p{L}*') && !date) return { type: 'todo.add', text: title };
      let d = date;
      if (time) {
        if (!d) { d = dayStart(now); const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.h, time.mi); if (t.getTime() <= now) d = dayStart(now, 1); }
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.h, time.mi).getTime();
        const dm = s.match(w('(\\d+) (saat|dakika|dk)(?:lik| sürecek| süreyle| boyunca)'));
        const dur = dm ? +dm[1] * (dm[2] === 'saat' ? 3600e3 : 60e3) : 3600e3;
        return { type: 'event.add', title: tidy(title.replace(w('\\d+ (?:saat|dakika|dk)(?:lik| sürecek| süreyle| boyunca)'), ' ')) || title, start, end: start + dur, allDay: false, guessedPm: time.guessedPm };
      }
      const start = (d || dayStart(now)).getTime();
      return { type: 'event.add', title, start, end: start + 864e5, allDay: true };
    }
    if (wantsAdd) { const text = tidy(s.replace(/ @/g, ' ')); if (text) return { type: 'todo.add', text }; }
    return { type: 'unknown', text: raw };
  }

  const api = { parse, stripWake, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JarvisCore = api;
})(typeof self !== 'undefined' ? self : globalThis);

'use strict';
/* =====================================================================
   Jarvis — sesli asistan. Tanıma Chrome'un (Google) konuşma motoruyla,
   anlama jarvis-core.js ile, eylemler bu panelin kendi API'siyle yapılır.
   ===================================================================== */
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const C = window.JarvisCore;
  const jv = $('jv'), mic = $('micBtn');
  const supported = !!SR && window.isSecureContext;

  let rec = null, mode = 'idle';           // idle | wake | command
  let running = false, speaking = false, busy = false;
  let fails = 0, restartT = 0, silenceT = 0, idleT = 0, closeT = 0;
  let cmdFrom = 0, undoFn = null, lastErr = '';

  const IC = {
    todo: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    media: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    focus: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    wx: '<path d="M7 18h10a4 4 0 000-8 6 6 0 00-11.6 1.5A3.3 3.3 0 007 18z"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
    q: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01"/>',
  };
  const HINTS = [
    '“yarın saat 3’te diş randevusu ekle”', '“cuma akşam 7’de sinema”', '“yapılacaklara süt almayı ekle”',
    '“süt almayı tamamladım”', '“bugün neler var”', '“sıradaki şarkı”', '“pomodoro başlat”', '“geri al”',
  ];

  /* ---------- arayüz ---------- */
  function setState(st, label) {
    jv.classList.remove('listen', 'think', 'speak', 'err'); if (st) jv.classList.add(st);
    $('jvState').textContent = label;
  }
  function open() {
    clearTimeout(closeT);
    if (!jv.classList.contains('show')) {
      jv.classList.add('show'); document.body.classList.add('overlay'); $('jvCard').classList.remove('show'); $('jvText').innerHTML = '';
      const h = HINTS.slice().sort(() => Math.random() - .5).slice(0, 3).join(' · ');
      $('jvHint').innerHTML = supported || pcOn() ? 'Şunları deneyebilirsin: ' + h : noteText() + '<br>Aşağıya yazarak da komut verebilirsin: ' + h;
    }
  }
  function close() {
    clearTimeout(closeT); clearTimeout(idleT); clearTimeout(silenceT);
    jv.classList.remove('show', 'listen', 'think', 'speak', 'err');
    if (!$('sheet').classList.contains('show')) document.body.classList.remove('overlay');
    try { speechSynthesis.cancel(); } catch {} speaking = false;
    if (running && kind === 'cmd') { try { rec.abort(); } catch {} }
    afterCommand();
    $('jvIn').blur();
  }
  function closeLater(ms) { clearTimeout(closeT); closeT = setTimeout(close, ms); }
  function card(icon, title, sub, undo) {
    $('jvIc').innerHTML = `<svg viewBox="0 0 24 24">${IC[icon] || IC.q}</svg>`;
    $('jvTitle').textContent = title; $('jvSub').textContent = sub || '';
    $('jvUndo').hidden = !undo;
    const c = $('jvCard'); c.classList.remove('show'); void c.offsetWidth; c.classList.add('show');
  }
  function chime(up = true) {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      (up ? [740, 1110] : [880, 587]).forEach((f, i) => {
        const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + i * .09;
        o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(a.destination);
        g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.18, t + .015); g.gain.exponentialRampToValueAtTime(.0001, t + .22);
        o.start(t); o.stop(t + .25);
      });
      setTimeout(() => a.close(), 600);
    } catch {}
  }
  let voice = null;
  function pickVoice() { try { const v = speechSynthesis.getVoices(); voice = v.find(x => /^tr/i.test(x.lang) && /google/i.test(x.name)) || v.find(x => /^tr/i.test(x.lang)) || null; } catch {} }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function say(text) {
    return new Promise(res => {
      if (!S.tts || !('speechSynthesis' in window)) return res();
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text); u.lang = 'tr-TR'; if (voice) u.voice = voice; u.rate = 1.05;
        speaking = true; setState('speak', 'Jarvis');
        const done = () => { if (!speaking) return; speaking = false; res(); };
        u.onend = done; u.onerror = done; setTimeout(done, 1500 + text.length * 90);
        speechSynthesis.speak(u);
      } catch { speaking = false; res(); }
    });
  }

  /* ---------- tanıyıcı ---------- */
  function noteText() {
    if (pcOn()) {
      const v = server.voice;
      if (lastErr === 'not-allowed') return 'Mikrofon izni verilmedi. Adres çubuğundaki simgeden mikrofona izin ver.';
      if (v.status === 'ready') return `Ses bilgisayarda çözülüyor (Whisper ${v.model || ''}${v.device === 'cuda' ? ', ekran kartı' : ''}). “Hey Jarvis” bip çalmadan dinlenir.`;
      if (v.status === 'error') return 'Bilgisayardaki ses servisi çalışmadı: ' + (v.msg || '') + '. Şimdilik Chrome’un tanıması kullanılıyor.';
      return 'Ses servisi bilgisayarda yükleniyor (ilk açılışta model iner, birkaç dakika sürebilir)…';
    }
    if (server.voice && server.voice.status !== 'off' && !window.isSecureContext) return 'Mikrofon için güvenli bağlantı gerekli: Chrome’da chrome://flags → “Insecure origins treated as secure” alanına bu adresi ekle (README’de anlatıldı).';
    if (!SR) return 'Bu tarayıcı konuşma tanımayı desteklemiyor. Android’de Chrome kullan.';
    if (!window.isSecureContext) return 'Mikrofon için güvenli bağlantı gerekli: Chrome’da chrome://flags → “Insecure origins treated as secure” alanına bu adresi ekle (README’de anlatıldı).';
    if (lastErr === 'not-allowed' || lastErr === 'service-not-allowed') return 'Mikrofon izni verilmedi. Adres çubuğundaki kilit simgesinden mikrofona izin ver.';
    if (lastErr === 'network') return 'Konuşma tanıma internet istiyor; telefonun internete çıkabildiğinden emin ol.';
    return S.wake ? '“Hey Jarvis” dediğinde açılır. Android ekranı açık ve panel önde olduğu sürece dinler.' : 'Mikrofon düğmesine dokununca dinler. İstersen “Hey Jarvis” ile uyandırmayı aç.';
  }
  function note() { const n = $('jvNote'); if (n) n.textContent = noteText(); }

  /* Oturum türleri:
     - "cmd"  : düğmeye basınca tek cümlelik dinleme. Cümle bitince Chrome kendisi kapatır; yeniden BAŞLATILMAZ.
     - "wake" : “Hey Jarvis” için sürekli dinleme. Android her yeniden başlatmada bip çalar, bu yüzden isteğe bağlı. */
  let kind = '', heard = '', handled = false;
  function startSession(k) {
    if (!supported || running) return;
    kind = k; heard = ''; handled = false; cmdFrom = 0;
    const r = new SR();
    r.lang = 'tr-TR'; r.continuous = k === 'wake'; r.interimResults = true; r.maxAlternatives = 3;
    r.onstart = () => { running = true; mic.classList.toggle('wake', k === 'wake'); };
    r.onresult = onResult;
    r.onerror = e => {
      lastErr = e.error;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        mode = 'idle'; S.wake = false; save(); note();
        if (jv.classList.contains('show')) { setState('err', 'İzin yok'); $('jvText').textContent = 'Mikrofona erişemiyorum'; $('jvHint').textContent = noteText(); }
        else toast('Mikrofon izni yok');
      } else if (e.error === 'network' || e.error === 'audio-capture') fails += 2;
      else if (e.error !== 'no-speech' && e.error !== 'aborted') fails++;
    };
    r.onend = onEnd;
    rec = r;
    try { r.start(); } catch { running = false; }
  }
  function onEnd() {
    running = false; mic.classList.remove('wake'); clearTimeout(silenceT);
    // komut dinlerken oturum bittiyse: duyduğumuzu çalıştır ya da "duyamadım" de
    if (mode === 'command' && !busy) {
      if (kind === 'cmd' || heard) {
        if (!handled && heard) return finish(heard);
        if (!handled) { noHear(); return afterCommand(); }
      } else return startSession('cmd');      // uyandırma oturumu kapandı, komutu ayrı dinle
    }
    if (mode === 'wake' && !busy) {
      clearTimeout(restartT);
      restartT = setTimeout(() => { if (mode === 'wake' && !busy) startSession('wake'); }, Math.min(15000, 1200 * 2 ** Math.min(fails, 4)));
    }
  }
  function stopRec() { clearTimeout(restartT); clearTimeout(silenceT); if (rec && running) { try { rec.abort(); } catch {} } mic.classList.remove('wake'); }
  function afterCommand() {
    if (pcOn() && (PC.stream || PC.ws) && !running) return pcAfter();
    mode = S.wake && supported ? 'wake' : 'idle';
    if (mode === 'idle') stopRec();
    else if (!running) startSession('wake');
    else if (kind === 'wake') cmdFrom = Infinity;
  }
  setInterval(() => { if (running && fails) fails = Math.max(0, fails - 1); }, 20000);

  function onResult(e) {
    fails = 0;
    if (speaking || busy) { cmdFrom = e.results.length; return; }
    if (cmdFrom === Infinity) cmdFrom = e.results.length - (e.results[e.results.length - 1].isFinal ? 0 : 1);
    const textOf = (from, alt = 0) => { let s = ''; for (let i = from; i < e.results.length; i++) s += (e.results[i][Math.min(alt, e.results[i].length - 1)] || e.results[i][0]).transcript + ' '; return s.trim(); };
    const isFinal = e.results[e.results.length - 1].isFinal;

    if (mode === 'wake') {
      let hit = null;
      for (let a = 0; a < 3 && !hit; a++) { const w = C.stripWake(textOf(cmdFrom, a)); if (w.woke) hit = w; }
      if (!hit) { if (isFinal) cmdFrom = e.results.length; return; }
      mode = 'command'; open(); chime(true); vibrate(20);
      setState('listen', 'Dinliyorum'); $('jvText').innerHTML = hit.rest ? esc(hit.rest) : '<em>Söyle…</em>';
      heard = hit.rest; handled = false; armIdle();
      if (hit.rest && isFinal) return finish(hit.rest);
      return;
    }
    if (mode !== 'command') return;
    // tüm alternatifler içinde komut olarak anlaşılanı tercih et
    let t = C.stripWake(textOf(cmdFrom)).rest;
    if (isFinal) for (let a = 1; a < 3; a++) {
      const alt = C.stripWake(textOf(cmdFrom, a)).rest;
      if (alt && C.parse(t).type === 'unknown' && C.parse(alt).type !== 'unknown') { t = alt; break; }
    }
    if (!t) return;
    heard = t; $('jvText').textContent = t; armIdle();
    clearTimeout(silenceT);
    if (isFinal) finish(t);
    else if (kind === 'wake') silenceT = setTimeout(() => finish(heard), 2500); // sürekli oturumda "final" gecikebilir
  }
  function noHear() { setState('err', 'Duyamadım'); $('jvText').innerHTML = '<em>Bir şey duymadım, tekrar dokun</em>'; closeLater(2200); }
  function armIdle() {
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (mode !== 'command' || busy) return; if (heard) return finish(heard); noHear(); stopRec(); afterCommand(); }, 10000);
  }
  function finish(text) {
    clearTimeout(silenceT); clearTimeout(idleT);
    if (busy || handled) return;
    handled = true;
    if (kind === 'cmd' && running) { try { rec.stop(); } catch {} }
    else if (running) cmdFrom = Infinity;
    run(text);
  }

  /* ---------- komutları çalıştır ---------- */
  const norm = s => C.normalize ? C.normalize(String(s)) : String(s).toLocaleLowerCase('tr');
  const fmtWhen = (start, allDay) => dayLabel(start) + (allDay ? ' · tüm gün' : ' · ' + pad2(new Date(start).getHours()) + ':' + pad2(new Date(start).getMinutes()));
  const spokenTime = ms => { const d = new Date(ms); return d.getHours() + (d.getMinutes() ? ' ' + pad2(d.getMinutes()) : ''); };

  async function run(text) {
    busy = true; open(); $('jvText').textContent = text; setState('think', 'Düşünüyorum');
    let a; try { a = C.parse(text, Date.now()); } catch { a = { type: 'unknown' }; }
    let reply = '', keepOpen = 2600;
    try {
      switch (a.type) {
        case 'empty': setState('listen', 'Dinliyorum'); busy = false; mode = 'command'; heard = ''; handled = false; if (!running) startSession('cmd'); armIdle(); return;
        case 'todo.add': {
          const t = addTodo(a.text);
          undoFn = () => { todos = todos.filter(x => x.id !== t.id); syncTodos(); renderTodos(); return 'İş listeden çıkarıldı'; };
          card('todo', a.text, 'Yapılacaklara eklendi', true); reply = 'Listeye ekledim';
          break;
        }
        case 'todo.done': {
          const qy = norm(a.query), open_ = todos.filter(t => !t.done);
          const score = t => { const n = norm(t.text); if (n === qy) return 3; if (n.includes(qy) || qy.includes(n)) return 2; const ws = qy.split(' ').filter(x => x.length > 2); return ws.filter(w => n.includes(w.slice(0, Math.max(3, w.length - 3)))).length / Math.max(1, ws.length); };
          const best = open_.map(t => [t, score(t)]).sort((x, y) => y[1] - x[1])[0];
          if (!best || best[1] < .5) { card('q', 'Bulamadım', `“${a.query}” listede yok`); reply = 'Listede bunu bulamadım'; break; }
          const t = best[0]; t.done = true; syncTodos(); renderTodos();
          undoFn = () => { t.done = false; syncTodos(); renderTodos(); return 'Geri açıldı'; };
          card('todo', t.text, 'Tamamlandı olarak işaretlendi', true); reply = 'Tamamlandı, aferin';
          break;
        }
        case 'todo.list': {
          const o = todos.filter(t => !t.done);
          card('todo', o.length ? o.length + ' açık iş' : 'Liste boş', o.slice(0, 3).map(t => t.text).join(' · '));
          reply = o.length ? `${o.length} işin var: ` + o.slice(0, 4).map(t => t.text).join(', ') : 'Yapılacaklar listen boş';
          keepOpen = 4500; break;
        }
        case 'event.add': {
          const r = await post('/api/event', { title: a.title, start: a.start, end: a.end, allDay: a.allDay });
          if (!r.ok) throw new Error('event');
          const ev = await r.json();
          undoFn = async () => { await post('/api/event/delete', { id: ev.id }); return 'Etkinlik silindi'; };
          card('cal', a.title, fmtWhen(a.start, a.allDay) + (a.guessedPm ? ' · öğleden sonra varsaydım' : ''), true);
          reply = `${dayLabel(a.start)} ${a.allDay ? '' : 'saat ' + spokenTime(a.start) + ' için '}takvime ekledim`;
          keepOpen = 3600; break;
        }
        case 'event.list': {
          const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() + a.day);
          const d1 = d0.getTime() + 864e5, list = cal.filter(e => e.start < d1 && e.end > Math.max(d0.getTime(), Date.now()));
          const when = a.day ? 'Yarın' : 'Bugün';
          card('cal', list.length ? `${when} ${list.length} etkinlik` : `${when} boşsun`, list.slice(0, 3).map(e => (e.allDay ? '' : pad2(new Date(e.start).getHours()) + ':' + pad2(new Date(e.start).getMinutes()) + ' ') + e.title).join(' · '));
          reply = list.length ? `${when} ${list.length} etkinlik var. ` + list.slice(0, 4).map(e => (e.allDay ? '' : 'saat ' + spokenTime(e.start) + ' ') + e.title).join(', ') : `${when} takviminde bir şey yok`;
          goPage('day'); keepOpen = 5000; break;
        }
        case 'event.next': {
          const e = cal.find(x => x.end > Date.now() && !x.allDay);
          if (!e) { card('cal', 'Yaklaşan etkinlik yok', ''); reply = 'Yaklaşan bir etkinliğin yok'; break; }
          card('cal', e.title, fmtWhen(e.start, false)); reply = `Sıradaki: ${e.title}, ${dayLabel(e.start).toLocaleLowerCase('tr')} saat ${spokenTime(e.start)}`;
          keepOpen = 4000; break;
        }
        case 'media': {
          const names = { playpause: 'Oynat / duraklat', next: 'Sonraki parça', prev: 'Önceki parça', volup: 'Ses açıldı', voldown: 'Ses kısıldı', mute: 'Sessiz' };
          if (a.key === 'volup' || a.key === 'voldown') for (let i = 0; i < 4; i++) await sendKey(a.key); else await sendKey(a.key);
          card('media', names[a.key], media && media.title ? media.title : ''); reply = ''; keepOpen = 1600;
          break;
        }
        case 'focus': {
          if (a.action === 'start') { focusStart(); reply = `Odak başladı, ${Math.round(P.len / 60)} dakika`; card('focus', 'Odak başladı', Math.round(P.len / 60) + ' dakika'); }
          else { focusStop(); reply = 'Sayacı durdurdum'; card('focus', 'Odak duraklatıldı', ''); }
          goPage('focus'); break;
        }
        case 'time': { const n = new Date(); reply = `Saat ${n.getHours()} ${pad2(n.getMinutes())}`; card('time', pad2(n.getHours()) + ':' + pad2(n.getMinutes()), dayLabel(n.getTime())); break; }
        case 'weather': {
          if (!wxNow) { card('wx', 'Hava durumu henüz yok', ''); reply = 'Hava durumu bilgisi henüz gelmedi'; break; }
          card('wx', wxNow.t + '° · ' + wxNow.c, 'Hissedilen ' + wxNow.feels + '°' + (wxNow.city ? ' · ' + wxNow.city : ''));
          reply = `${wxNow.city ? wxNow.city + ' için ' : ''}hava ${wxNow.t} derece, ${wxNow.c.toLocaleLowerCase('tr')}`; break;
        }
        case 'undo': {
          if (!undoFn) { card('undo', 'Geri alınacak bir şey yok', ''); reply = 'Geri alınacak bir şey yok'; break; }
          const msg = await undoFn(); undoFn = null; card('undo', msg, ''); reply = msg; break;
        }
        default:
          setState('err', 'Anlamadım'); card('q', 'Bunu anlamadım', 'Örnek: ' + HINTS[Math.floor(Math.random() * HINTS.length)].replace(/[“”]/g, ''));
          chime(false); reply = 'Bunu anlayamadım'; keepOpen = 4200;
      }
    } catch {
      setState('err', 'Hata'); card('q', 'Bilgisayara ulaşılamadı', 'Bağlantıyı kontrol et'); reply = 'Bilgisayara ulaşamadım';
    }
    if (a.type !== 'unknown' && !jv.classList.contains('err')) { vibrate(15); setState('', 'Tamam'); }
    if (reply) await say(reply);
    if (!jv.classList.contains('err')) setState('', 'Tamam');
    busy = false; afterCommand();
    closeLater(keepOpen);
  }

  /* =====================================================================
     BİLGİSAYAR MOTORU: mikrofon sesi bip çalmadan bilgisayara akar,
     orada openWakeWord ("hey jarvis") + Whisper (Türkçe) çalışır.
     ===================================================================== */
  const PC = { ws: null, stream: null, ctx: null, pendingPush: false, releaseT: 0, idleT: 0 };
  const pcOn = () => !!(server.voice && server.voice.status !== 'off' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);
  const pcReady = () => pcOn() && server.voice.status === 'ready';

  let micLock = null;
  function pcMic() { return micLock || (micLock = pcMicOpen().finally(() => { micLock = null; })); }  // aynı anda iki kez açılmasın
  async function pcMicOpen() {
    clearTimeout(PC.releaseT);
    if (PC.stream) { try { await PC.ctx.resume(); } catch {} return true; }
    try {
      PC.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { lastErr = e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture'; note(); return false; }
    lastErr = '';
    const ctx = PC.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const code = 'class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("mp-cap",P)';
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const src = ctx.createMediaStreamSource(PC.stream), node = new AudioWorkletNode(ctx, 'mp-cap'), mute = ctx.createGain();
    mute.gain.value = 0; src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    // 16 kHz'e indir (kutu filtresiyle ortalama), 100 ms'lik parçalar halinde yolla
    const ratio = ctx.sampleRate / 16000, out = new Int16Array(1600);
    let n = 0, sum = 0, cnt = 0, acc = 0;
    node.port.onmessage = ev => {
      const x = ev.data;
      for (let i = 0; i < x.length; i++) {
        sum += x[i]; cnt++; acc += 1;
        if (acc >= ratio) {
          acc -= ratio; const v = Math.max(-1, Math.min(1, sum / cnt)); out[n++] = v * 32767 | 0; sum = cnt = 0;
          if (n === out.length) { if (PC.ws && PC.ws.readyState === 1 && !speaking && !busy) PC.ws.send(out.slice(0).buffer); n = 0; }
        }
      }
    };
    try { await ctx.resume(); } catch {}
    mic.classList.toggle('wake', !!S.wake);
    return true;
  }
  function pcRelease() {
    if (S.wake) return;
    if (PC.stream) PC.stream.getTracks().forEach(t => t.stop());
    try { PC.ctx && PC.ctx.close(); } catch {}
    PC.stream = PC.ctx = null; mic.classList.remove('wake');
  }
  function pcWS() {
    if (PC.ws && PC.ws.readyState <= 1) return;
    const u = new URL(ep('/voice'), location.href); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = PC.ws = new WebSocket(u); ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ws.send(S.wake ? 'wake:1' : 'wake:0'); if (PC.pendingPush) { PC.pendingPush = false; ws.send('push'); } };
    ws.onmessage = e => { try { pcEvent(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { if (PC.ws === ws) PC.ws = null; if (S.wake && pcOn()) setTimeout(pcWS, 2500); };
  }
  const wsSend = m => { if (PC.ws && PC.ws.readyState === 1) PC.ws.send(m); };
  function pcEvent(ev) {
    if (ev.ev === 'status' || ev.ev === 'ready') { server.voice = Object.assign(server.voice || {}, ev.ev === 'ready' ? { status: 'ready', model: ev.model, device: ev.device } : ev); note(); return; }
    if (busy) return;
    if (ev.ev === 'wake') {
      mode = 'command'; open(); chime(true); vibrate(20);
      setState('listen', 'Dinliyorum'); $('jvText').innerHTML = '<em>Söyle…</em>'; pcIdle();
    } else if (ev.ev === 'text') {
      clearTimeout(PC.idleT);
      if (ev.text === PC.lastText && Date.now() - PC.lastAt < 4000) return;   // aynı cümle iki kez gelirse bir kez çalıştır
      PC.lastText = ev.text; PC.lastAt = Date.now();
      open(); mode = 'command'; run(ev.text);
    } else if (ev.ev === 'none') {
      clearTimeout(PC.idleT); if (mode === 'command') { noHear(); afterCommand(); }
    } else if (ev.ev === 'error') { toast('Ses servisi: ' + ev.msg); }
  }
  function pcIdle() { clearTimeout(PC.idleT); PC.idleT = setTimeout(() => { if (mode === 'command' && !busy) { wsSend('cancel'); noHear(); afterCommand(); } }, 16000); }
  async function pcListen() {
    mode = 'command'; chime(true); setState('listen', 'Dinliyorum'); $('jvText').innerHTML = '<em>Söyle…</em>';
    if (!(await pcMic())) { setState('err', 'İzin yok'); $('jvText').textContent = 'Mikrofona erişemiyorum'; $('jvHint').textContent = noteText(); return; }
    pcWS();
    if (PC.ws.readyState === 1) wsSend('push'); else PC.pendingPush = true;
    pcIdle();
  }
  async function pcWake(on) {
    if (on) { if (!(await pcMic())) { S.wake = false; save(); renderSettings(); toast('Mikrofon izni yok'); return; } pcWS(); wsSend('wake:1'); mic.classList.add('wake'); }
    else { wsSend('wake:0'); mic.classList.remove('wake'); PC.releaseT = setTimeout(pcRelease, 1000); }
  }
  function pcAfter() {
    mode = S.wake ? 'wake' : 'idle';
    if (!S.wake) { clearTimeout(PC.releaseT); PC.releaseT = setTimeout(pcRelease, 30000); }  // art arda komut için mikrofonu biraz açık tut
  }
  // sayfa açılınca ve servis durumu değişince
  let pcBooted = false;
  function voiceStatus(st) {
    if (st) server.voice = st;
    note();
    if (!pcBooted && pcOn() && S.wake) {
      pcBooted = true;
      const go = () => pcWake(true);
      // tarayıcı ses için bir dokunuş ister
      document.addEventListener('pointerdown', go, { once: true }); go();
    }
  }

  /* ---------- düğmeler ---------- */
  function listenNow() {
    open(); clearTimeout(closeT);
    if (pcReady() || (pcOn() && !supported)) { heard = ''; handled = false; return pcListen(); }
    if (!supported) { setState('err', 'Yazarak komut ver'); $('jvText').innerHTML = '<em>Ses kapalı</em>'; setTimeout(() => $('jvIn').focus(), 300); return; }
    mode = 'command'; chime(true); setState('listen', 'Dinliyorum'); $('jvText').innerHTML = '<em>Söyle…</em>';
    heard = ''; handled = false;
    if (running) { if (kind === 'wake') { try { rec.abort(); } catch {} } } else startSession('cmd');
    armIdle();
  }
  mic.onclick = () => { vibrate(10); jv.classList.contains('show') ? close() : listenNow(); };
  $('jvClose').onclick = close;
  $('jvUndo').onclick = async () => { if (!undoFn) return; const m = await undoFn(); undoFn = null; card('undo', m, ''); closeLater(1800); };
  $('jvForm').onsubmit = e => { e.preventDefault(); const v = $('jvIn').value.trim(); if (!v) return; $('jvIn').value = ''; clearTimeout(idleT); mode = 'command'; run(v); };
  $('jvIn').addEventListener('focus', () => { clearTimeout(closeT); clearTimeout(idleT); });
  jv.addEventListener('pointerdown', e => { if (e.target === jv) close(); });

  function setWake(on) {
    if (pcOn()) { S.wake = !!on; save(); note(); stopRec(); mode = on ? 'wake' : 'idle'; pcWake(!!on); if (on) toast('“Hey Jarvis” bilgisayarda dinleniyor'); return; }
    S.wake = !!on && supported; save(); note();
    if (on && !supported) { toast('Ses için güvenli bağlantı gerekli (README)'); S.wake = false; save(); renderSettings(); return; }
    if (S.wake) { if (mode === 'idle') mode = 'wake'; lastErr = ''; fails = 0; if (!running) startSession('wake'); toast('“Hey Jarvis” dinleniyor'); }
    else if (!jv.classList.contains('show')) { mode = 'idle'; stopRec(); }
  }
  // sekme arka plandayken tanıma zaten durur; öne gelince yeniden başlat
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || mode !== 'wake') return;
    if (pcOn()) { pcWake(true); return; }
    if (!running) { fails = 0; startSession('wake'); }
  });

  window.Jarvis = { setWake, note, run, listen: listenNow, close, voiceStatus };
  note();
  // Sunucunun ses servisi durumu "hello" ile gelir; gelmeden Chrome tanıyıcısını başlatma (bip yapmasın)
  setTimeout(() => { if (S.wake && supported && !pcOn() && !running) { mode = 'wake'; startSession('wake'); } }, 2500);
})();

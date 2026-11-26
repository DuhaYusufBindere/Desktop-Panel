// Ses köprüsü: telefonun mikrofon sesini WebSocket ile alır, voice/service.py'ye (Whisper + openWakeWord) aktarır,
// çıkan olayları ("wake", "text" …) aynı WebSocket'ten telefona geri yollar. Bağımlılık yok: WebSocket elle yazıldı.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

module.exports = function voiceBridge({ root, onStatus }) {
  const py = process.platform === 'win32' ? path.join(root, 'voice', '.venv', 'Scripts', 'python.exe') : path.join(root, 'voice', '.venv', 'bin', 'python');
  const script = path.join(root, 'voice', 'service.py');
  const installed = fs.existsSync(py) && fs.existsSync(script);
  let child = null, status = installed ? 'idle' : 'off', info = {}, sock = null, restarts = 0;

  const setStatus = (s, extra = {}) => { status = s; Object.assign(info, extra); onStatus && onStatus(state()); };
  const state = () => ({ status, ...info });

  function start() {
    if (!installed || child) return;
    setStatus('loading');
    child = spawn(py, ['-u', script], { cwd: path.dirname(script), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString('utf8'); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.ev === 'ready') { restarts = 0; setStatus('ready', { model: ev.model, device: ev.device, wake: ev.wake }); console.log(`  Ses servisi hazır: ${ev.model} (${ev.device})`); if (sock) control('W', sock.wake ? '1' : '0'); }
        else if (ev.ev === 'log') console.log('  [ses] ' + ev.msg);
        else if (ev.ev === 'error') console.log('  [ses] hata: ' + ev.msg);
        if (sock) wsSend(sock, JSON.stringify(ev));
      }
    });
    child.stderr.on('data', d => { const s = d.toString(); if (/error|Traceback/i.test(s)) console.log('  [ses] ' + s.trim().split('\n').pop()); });
    child.on('exit', code => {
      child = null;
      if (status !== 'stopping') { setStatus('error', { msg: 'ses servisi kapandı (' + code + ')' }); if (restarts++ < 3) setTimeout(start, 3000 * restarts); }
    });
    child.stdin.on('error', () => {});
  }
  function frame(kind, payload) {
    if (!child || status !== 'ready') return;
    const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const h = Buffer.alloc(5); h.write(kind, 0, 'latin1'); h.writeUInt32LE(b.length, 1);
    child.stdin.write(Buffer.concat([h, b]));
  }
  const control = (k, v) => frame(k, v || '');

  // ---------------- WebSocket (RFC 6455, yalnızca gereken kısım) ----------------
  function wsSend(s, text) {
    if (s.destroyed) return;
    const p = Buffer.from(text); let h;
    if (p.length < 126) h = Buffer.from([0x81, p.length]);
    else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
    s.write(Buffer.concat([h, p]));
  }
  function upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    if (sock && sock !== socket) { try { sock.end(); } catch {} }   // tek telefon dinler
    sock = socket; socket.wake = false;
    start();
    wsSend(socket, JSON.stringify({ ev: 'status', ...state() }));
    let acc = Buffer.alloc(0);
    socket.on('data', d => {
      acc = acc.length ? Buffer.concat([acc, d]) : d;
      while (acc.length >= 2) {
        const op = acc[0] & 0x0f, masked = acc[1] & 0x80; let len = acc[1] & 0x7f, off = 2;
        if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
        if (len > 1 << 20) return socket.destroy();
        const need = off + (masked ? 4 : 0) + len; if (acc.length < need) return;
        let p = acc.subarray(off + (masked ? 4 : 0), need);
        if (masked) { const m = acc.subarray(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
        acc = acc.subarray(need);
        if (op === 2) frame('A', p);
        else if (op === 1) {
          const t = p.toString();
          if (t === 'push') control('P'); else if (t === 'cancel') control('C');
          else if (t === 'wake:1' || t === 'wake:0') { socket.wake = t === 'wake:1'; control('W', socket.wake ? '1' : '0'); }
        } else if (op === 8) { try { socket.end(Buffer.from([0x88, 0])); } catch {} return; }
        else if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, p.length]), p]));
      }
    });
    const done = () => { if (sock === socket) { sock = null; control('W', '0'); control('C'); } };
    socket.on('close', done); socket.on('error', done);
  }
  function stop() { if (child) { status = 'stopping'; try { child.kill(); } catch {} } }
  // servisi baştan yükle ki ilk komut beklemesin
  if (installed) setTimeout(start, 1500);
  return { upgrade, state, stop, installed };
};

// Küçük QR üretici (bayt modu, hata düzeltme L, sürüm 1–6 → en fazla 134 bayt). Hem Node'da hem tarayıcıda çalışır.
(function (root) {
  const EXP = new Array(512), LOG = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsEnc(data, n) {
    const g = rsGen(n), res = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ res.shift(); res.push(0);
      if (f) for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], f);
    }
    return res;
  }

  // [sürüm, veri kod sözcüğü, blok başına EC, blok sayısı]
  const VERS = [[1, 19, 7, 1], [2, 34, 10, 1], [3, 55, 15, 1], [4, 80, 20, 1], [5, 108, 26, 1], [6, 136, 18, 2]];

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const ver = VERS.find(v => bytes.length <= v[1] - 2);
    if (!ver) throw new Error('QR için metin çok uzun');
    const [v, dataCw, ecPer, blocks] = ver;
    const size = 17 + 4 * v;

    // veri bitleri
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, 8); bytes.forEach(b => put(b, 8));
    put(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

    // bloklar + EC + serpiştirme
    const per = dataCw / blocks, dBlocks = [], eBlocks = [];
    for (let b = 0; b < blocks; b++) { const d = data.slice(b * per, (b + 1) * per); dBlocks.push(d); eBlocks.push(rsEnc(d, ecPer)); }
    const all = [];
    for (let i = 0; i < per; i++) dBlocks.forEach(d => all.push(d[i]));
    for (let i = 0; i < ecPer; i++) eBlocks.forEach(e => all.push(e[i]));

    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (xx, yy, dark) => { mod[yy][xx] = dark; fn[yy][xx] = true; };

    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (v >= 2) {
      const p = size - 7;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(p + dx, p + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    const drawFormat = mask => {
      const d = (1 << 3) | mask; // hata düzeltme L = 01
      let rem = d << 10;
      for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
      const f = ((d << 10) | (rem & 0x3ff)) ^ 0x5412;
      const bit = i => ((f >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, true);
    };
    drawFormat(0);

    // veri yerleşimi
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const xx = right - j, up = ((right + 1) & 2) === 0, yy = up ? size - 1 - vert : vert;
        if (!fn[yy][xx] && k < all.length * 8) { mod[yy][xx] = ((all[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }

    const masks = [
      (a, b) => (a + b) % 2 === 0, (a, b) => b % 2 === 0, (a, b) => a % 3 === 0, (a, b) => (a + b) % 3 === 0,
      (a, b) => (Math.floor(a / 3) + Math.floor(b / 2)) % 2 === 0, (a, b) => ((a * b) % 2) + ((a * b) % 3) === 0,
      (a, b) => (((a * b) % 2) + ((a * b) % 3)) % 2 === 0, (a, b) => (((a + b) % 2) + ((a * b) % 3)) % 2 === 0,
    ];
    const applyMask = m => { for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) if (!fn[yy][xx] && masks[m](xx, yy)) mod[yy][xx] = !mod[yy][xx]; };

    function penalty() {
      let p = 0;
      const line = get => {
        let run = 1;
        for (let i = 1; i < size; i++) {
          if (get(i) === get(i - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
        const s = []; for (let i = 0; i < size; i++) s.push(get(i) ? 1 : 0);
        const str = s.join('');
        for (const pat of ['10111010000', '00001011101']) { let at = -1; while ((at = str.indexOf(pat, at + 1)) >= 0) p += 40; }
      };
      for (let yy = 0; yy < size; yy++) line(i => mod[yy][i]);
      for (let xx = 0; xx < size; xx++) line(i => mod[i][xx]);
      let dark = 0;
      for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
        if (mod[yy][xx]) dark++;
        if (xx < size - 1 && yy < size - 1 && mod[yy][xx] === mod[yy][xx + 1] && mod[yy][xx] === mod[yy + 1][xx] && mod[yy][xx] === mod[yy + 1][xx + 1]) p += 3;
      }
      p += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
      return p;
    }

    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty();
      if (p < bestP) { bestP = p; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return { size, get: (a, b) => mod[b][a] };
  }

  function toSVG(text, opt = {}) {
    const q = encode(text), m = opt.margin ?? 2, n = q.size + m * 2;
    let d = '';
    for (let yy = 0; yy < q.size; yy++) for (let xx = 0; xx < q.size; xx++) if (q.get(xx, yy)) d += `M${xx + m} ${yy + m}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${opt.bg || '#fff'}"/><path d="${d}" fill="${opt.fg || '#000'}"/></svg>`;
  }

  // Terminal için yarım blok karakterlerle (açık zemin üzerinde koyu = koyu terminalde ters çevrilmiş görünür)
  function toAscii(text) {
    const q = encode(text), m = 2, n = q.size + m * 2;
    const at = (xx, yy) => { const a = xx - m, b = yy - m; return a >= 0 && b >= 0 && a < q.size && b < q.size && q.get(a, b); };
    let out = '';
    for (let yy = 0; yy < n; yy += 2) {
      for (let xx = 0; xx < n; xx++) {
        const t = at(xx, yy), b = at(xx, yy + 1);
        out += t && b ? ' ' : t ? '▄' : b ? '▀' : '█';
      }
      out += '\n';
    }
    return out;
  }

  const api = { encode, toSVG, toAscii };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QR = api;
})(typeof self !== 'undefined' ? self : globalThis);

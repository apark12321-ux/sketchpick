// 스케치픽 엔진 — 사진을 "편집 가능한 벡터 획"으로 바꾼다.
// 모든 결과물은 획(stroke) 배열: { id, tool:'pen'|'wash', color, width, opacity, pts:[[x,y,pressure],...] }

export const DOC_LONG = 2000;
let _seq = 0;
export const uid = () => 's' + Date.now().toString(36) + (++_seq).toString(36);
const tick = () => new Promise(r => setTimeout(r, 0));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

export function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export const DEFAULT_OPTS = { detail: 0.55, roughness: 0.5, hatching: true, wash: true, tone: 'original', ink: 'ink', seed: 7 };
export const INKS = { ink: '#24201c', sepia: '#5b3a22', navy: '#1e2d55', gray: '#55524e' };
export const INK_LABEL = { ink: '먹색', sepia: '세피아', navy: '네이비', gray: '연필 회색' };
export const TONE_LABEL = { original: '원본', warm: '따뜻하게', cool: '차갑게', pastel: '파스텔', vivid: '선명하게', mono: '흑백' };

// ───────── 설명 문장 → 스타일 옵션 (키워드 해석) ─────────
export function parseStyle(text = '', base = DEFAULT_OPTS) {
  const o = { ...base };
  const t = text.replace(/\s+/g, ' ');
  const has = (...ws) => ws.some(w => t.includes(w));
  const notes = [];
  if (has('선만', '펜만', '라인만', '채색 없', '색 없', '채색은 빼', '채색 빼', '펜화')) { o.wash = false; notes.push('채색 없이 선만'); }
  else if (has('수채', '채색', '물감', '컬러')) { o.wash = true; notes.push('수채 채색'); }
  if (has('흑백', '모노', '무채색')) { o.tone = 'mono'; notes.push('흑백 톤'); }
  else if (has('따뜻', '노을', '석양', '가을', '햇살', '오후')) { o.tone = 'warm'; notes.push('따뜻한 톤'); }
  else if (has('차갑', '차가운', '시원', '겨울', '새벽', '푸른')) { o.tone = 'cool'; notes.push('차가운 톤'); }
  else if (has('파스텔', '은은', '연한 색', '부드러운 색')) { o.tone = 'pastel'; notes.push('파스텔 톤'); }
  else if (has('선명', '쨍', '강렬', '비비드')) { o.tone = 'vivid'; notes.push('선명한 색'); }
  if (has('세피아', '갈색 펜', '갈색 선', '빈티지')) { o.ink = 'sepia'; notes.push('세피아 펜'); }
  else if (has('네이비', '파란 펜', '파란 선', '남색')) { o.ink = 'navy'; notes.push('네이비 펜'); }
  else if (has('연필', '회색 선')) { o.ink = 'gray'; notes.push('연필 느낌'); }
  if (has('거칠', '러프', '자유롭', '속도감', '휘갈', '과감')) { o.roughness = 0.85; notes.push('거친 선'); }
  else if (has('깔끔', '정교', '반듯', '정확')) { o.roughness = 0.2; notes.push('깔끔한 선'); }
  if (has('세밀', '디테일 많', '자세', '꼼꼼')) { o.detail = 0.82; notes.push('세밀하게'); }
  else if (has('단순', '간결', '심플', '디테일 적', '미니멀')) { o.detail = 0.28; notes.push('간결하게'); }
  if (has('해칭 없', '명암 없', '명암은 빼', '명암 빼', '그림자 없')) { o.hatching = false; notes.push('명암 없이'); }
  else if (has('해칭', '명암', '그림자', '음영')) { o.hatching = true; notes.push('해칭 명암'); }
  o.notes = notes;
  return o;
}

// ───────── 색 ─────────
export function hexToRgb(h) {
  h = (h || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const clamp01 = v => Math.max(0, Math.min(1, v));
function towardHue(h, target, k) { let d = ((target - h + 540) % 360) - 180; return h + d * k; }
const _toneCache = new Map();
export function applyTone(hex, tone) {
  if (!tone || tone === 'original') return hex;
  const key = hex + tone; if (_toneCache.has(key)) return _toneCache.get(key);
  let [h, s, l] = rgbToHsl(...hexToRgb(hex));
  if (tone === 'warm') { h = towardHue(h, 32, s > 0.08 ? 0.28 : 0); s = clamp01(s * 1.05 + 0.08); }
  else if (tone === 'cool') { h = towardHue(h, 212, s > 0.08 ? 0.28 : 0); s = clamp01(s * 1.05 + 0.06); if (s < 0.2) h = 212; }
  else if (tone === 'pastel') { s = s * 0.6; l = l + (1 - l) * 0.38; }
  else if (tone === 'vivid') { s = clamp01(s * 1.45 + 0.05); }
  else if (tone === 'mono') { s = 0; }
  else if (tone === 'sepia') { h = 30; s = 0.42; }
  const out = rgbToHex(...hslToRgb(h, s, l));
  _toneCache.set(key, out); return out;
}

// ───────── 기하 유틸 ─────────
export function polyLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; }
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// 일정 간격으로 다시 찍기 (압력값 보간 포함)
export function resample(p, step) {
  if (p.length < 2) return p.slice();
  const out = [p[0].slice()];
  let carry = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - carry;
    while (d <= L) {
      const t = d / L;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 1) + ((b[2] ?? 1) - (a[2] ?? 1)) * t]);
      d += step;
    }
    carry = L - (d - step);
  }
  const last = p[p.length - 1];
  const lo = out[out.length - 1];
  if (Math.hypot(last[0] - lo[0], last[1] - lo[1]) > step * 0.3) out.push(last.slice());
  return out;
}
function extendEnds(p, a, b) {
  const n = p.length;
  let dx = p[0][0] - p[1][0], dy = p[0][1] - p[1][1], d = Math.hypot(dx, dy) || 1;
  p[0] = [p[0][0] + dx / d * a, p[0][1] + dy / d * a];
  dx = p[n - 1][0] - p[n - 2][0]; dy = p[n - 1][1] - p[n - 2][1]; d = Math.hypot(dx, dy) || 1;
  p[n - 1] = [p[n - 1][0] + dx / d * b, p[n - 1][1] + dy / d * b];
}

// 폴리라인(문서 좌표)을 손맛 있는 펜 획으로
export function sketchPolyline(p, R, rough, color, width, opt = {}) {
  p = p.map(q => [q[0], q[1]]);
  if (p.length < 2) return null;
  if (opt.overshoot !== false && p.length >= 2) extendEnds(p, (2 + R() * 10) * rough, (2 + R() * 10) * rough);
  const q = resample(p, opt.step || 7);
  if (q.length < 2) return null;
  const amp = rough * (opt.wobble ?? 1.4), ph = R() * 6.283, fr = 0.008 + R() * 0.01;
  const n = q.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = q[Math.max(0, i - 1)], b = q[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const d = Math.hypot(tx, ty) || 1; tx /= d; ty /= d;
    const s = i * 7;
    const off = amp * Math.sin(ph + s * fr) + amp * 0.5 * Math.sin(ph * 2 + s * fr * 2.3);
    const t = n > 1 ? i / (n - 1) : 0.5;
    const taper = Math.min(1, t / 0.12, (1 - t) / 0.12);
    let pr = 0.35 + 0.65 * taper; pr *= 0.88 + 0.12 * Math.sin(ph + i * 0.3);
    out.push([r1(q[i][0] - ty * off), r1(q[i][1] + tx * off), r2(pr)]);
  }
  return { id: uid(), tool: 'pen', color, width: r2(width), opacity: opt.opacity ?? 1, pts: out };
}
// 폴리라인을 수채 붓 획으로
export function washPolyline(p, color, width, opacity = 0.32) {
  const q = resample(p.map(v => [v[0], v[1], 1]), 24);
  return { id: uid(), tool: 'wash', color, width: r1(width), opacity, pts: q.map(v => [r1(v[0]), r1(v[1]), 1]) };
}

// ───────── 이미지 처리 ─────────
function toGray(d, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
  return g;
}
function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1); let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let j = -r; j <= r; j++) { const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j; a += src[row + xx] * k[j + r]; }
      tmp[row + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let j = -r; j <= r; j++) { const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j; a += tmp[yy * w + x] * k[j + r]; }
      out[y * w + x] = a;
    }
  }
  return out;
}
function canny(g, w, h, detail) {
  const N = w * h, mag = new Float32Array(N), dir = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
    const a = ((Math.atan2(gy, gx) * 180 / Math.PI) + 180) % 180;
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  const nms = new Float32Array(N); const vals = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i]; if (m < 0.02) continue;
    let a, b;
    switch (dir[i]) { case 0: a = mag[i - 1]; b = mag[i + 1]; break; case 1: a = mag[i - w - 1]; b = mag[i + w + 1]; break; case 2: a = mag[i - w]; b = mag[i + w]; break; default: a = mag[i - w + 1]; b = mag[i + w - 1]; }
    if (m >= a && m >= b) { nms[i] = m; vals.push(m); }
  }
  vals.sort((p, q) => p - q);
  let high = vals.length ? vals[Math.floor(vals.length * (0.8 - 0.34 * detail))] : 1;
  high = Math.max(high, 0.06); const low = high * 0.42;
  const E = new Uint8Array(N); const st = [];
  for (let i = 0; i < N; i++) if (nms[i] >= high) { E[i] = 1; st.push(i); }
  while (st.length) {
    const i = st.pop(); const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx; if (!E[j] && nms[j] >= low) { E[j] = 1; st.push(j); }
    }
  }
  return E;
}
const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ORDER = [0, 1, -1, 2, -2, 3, -3, 4];
function traceEdges(E, w, h, minLen) {
  const vis = new Uint8Array(w * h), out = [];
  const walk = (x, y, pts, d0) => {
    let ld = d0;
    for (;;) {
      let found = false;
      for (const o of ORDER) {
        const k = ((ld + o) % 8 + 8) % 8; const nx = x + NB[k][0], ny = y + NB[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (E[ni] && !vis[ni]) { vis[ni] = 1; pts.push([nx, ny]); x = nx; y = ny; ld = k; found = true; break; }
      }
      if (!found) break;
    }
  };
  for (let i = 0; i < w * h; i++) {
    if (!E[i] || vis[i]) continue;
    vis[i] = 1; const x = i % w, y = (i / w) | 0;
    const a = [[x, y]]; walk(x, y, a, 0);
    const b = []; walk(x, y, b, 4);
    const pts = b.reverse().concat(a);
    if (pts.length >= minLen) out.push(pts);
  }
  return out;
}

function hatch(lum, w, h, s, R, opts, ink) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < lum.length; i++) hist[Math.min(255, Math.max(0, (lum[i] * 255) | 0))]++;
  const q = f => { let acc = 0; const tgt = lum.length * f; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= tgt) return i / 255; } return 1; };
  const t1 = Math.min(0.36, q(0.12)), t2 = Math.min(0.2, q(0.035));
  const sp = 6, out = [], rough = opts.roughness, cap = 2600;
  const seg = (x0, y0, x1, y1) => {
    if (out.length >= cap) return;
    const L = Math.hypot(x1 - x0, y1 - y0); if (L < 4) return;
    let t = 0;
    while (t < L - 3 && out.length < cap) {
      const piece = Math.min(L - t, 16 + R() * 20);
      const a = t / L, b = (t + piece) / L;
      const j = () => (R() - 0.5) * 3 * rough;
      const P = [[(x0 + (x1 - x0) * a) * s + j(), (y0 + (y1 - y0) * a) * s + j()], [(x0 + (x1 - x0) * b) * s + j(), (y0 + (y1 - y0) * b) * s + j()]];
      const st = sketchPolyline(P, R, rough * 0.4, ink, 1.35, { overshoot: false, wobble: 0.6, step: 6, opacity: 0.8 });
      if (st) out.push(st);
      t += piece + 2 + R() * 3;
    }
  };
  const scan = (thr, cross) => {
    if (!cross) {
      for (let c = 0; c < w + h; c += sp) {
        let start = -1; const xa = Math.max(0, c - (h - 1)), xb = Math.min(w - 1, c);
        for (let x = xa; x <= xb; x++) {
          const y = c - x, dark = lum[y * w + x] < thr;
          if (dark && start < 0) start = x;
          if ((!dark || x === xb) && start >= 0) { const e = dark ? x : x - 1; if (e - start >= 4) seg(start, c - start, e, c - e); start = -1; }
        }
      }
    } else {
      for (let c = -(w - 1); c < h; c += sp + 1) {
        let start = -1; const xa = Math.max(0, -c), xb = Math.min(w - 1, h - 1 - c);
        for (let x = xa; x <= xb; x++) {
          const y = x + c, dark = lum[y * w + x] < thr;
          if (dark && start < 0) start = x;
          if ((!dark || x === xb) && start >= 0) { const e = dark ? x : x - 1; if (e - start >= 4) seg(start, start + c, e, e + c); start = -1; }
        }
      }
    }
  };
  scan(t1, false); scan(t2, true);
  return out;
}

function waterize(r, g, b) {
  let [h, s, l] = rgbToHsl(r, g, b);
  s = clamp01(s * 1.2 + 0.04); l = Math.min(0.88, l * 0.85 + 0.15);
  return rgbToHex(...hslToRgb(h, s, l));
}
function washLayer(img, iw, ih, docW, docH, R, opts) {
  const SL = 150;
  const sw = iw >= ih ? SL : Math.round(SL * iw / ih), sh = iw >= ih ? Math.round(SL * ih / iw) : SL;
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, sw, sh);
  const d = cx.getImageData(0, 0, sw, sh).data, N = sw * sh, K = 7;
  const lum = i => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => lum(a) - lum(b));
  const C = []; for (let j = 0; j < K; j++) { const i = idx[Math.floor((j + 0.5) / K * N)]; C.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]); }
  const lab = new Uint8Array(N);
  for (let it = 0; it < 9; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < N; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; let best = 0, bd = 1e9;
      for (let j = 0; j < K; j++) { const dd = (r - C[j][0]) ** 2 * 0.3 + (g - C[j][1]) ** 2 * 0.59 + (b - C[j][2]) ** 2 * 0.11; if (dd < bd) { bd = dd; best = j; } }
      lab[i] = best; const a = acc[best]; a[0] += r; a[1] += g; a[2] += b; a[3]++;
    }
    for (let j = 0; j < K; j++) if (acc[j][3]) C[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
  }
  // 3x3 다수결로 얼룩 정리
  const lab2 = new Uint8Array(N);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const cnt = new Uint8Array(K);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy)); cnt[lab[yy * sw + xx]]++; }
    let b = lab[y * sw + x]; for (let j = 0; j < K; j++) if (cnt[j] > cnt[b]) b = j; lab2[y * sw + x] = b;
  }
  const u = docW / sw, step = 2, width = step * u * 1.75;
  const ox = (R() - 0.5) * 16 * opts.roughness, oy = (R() - 0.5) * 12 * opts.roughness;
  const out = [];
  for (let j = 0; j < K; j++) {
    const [r, g, b] = C[j]; const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (L > 0.9 || L < 0.28) continue; // 밝은 곳은 종이 여백, 아주 어두운 곳은 펜·해칭에 맡김 (어반스케치 특징)
    const color = waterize(r, g, b), op = 0.42;
    for (let y = 1; y < sh; y += step) {
      let x = 0;
      while (x < sw) {
        if (lab2[y * sw + x] !== j) { x++; continue; }
        let x2 = x; while (x2 + 1 < sw && lab2[y * sw + x2 + 1] === j) x2++;
        if (R() > 0.06) {
          const X0 = (x + R() * 0.8) * u + ox, X1 = (x2 + 1 - R() * 0.8) * u + ox, Y = (y + 0.5) * u + oy;
          if (X1 - X0 > width * 0.6) {
            const n = Math.max(2, Math.ceil((X1 - X0) / 30)), pts = [];
            for (let k = 0; k < n; k++) { const t = k / (n - 1); pts.push([r1(X0 + (X1 - X0) * t), r1(Y + (R() - 0.5) * u * 0.5), 1]); }
            out.push({ id: uid(), tool: 'wash', g: j, color, width: r1(width * (0.9 + R() * 0.25)), opacity: op, pts });
          }
        }
        x = x2 + 1;
      }
    }
  }
  return out;
}

// ───────── 사진 → 스케치 ─────────
export async function photoToSketch(img, opts, onStage = () => {}) {
  const R = rng(opts.seed || 7);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const docW = iw >= ih ? DOC_LONG : Math.round(DOC_LONG * iw / ih);
  const docH = iw >= ih ? Math.round(DOC_LONG * ih / iw) : DOC_LONG;
  const WL = 900;
  const ww = iw >= ih ? WL : Math.round(WL * iw / ih), wh = iw >= ih ? Math.round(WL * ih / iw) : WL;
  const s = docW / ww;
  const c = document.createElement('canvas'); c.width = ww; c.height = wh;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, ww, wh);
  const data = cx.getImageData(0, 0, ww, wh).data;
  onStage('윤곽선 찾는 중'); await tick();
  const gray = toGray(data, ww, wh);
  const g2 = blur(gray, ww, wh, 1.1 + (1 - opts.detail) * 1.8);
  const E = canny(g2, ww, wh, opts.detail);
  onStage('선 긋는 중'); await tick();
  const chains = traceEdges(E, ww, wh, Math.round(10 + (1 - opts.detail) * 22));
  chains.sort((a, b) => b.length - a.length);
  const ink = INKS[opts.ink] || INKS.ink;
  const line = [];
  for (const ch of chains.slice(0, Math.round(500 + opts.detail * 1500))) {
    const p = rdp(ch, 0.9 + opts.roughness * 0.9).map(([x, y]) => [x * s, y * s]);
    if (p.length < 2 || polyLen(p) < 14) continue;
    const st = sketchPolyline(p, R, opts.roughness, ink, 2.6 * (0.8 + R() * 0.45));
    if (st) line.push(st);
  }
  let shade = [], color = [];
  if (opts.hatching) { onStage('명암 넣는 중'); await tick(); shade = hatch(blur(gray, ww, wh, 2.5), ww, wh, s, R, opts, ink); }
  if (opts.wash) { onStage('수채 채색 중'); await tick(); color = washLayer(img, iw, ih, docW, docH, R, opts); }
  return { width: docW, height: docH, line, shade, color };
}

// 스케치픽 브러시 엔진 — 펜슬 필압·기울기·속도를 받아 실제 화구처럼 그린다.
// 획 점 형식: [x, y, p(필압·속도 반영 0~1), t(펜 기울기 0~1)]

export const BRUSHES = {
  fineliner: { name: '파인라이너', short: '라이너', desc: '균일하고 단단한 잉크 선 · 건물 윤곽', size: 3, min: 0.5, max: 20, opacity: 1, color: '#24201c', palette: 'ink' },
  fountain: { name: '만년필', short: '만년필', desc: '긋는 방향 따라 굵기가 변하는 닙', size: 6, min: 1, max: 30, opacity: 1, color: '#1e2d55', palette: 'ink' },
  brushpen: { name: '붓펜', short: '붓펜', desc: '누르는 힘에 크게 반응 · 강약 표현', size: 10, min: 1, max: 50, opacity: 1, color: '#24201c', palette: 'ink' },
  pencil: { name: '연필', short: '연필', desc: '종이결이 살아남 · 눕히면 넓은 음영', size: 4, min: 1, max: 24, opacity: 0.9, color: '#3a3632', palette: 'ink' },
  charcoal: { name: '목탄', short: '목탄', desc: '거칠고 진한 질감 · 큰 명암', size: 16, min: 4, max: 80, opacity: 0.85, color: '#2a2622', palette: 'ink' },
  marker: { name: '마커', short: '마커', desc: '반투명 · 겹칠수록 진해지는 그림자', size: 20, min: 4, max: 90, opacity: 0.45, color: '#8a8f99', palette: 'wash' },
  watercolor: { name: '수채', short: '수채', desc: '물 번짐과 진한 가장자리 · 입자감', size: 44, min: 6, max: 220, opacity: 0.5, color: '#5b8fd1', palette: 'wash' },
  hatch: { name: '해칭', short: '해칭', desc: '긋는 길을 따라 빗금 명암이 생김', size: 26, min: 8, max: 120, opacity: 0.9, color: '#24201c', palette: 'ink' },
};
export const BRUSH_ORDER = ['fineliner', 'fountain', 'brushpen', 'pencil', 'charcoal', 'marker', 'watercolor', 'hatch'];

// ───────── 입력 필터: One Euro (떨림은 지우고 빠른 움직임은 그대로) ─────────
class LowPass { constructor() { this.y = null; } f(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; } }
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.02, dCutoff = 1) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.x = new LowPass(); this.dx = new LowPass(); this.t = null; this.prev = null; }
  alpha(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  filter(x, tMs) {
    if (this.t === null) { this.t = tMs; this.prev = x; this.dx.f(0, 1); return this.x.f(x, 1); }
    const dt = Math.max(1, tMs - this.t) / 1000; this.t = tMs;
    const d = this.dx.f((x - this.prev) / dt, this.alpha(this.dc, dt)); this.prev = x;
    return this.x.f(x, this.alpha(this.mc + this.beta * Math.abs(d), dt));
  }
}

// ───────── 곡선 보간 (Catmull-Rom) ─────────
// 구심형(centripetal) Catmull-Rom — 점 간격이 고르지 않아도 꼬임·뾰족함이 생기지 않음
function crc(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-4, 0.5);
  const t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3), tt = t1 + (t2 - t1) * t;
  const L = (a, b, ta, tb) => { const k = (tt - ta) / ((tb - ta) || 1e-6); return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; };
  const A1 = L(p0, p1, 0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  return L(L(A1, A2, 0, t2), L(A2, A3, t1, t3), t1, t2);
}
export function densify(P, step) {
  const n = P.length; if (n < 2) return P.map(p => p.slice());
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p1 = P[i], p2 = P[i + 1];
    const p0 = P[i - 1] || [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]], p3 = P[i + 2] || [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const Ln = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.max(1, Math.ceil(Ln / step));
    for (let k = 0; k < m; k++) {
      const t = k / m, [x, y] = Ln < 0.01 ? [p1[0], p1[1]] : crc(p0, p1, p2, p3, t);
      out.push([x, y, (p1[2] ?? .7) + ((p2[2] ?? .7) - (p1[2] ?? .7)) * t, (p1[3] || 0) + ((p2[3] || 0) - (p1[3] || 0)) * t]);
    }
  }
  out.push(P[n - 1].slice());
  return out;
}
function smoothArr(a, r) { if (r < 1) return a; const o = new Array(a.length); for (let i = 0; i < a.length; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - r); j <= Math.min(a.length - 1, i + r); j++) { s += a[j]; c++; } o[i] = s / c; } return o; }
function taper(n, i, len, k) { // 시작·끝을 붓처럼 가늘게
  const tail = Math.max(2, Math.min(n * 0.25, len));
  return Math.min(1, (i + 1) / tail * (1 - k) + k, (n - i) / tail * (1 - k) + k);
}

// 가변 굵기 리본(잉크 선)
function ribbon(g, D, W) {
  const n = D.length;
  if (n === 1) { g.beginPath(); g.arc(D[0][0], D[0][1], Math.max(0.3, W[0] / 2), 0, 7); g.fill(); return; }
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = D[Math.max(0, i - 3)], b = D[Math.min(n - 1, i + 3)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const d = Math.hypot(tx, ty) || 1; tx /= d; ty /= d;
    const r = Math.max(0.25, W[i] / 2);
    L.push([D[i][0] - ty * r, D[i][1] + tx * r]); R.push([D[i][0] + ty * r, D[i][1] - tx * r]);
  }
  g.beginPath(); g.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) g.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
  g.closePath(); g.fill();
  g.beginPath(); g.arc(D[0][0], D[0][1], Math.max(0.25, W[0] / 2), 0, 7); g.fill();
  g.beginPath(); g.arc(D[n - 1][0], D[n - 1][1], Math.max(0.25, W[n - 1] / 2), 0, 7); g.fill();
}

// ───────── 종이결(그레인) 패턴 ─────────
const grainCache = new Map();
function grainCanvas(kind) {
  if (grainCache.has(kind)) return grainCache.get(kind);
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), id = g.createImageData(S, S);
  let s = kind === 'charcoal' ? 99 : 7; const R = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  // 저주파 + 고주파 노이즈로 종이 요철 흉내
  const low = new Float32Array(S * S); const cell = kind === 'charcoal' ? 7 : 3;
  const gw = Math.ceil(S / cell) + 2; const grid = []; for (let i = 0; i < gw * gw; i++) grid.push(R());
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const gx = x / cell, gy = y / cell, x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
    const v = (a, b) => grid[(b % gw) * gw + (a % gw)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    low[y * S + x] = (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy;
  }
  for (let i = 0; i < S * S; i++) {
    const n = low[i] * 0.55 + R() * 0.45;
    const thr = kind === 'charcoal' ? 0.42 : 0.3;
    const a = Math.max(0, Math.min(1, (n - thr) / (1 - thr) * 1.6));
    id.data[i * 4 + 3] = Math.round(255 * a);
  }
  g.putImageData(id, 0, 0); grainCache.set(kind, c); return c;
}
const patCache = new Map();
function grainPattern(g, kind, color) {
  const key = kind + color;
  let c = patCache.get(key);
  if (!c) {
    const base = grainCanvas(kind); c = document.createElement('canvas'); c.width = c.height = base.width;
    const cg = c.getContext('2d'); cg.fillStyle = color; cg.fillRect(0, 0, c.width, c.height);
    cg.globalCompositeOperation = 'destination-in'; cg.drawImage(base, 0, 0); patCache.set(key, c);
  }
  return g.createPattern(c, 'repeat');
}
function seedOf(id) { let h = 2166136261; for (let i = 0; i < (id || '').length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return h >>> 0; }
function rngFrom(seed) { let s = seed || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// 획을 임시 캔버스에 그린 뒤 한 번에 합성 (반투명 브러시가 자기 자신과 겹쳐 얼룩지지 않게)
function withTemp(g, bb, fn) {
  const T = g.getTransform(), sc = Math.max(0.05, Math.hypot(T.a, T.b));
  let [x0, y0, x1, y1] = bb; const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const w = Math.min(4096, Math.ceil(bw * sc)), h = Math.min(4096, Math.ceil(bh * sc));
  const k = Math.min(sc, w / bw, h / bh);
  const t = document.createElement('canvas'); t.width = Math.max(1, w); t.height = Math.max(1, h);
  const tg = t.getContext('2d'); tg.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  fn(tg);
  return () => g.drawImage(t, x0, y0, bw, bh);
}
function bboxOf(D, m) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of D) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; } return [x0 - m, y0 - m, x1 + m, y1 + m]; }
function strokePath(g, D) { g.beginPath(); g.moveTo(D[0][0], D[0][1]); if (D.length === 1) g.lineTo(D[0][0] + 0.01, D[0][1]); for (let i = 1; i < D.length; i++) g.lineTo(D[i][0], D[i][1]); }

// ───────── 브러시 렌더 ─────────
// 손에서 생기는 미세한 꺾임을 펴는 1-2-1 평활 (양 끝점은 고정)
function presmooth(P, passes) {
  let Q = P;
  for (let k = 0; k < passes; k++) Q = Q.map((p, i) => i === 0 || i === Q.length - 1 ? p : [(Q[i - 1][0] + 2 * p[0] + Q[i + 1][0]) / 4, (Q[i - 1][1] + 2 * p[1] + Q[i + 1][1]) / 4, p[2], p[3]]);
  return Q;
}
export function renderBrush(g, st, color, wScale = 1) {
  let P = st.pts; if (!P || !P.length) return;
  if (P.length > 4 && !st.straight) P = presmooth(P, 2);
  const w = st.width * wScale, op = st.opacity ?? 1, b = st.brush;
  g.save();
  g.fillStyle = g.strokeStyle = color; g.lineCap = g.lineJoin = 'round';
  if (b === 'fineliner' || b === 'fountain' || b === 'brushpen') {
    const D = densify(P, Math.max(0.6, w * 0.18)), n = D.length;
    let W;
    if (b === 'fineliner') W = D.map((p, i) => w * (0.78 + 0.22 * p[2]) * taper(n, i, 3, 0.55));
    else if (b === 'brushpen') W = D.map((p, i) => w * Math.pow(Math.max(0.05, p[2]), 1.35) * taper(n, i, 10, 0.08));
    else {
      const nib = -Math.PI / 4;
      W = D.map((p, i) => { const a = D[Math.max(0, i - 2)], c = D[Math.min(n - 1, i + 2)]; const ang = Math.atan2(c[1] - a[1], c[0] - a[0]); return w * (0.22 + 0.78 * Math.abs(Math.sin(ang - nib))) * (0.6 + 0.4 * p[2]) * taper(n, i, 4, 0.4); });
      W = smoothArr(W, 2);
    }
    g.globalAlpha = op; ribbon(g, D, W);
  } else if (b === 'pencil' || b === 'charcoal') {
    // 스탬프 방식: 같은 자리에 여러 번 찍혀 쌓이므로 필압에 따라 진하기가 자연스럽게 변함
    const R = rngFrom(seedOf(st.id)), D = densify(P, Math.max(0.4, w * 0.12));
    g.fillStyle = grainPattern(g, b, color); // 종이결은 문서 좌표에 고정 — 확대해도 같은 종이
    const char = b === 'charcoal';
    for (let i = 0; i < D.length; i++) {
      const [x, y, p, t] = D[i];
      const r = Math.max(0.35, w * 0.5 * (char ? 0.7 + 0.5 * p : 0.55 + 0.45 * p) * (1 + (t || 0) * (char ? 1.5 : 3)));
      const target = op * (char ? 0.35 + 0.65 * p : 0.2 + 0.8 * p) * (1 - (t || 0) * 0.55);
      const overlap = Math.max(1, (2 * r) / Math.max(0.4, w * 0.12));
      g.globalAlpha = Math.min(1, 1 - Math.pow(1 - Math.min(0.98, target), 1 / overlap)) * (char ? 1.3 : 1.15);
      const jx = char ? (R() - 0.5) * r * 0.5 : 0, jy = char ? (R() - 0.5) * r * 0.5 : 0;
      g.beginPath(); g.arc(x + jx, y + jy, r, 0, 7); g.fill();
    }
  } else if (b === 'marker') {
    const D = densify(P, Math.max(1, w * 0.2));
    const draw = withTemp(g, bboxOf(D, w), tg => { tg.strokeStyle = color; tg.lineCap = tg.lineJoin = 'round'; tg.lineWidth = w; strokePath(tg, D); tg.stroke(); });
    g.globalAlpha = op; g.globalCompositeOperation = 'multiply'; draw();
  } else if (b === 'watercolor') {
    const D = densify(P, Math.max(1.5, w * 0.15)), avgP = D.reduce((a, p) => a + p[2], 0) / D.length;
    const ww = w * (0.7 + 0.5 * avgP);
    const draw = withTemp(g, bboxOf(D, ww), tg => {
      tg.strokeStyle = color; tg.lineCap = tg.lineJoin = 'round';
      tg.lineWidth = ww; strokePath(tg, D); tg.stroke();
      // 가장자리가 진하게 마르는 물자국(웻 엣지)
      tg.globalCompositeOperation = 'destination-out'; tg.globalAlpha = 0.42; tg.lineWidth = ww * 0.74; strokePath(tg, D); tg.stroke();
      tg.globalAlpha = 0.25; tg.lineWidth = ww * 0.45; strokePath(tg, D); tg.stroke();
      // 안료 입자(그래뉼레이션)
      tg.globalAlpha = 0.3; tg.fillStyle = grainPattern(tg, 'charcoal', '#000');
      const bb = bboxOf(D, ww); tg.fillRect(bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]);
    });
    g.globalAlpha = op; g.globalCompositeOperation = 'multiply'; draw();
  } else if (b === 'hatch') {
    const R = rngFrom(seedOf(st.id)), D = densify(P, 1.5);
    const gap = Math.max(3, w * 0.22), ang = st.angle ?? -Math.PI / 4, cx = Math.cos(ang), cy = Math.sin(ang);
    g.globalAlpha = op; g.lineWidth = Math.max(0.7, w * 0.05 + 0.6);
    g.beginPath();
    let acc = gap;
    for (let i = 1; i < D.length; i++) {
      acc += Math.hypot(D[i][0] - D[i - 1][0], D[i][1] - D[i - 1][1]);
      if (acc < gap) continue; acc = 0;
      const [x, y, p] = D[i], half = w * 0.5 * (0.55 + 0.45 * p) * (0.85 + R() * 0.3), off = (R() - 0.5) * gap * 0.4;
      g.moveTo(x - cx * half + off, y - cy * half + off * 0.3); g.lineTo(x + cx * half + off + (R() - 0.5) * 1.5, y + cy * half + off * 0.3 + (R() - 0.5) * 1.5);
    }
    g.stroke();
  }
  g.restore();
}
export function brushMargin(st) {
  const w = st.width || 1;
  return ({ pencil: w * 2.2, charcoal: w * 1.6, watercolor: w * 0.8, marker: w * 0.6, hatch: w * 0.7 }[st.brush] ?? w * 0.6) + 2;
}

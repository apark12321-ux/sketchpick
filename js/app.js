import { BRUSHES, BRUSH_ORDER, OneEuro, renderBrush, brushMargin } from './brushes.js';
import { photoToSketch, parseStyle, DEFAULT_OPTS, INKS, INK_LABEL, TONE_LABEL, applyTone, uid, rng, rdp, resample, sketchPolyline, washPolyline, hexToRgb } from './engine.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const cv = $('#stage'), ctx = cv.getContext('2d');
let DPR = Math.min(window.devicePixelRatio || 1, 2);

// ───────── 상태 ─────────
const S = {
  doc: null, active: null, tool: 'draw', brushId: 'fineliner',
  brushSet: Object.fromEntries(Object.entries(BRUSHES).map(([k, b]) => [k, { size: b.size, opacity: b.opacity, color: b.color }])),
  input: { stab: 0.35, curve: 'normal', speed: true, snap: true },
  pen: { color: '#24201c', width: 3 },
  brush: { color: '#5b8fd1', width: 40, opacity: 0.32 },
  eraser: { width: 26 },
  view: { x: 0, y: 0, s: 1 },
  sel: null, fingerDraw: false,
  source: null, opts: { ...DEFAULT_OPTS },
  workId: null, api: false, paintApi: false,
};
const hiddenIds = new Set();

function mkLayer(name, kind) {
  return { id: uid(), name, kind, visible: true, locked: false, opacity: kind === 'shade' ? 0.85 : 1, blend: kind === 'color' ? 'multiply' : 'source-over', style: { widthScale: 1, ink: null, tone: 'original' }, strokes: [] };
}
function newDoc(w = 2000, h = 1500) {
  return { w, h, bg: '#fbf8f1', layers: [mkLayer('채색', 'color'), mkLayer('명암', 'shade'), mkLayer('선화', 'line'), mkLayer('내 드로잉', 'user')] };
}
const L = id => S.doc.layers.find(l => l.id === id);
const activeLayer = () => L(S.active) || S.doc.layers[S.doc.layers.length - 1];
const layerOfKind = k => S.doc.layers.find(l => l.kind === k);

// ───────── 렌더링 ─────────
const caches = new Map();
function cacheFor(layer) {
  let c = caches.get(layer.id);
  if (!c || c.cvs.width !== S.doc.w || c.cvs.height !== S.doc.h) {
    const cvs = document.createElement('canvas'); cvs.width = S.doc.w; cvs.height = S.doc.h;
    c = { cvs, g: cvs.getContext('2d'), dirty: true }; caches.set(layer.id, c);
  }
  return c;
}
let docRev = 0;
function dirty(layer) { cacheFor(layer).dirty = true; docRev++; }
function strokeColor(st, layer) {
  let c = st.color;
  if (layer && layer.style.ink && st.tool === 'pen') c = layer.style.ink;
  if (layer && layer.style.tone && layer.style.tone !== 'original') c = applyTone(c, layer.style.tone);
  return c;
}
function fillOutline(g, P, w) {
  const n = P.length;
  if (n === 1 || (n === 2 && P[0][0] === P[1][0] && P[0][1] === P[1][1])) {
    g.beginPath(); g.arc(P[0][0], P[0][1], Math.max(0.4, w * (P[0][2] ?? 0.6) / 2), 0, Math.PI * 2); g.fill(); return;
  }
  const Lt = [], Rt = [], ang = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const d = Math.hypot(tx, ty) || 1; tx /= d; ty /= d;
    const r = Math.max(0.35, w * (P[i][2] ?? 0.6) / 2);
    Lt.push([P[i][0] - ty * r, P[i][1] + tx * r, r]); Rt.push([P[i][0] + ty * r, P[i][1] - tx * r]);
    ang.push(Math.atan2(tx, -ty));
  }
  g.beginPath(); g.moveTo(Lt[0][0], Lt[0][1]);
  for (let i = 1; i < n; i++) g.lineTo(Lt[i][0], Lt[i][1]);
  g.arc(P[n - 1][0], P[n - 1][1], Lt[n - 1][2], ang[n - 1], ang[n - 1] - Math.PI, true);
  for (let i = n - 1; i >= 0; i--) g.lineTo(Rt[i][0], Rt[i][1]);
  g.arc(P[0][0], P[0][1], Lt[0][2], ang[0] + Math.PI, ang[0], true);
  g.closePath(); g.fill();
}
const imgCache = new Map();
function getImg(src) {
  let e = imgCache.get(src);
  if (!e) {
    e = { img: new Image(), ok: false }; imgCache.set(src, e);
    e.img.onload = () => { e.ok = true; for (const l of S.doc?.layers || []) if (l.img === src) dirty(l); requestDraw(); };
    e.img.src = src;
  }
  return e.ok ? e.img : null;
}
function drawStroke(g, st, layer) {
  if (st.tool === 'erase') {
    const P = st.pts; if (!P || !P.length) return;
    const prev = g.globalCompositeOperation; g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1;
    g.strokeStyle = '#000'; g.lineWidth = st.width; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo(P[0][0], P[0][1]); if (P.length === 1) g.lineTo(P[0][0] + 0.01, P[0][1]);
    for (let i = 1; i < P.length; i++) g.lineTo(P[i][0], P[i][1]);
    g.stroke(); g.globalCompositeOperation = prev; return;
  }
  const color = strokeColor(st, layer);
  if (st.tool === 'brush') { renderBrush(g, st, color, layer ? layer.style.widthScale || 1 : 1); g.globalAlpha = 1; return; }
  g.globalAlpha = st.opacity ?? 1; g.fillStyle = g.strokeStyle = color;
  const P = st.pts; if (!P || !P.length) return;
  if (st.tool === 'wash') {
    const prev = g.globalCompositeOperation; g.globalCompositeOperation = 'multiply';
    g.lineWidth = st.width; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo(P[0][0], P[0][1]);
    if (P.length === 1) g.lineTo(P[0][0] + 0.01, P[0][1]);
    for (let i = 1; i < P.length; i++) g.lineTo(P[i][0], P[i][1]);
    g.stroke(); g.globalCompositeOperation = prev;
  } else {
    fillOutline(g, P, st.width * (layer ? layer.style.widthScale || 1 : 1));
  }
  g.globalAlpha = 1;
}
const drawWashGroup = { pending: [], tmp: null };
function flushWash(g, layer) {
  const pend = drawWashGroup.pending; if (!pend.length) return;
  let t = drawWashGroup.tmp; const W = g.canvas.width, H = g.canvas.height;
  if (!t || t.width !== W || t.height !== H) { t = drawWashGroup.tmp = document.createElement('canvas'); t.width = W; t.height = H; }
  const tg = t.getContext('2d'), T = g.getTransform();
  for (const [, gr] of pend) {
    tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalCompositeOperation = 'source-over'; tg.globalAlpha = 1; tg.clearRect(0, 0, W, H);
    tg.setTransform(T);
    tg.strokeStyle = strokeColor(gr[0], layer); tg.lineCap = tg.lineJoin = 'round';
    for (const st of gr) { const P = st.pts; tg.lineWidth = st.width; tg.beginPath(); tg.moveTo(P[0][0], P[0][1]); if (P.length === 1) tg.lineTo(P[0][0] + 0.01, P[0][1]); for (let i = 1; i < P.length; i++) tg.lineTo(P[i][0], P[i][1]); tg.stroke(); }
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = gr[0].opacity ?? 0.3; g.globalCompositeOperation = 'multiply'; g.drawImage(t, 0, 0);
    g.restore();
  }
  pend.length = 0;
}
function renderLayer(layer) {
  const c = cacheFor(layer); const g = c.g;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, c.cvs.width, c.cvs.height);
  renderStrokes(g, layer, null);
  c.dirty = false;
}
function renderStrokes(g, layer, cull) {
  if (layer.kind === 'paint' && layer.img) { const im = getImg(layer.img); if (im) g.drawImage(im, 0, 0, S.doc.w, S.doc.h); }
  // 생성된 수채 획은 같은 물감(그룹)끼리 한 번에 칠해 줄무늬 없이 고르게
  const groups = new Map();
  for (const st of layer.strokes) {
    if (hiddenIds.has(st.id)) continue;
    if (cull) { const b = sbox(st); if (b[2] < cull[0] || b[0] > cull[2] || b[3] < cull[1] || b[1] > cull[3]) continue; }
    if (st.tool === 'wash' && st.g !== undefined) {
      const k = st.g + '|' + st.color + '|' + st.opacity; let gr = groups.get(k);
      if (!gr) { gr = []; groups.set(k, gr); gr.first = true; drawWashGroup.pending.push([k, gr]); }
      gr.push(st);
    } else { flushWash(g, layer); drawStroke(g, st, layer); }
  }
  flushWash(g, layer);
}
let paperPat = null;
function paperPattern(g) {
  if (paperPat) return paperPat;
  const p = document.createElement('canvas'); p.width = p.height = 256; const pg = p.getContext('2d');
  const id = pg.createImageData(256, 256), R = rng(11);
  for (let i = 0; i < id.data.length; i += 4) { const v = 200 + R() * 55; id.data[i] = v; id.data[i + 1] = v - 3; id.data[i + 2] = v - 10; id.data[i + 3] = 255; }
  pg.putImageData(id, 0, 0); paperPat = g.createPattern(p, 'repeat'); return paperPat;
}
function drawPaper(g, w, h) {
  g.fillStyle = S.doc.bg; g.fillRect(0, 0, w, h);
  g.save(); g.globalAlpha = 0.07; g.globalCompositeOperation = 'multiply'; g.fillStyle = paperPattern(g); g.fillRect(0, 0, w, h); g.restore();
}
function compose(g, w, h) {
  drawPaper(g, w, h);
  for (const l of S.doc.layers) {
    if (!l.visible) continue; const c = cacheFor(l); if (c.dirty) renderLayer(l);
    g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend; g.drawImage(c.cvs, 0, 0);
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}

let live = null, lassoPts = null, moveState = null, cursor = null;
let needs = false;
function requestDraw() { if (!needs) { needs = true; requestAnimationFrame(frame); } }
function frame() {
  needs = false; if (!S.doc) return;
  const W = cv.width / DPR, H = cv.height / DPR, v = S.view;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#e8e5df'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 24 * v.s; ctx.shadowOffsetY = 4 * v.s; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S.doc.w, S.doc.h); ctx.restore();
  ctx.imageSmoothingQuality = 'high';
  const useHi = v.s * DPR > 1.15 && !gesture && !(action && (action.type === 'pan' || action.type === 'move'));
  if (useHi) {
    if (hi.key !== hiKey()) renderHi();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(hi.cvs, 0, 0); ctx.restore();
  }
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, S.doc.w, S.doc.h); ctx.clip();
  if (!useHi) compose(ctx, S.doc.w, S.doc.h);
  if (live && live.tool === 'erase') { ctx.globalAlpha = 0.85; drawStroke(ctx, { ...live, tool: 'wash', color: S.doc.bg, opacity: 0.85 }, null); ctx.globalAlpha = 1; }
  else if (live) { const l = activeLayer(); ctx.globalAlpha = l.opacity; drawStroke(ctx, live.pred && live.pred.length ? { ...live, pts: live.pts.concat(live.pred) } : live, l); ctx.globalAlpha = 1; }
  if (moveState && moveState.img) ctx.drawImage(moveState.img, moveState.ox + moveState.dx, moveState.oy + moveState.dy);
  ctx.restore();
  const px = 1 / v.s;
  if (lassoPts && lassoPts.length > 1) {
    ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 5 * px]); ctx.strokeStyle = '#1748c9';
    ctx.beginPath(); ctx.moveTo(lassoPts[0][0], lassoPts[0][1]); for (const p of lassoPts) ctx.lineTo(p[0], p[1]); ctx.closePath();
    ctx.fillStyle = 'rgba(23,72,201,.06)'; ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
  }
  if (S.sel) {
    const [x0, y0, x1, y1] = S.sel.bbox, dx = moveState ? moveState.dx : 0, dy = moveState ? moveState.dy : 0;
    ctx.lineWidth = 1.5 * px; ctx.setLineDash([7 * px, 5 * px]); ctx.strokeStyle = '#1748c9';
    ctx.strokeRect(x0 + dx, y0 + dy, x1 - x0, y1 - y0); ctx.setLineDash([]);
    for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 5 * px, 0, 7); ctx.fill(); ctx.stroke(); }
  }
  if (cursor && S.tool === 'eraser') {
    ctx.lineWidth = 1.2 * px; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], S.eraser.width / 2, 0, 7); ctx.stroke();
  }
}
// ───────── 확대 시 고해상도 렌더 (선이 흐려지지 않게 화면 해상도로 다시 그림) ─────────
const hi = { cvs: document.createElement('canvas'), tmp: document.createElement('canvas'), key: '' };
function hiKey() { return [S.view.x, S.view.y, S.view.s, docRev, cv.width, cv.height, S.doc.layers.map(l => (l.visible ? 1 : 0) + l.opacity + l.blend + l.id).join()].join('|'); }
function renderHi() {
  const W = cv.width, H = cv.height, v = S.view;
  for (const c of [hi.cvs, hi.tmp]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = hi.cvs.getContext('2d'), tg = hi.tmp.getContext('2d');
  const T = new DOMMatrix([DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y]);
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
  const cull = [-v.x / v.s, -v.y / v.s, (W / DPR - v.x) / v.s, (H / DPR - v.y) / v.s];
  g.setTransform(T); g.save(); g.beginPath(); g.rect(0, 0, S.doc.w, S.doc.h); g.clip(); drawPaper(g, S.doc.w, S.doc.h); g.restore();
  for (const l of S.doc.layers) {
    if (!l.visible) continue;
    tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalAlpha = 1; tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H);
    tg.setTransform(T); tg.save(); tg.beginPath(); tg.rect(0, 0, S.doc.w, S.doc.h); tg.clip();
    renderStrokes(tg, l, cull); tg.restore();
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend; g.drawImage(hi.tmp, 0, 0); g.restore();
  }
  hi.key = hiKey();
}
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * DPR); cv.height = Math.round(r.height * DPR);
  requestDraw();
}
function fitView() {
  const r = cv.getBoundingClientRect();
  const padL = window.innerWidth > 700 ? 96 : 24, pad = 28;
  const s = Math.min((r.width - padL - pad) / S.doc.w, (r.height - pad * 2) / S.doc.h);
  S.view = { s, x: padL + (r.width - padL - pad - S.doc.w * s) / 2, y: (r.height - S.doc.h * s) / 2 };
  requestDraw();
}
const toDoc = (cx, cy) => { const r = cv.getBoundingClientRect(); return [(cx - r.left - S.view.x) / S.view.s, (cy - r.top - S.view.y) / S.view.s]; };

// ───────── 히스토리 ─────────
const undoStack = [], redoStack = [];
function snapshot() { return { layers: S.doc.layers.map(l => ({ ...l, style: { ...l.style } })), active: S.active }; }
function pushHistory() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; updateUndoUI(); }
function restore(snap) {
  const prev = S.doc.layers;
  S.doc.layers = snap.layers.map(l => ({ ...l, style: { ...l.style } })); S.active = snap.active;
  for (const l of S.doc.layers) {
    const p = prev.find(x => x.id === l.id);
    if (!p || p.strokes !== l.strokes || JSON.stringify(p.style) !== JSON.stringify(l.style)) dirty(l);
  }
  clearSel(); renderLayers(); syncStylePanel(); requestDraw(); scheduleSave(); updateUndoUI();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); toast('실행 취소'); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); toast('다시 실행'); }
function resetHistory() { undoStack.length = 0; redoStack.length = 0; updateUndoUI(); }
function updateUndoUI() { $('#btnUndo').disabled = !undoStack.length; $('#btnRedo').disabled = !redoStack.length; }

// ───────── 획 유틸 ─────────
const bbCache = new WeakMap();
function sbox(st) {
  let b = bbCache.get(st); if (b) return b;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of st.pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
  const m = st.tool === 'brush' ? brushMargin(st) : st.width / 2 + 1; b = [x0 - m, y0 - m, x1 + m, y1 + m]; bbCache.set(st, b); return b;
}
function distSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
function hitStroke(st, x, y, r) {
  const b = sbox(st); if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const P = st.pts, rr = r + st.width / 2;
  if (P.length === 1) return Math.hypot(x - P[0][0], y - P[0][1]) < rr;
  for (let i = 1; i < P.length; i++) if (distSeg(x, y, P[i - 1], P[i]) < rr) return true;
  return false;
}
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
const mapPts = (st, f) => ({ ...st, id: st.id, pts: st.pts.map(p => { const q = f(p[0], p[1]); return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, p[2]]; }) });

// ───────── 선택 ─────────
function clearSel() { S.sel = null; $('#selbar').hidden = true; requestDraw(); }
function selCount() { if (!S.sel) return 0; let n = 0; for (const s of S.sel.ids.values()) n += s.size; return n; }
function recomputeSelBox() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
  for (const [lid, ids] of S.sel.ids) for (const st of L(lid)?.strokes || []) if (ids.has(st.id)) { const b = sbox(st); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); n++; }
  if (n) S.sel.bbox = [x0, y0, x1, y1];
}
function finishLasso(poly) {
  if (poly.length < 3) { clearSel(); return; }
  let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  for (const p of poly) { bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); }
  if (bx1 - bx0 < 6 && by1 - by0 < 6) { clearSel(); return; }
  const ids = new Map();
  const onlyActive = $('#selScope')?.value === 'active';
  for (const l of S.doc.layers) {
    if (!l.visible || l.locked || l.kind === 'paint') continue; if (onlyActive && l.id !== S.active) continue;
    const set = new Set();
    for (const st of l.strokes) {
      const b = sbox(st); if (b[2] < bx0 || b[0] > bx1 || b[3] < by0 || b[1] > by1) continue;
      const P = st.pts, step = Math.max(1, Math.floor(P.length / 8)); let tot = 0, ins = 0;
      for (let i = 0; i < P.length; i += step) { tot++; if (inPoly(P[i][0], P[i][1], poly)) ins++; }
      if (ins / tot >= 0.6) set.add(st.id);
    }
    if (set.size) ids.set(l.id, set);
  }
  S.sel = { ids, bbox: [bx0, by0, bx1, by1], poly };
  if (ids.size) recomputeSelBox();
  showSelBar(); requestDraw();
}
function showSelBar() {
  const n = selCount();
  $('#selInfo').textContent = n ? `${n}개 획 선택` : '빈 영역 선택';
  $$('#selbar [data-need]').forEach(b => b.disabled = !n);
  $('#selbar').hidden = false;
}
function inSelBox(x, y) { if (!S.sel || !selCount()) return false; const [x0, y0, x1, y1] = S.sel.bbox, m = 14 / S.view.s; return x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m; }
function startMove(x, y) {
  const [x0, y0, x1, y1] = S.sel.bbox;
  const w = Math.max(1, Math.ceil(x1 - x0)), h = Math.max(1, Math.ceil(y1 - y0));
  const img = document.createElement('canvas'); img.width = Math.min(w, 4096); img.height = Math.min(h, 4096);
  const g = img.getContext('2d'); g.translate(-x0, -y0);
  for (const l of S.doc.layers) { const ids = S.sel.ids.get(l.id); if (!ids || !l.visible) continue; g.globalAlpha = 1; for (const st of l.strokes) if (ids.has(st.id)) { drawStroke(g, st, l); hiddenIds.add(st.id); } dirty(l); }
  moveState = { sx: x, sy: y, dx: 0, dy: 0, img, ox: x0, oy: y0 };
}
function endMove() {
  const { dx, dy } = moveState; moveState = null; hiddenIds.clear();
  if (Math.abs(dx) + Math.abs(dy) > 0.5) transformSel(st => mapPts(st, (x, y) => [x + dx, y + dy]), false);
  for (const l of S.doc.layers) if (S.sel?.ids.has(l.id)) dirty(l);
  if (S.sel) { S.sel.bbox = S.sel.bbox.map((v, i) => v + (i % 2 ? dy : dx)); }
  requestDraw();
}
function transformSel(fn, recompute = true) {
  if (!S.sel || !selCount()) return;
  pushHistory();
  for (const l of S.doc.layers) {
    const ids = S.sel.ids.get(l.id); if (!ids) continue;
    const out = [];
    for (const st of l.strokes) { if (!ids.has(st.id)) { out.push(st); continue; } const r = fn(st, l); if (r) out.push(r); else ids.delete(st.id); }
    l.strokes = out; dirty(l);
  }
  if (recompute && selCount()) recomputeSelBox();
  if (!selCount()) clearSel(); else showSelBar();
  requestDraw(); scheduleSave();
}

// ───────── 입력 (애플펜슬 / 손가락 / 마우스) ─────────
const touches = new Map();
let gesture = null, action = null, penActive = false, spaceDown = false;
function pressureOf(e) { if (e.pointerType === 'pen') { const p = e.pressure || 0.5; return Math.max(0.08, Math.pow(p, 0.8)); } return 0.6; }

function beginGesture() {
  const pts = [...touches.values()];
  const c = pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length], [0, 0]);
  const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  const prevMax = gesture ? gesture.maxTouches : 0;
  gesture = { c0: c, d0: d, v0: { ...S.view }, n: pts.length, t0: gesture ? gesture.t0 : performance.now(), moved: gesture ? gesture.moved : 0, maxTouches: Math.max(prevMax, pts.length) };
}
function updateGesture() {
  const pts = [...touches.values()]; if (!gesture || !pts.length) return;
  const r = cv.getBoundingClientRect();
  const c = pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length], [0, 0]);
  gesture.moved = Math.max(gesture.moved, Math.hypot(c[0] - gesture.c0[0], c[1] - gesture.c0[1]));
  let s = gesture.v0.s;
  if (pts.length > 1 && gesture.d0 > 0) {
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    gesture.moved = Math.max(gesture.moved, Math.abs(d - gesture.d0));
    s = Math.max(0.05, Math.min(12, gesture.v0.s * d / gesture.d0));
  }
  const dx = (gesture.c0[0] - r.left - gesture.v0.x) / gesture.v0.s, dy = (gesture.c0[1] - r.top - gesture.v0.y) / gesture.v0.s;
  S.view = { s, x: c[0] - r.left - dx * s, y: c[1] - r.top - dy * s };
  requestDraw();
}
function endGestureIfDone() {
  if (touches.size) { beginGesture(); return; }
  if (gesture) {
    const dt = performance.now() - gesture.t0;
    if (dt < 320 && gesture.moved < 12) { if (gesture.maxTouches === 2) undo(); else if (gesture.maxTouches === 3) redo(); }
  }
  gesture = null; scheduleViewSave();
}

function startAction(e) {
  const [x, y] = toDoc(e.clientX, e.clientY);
  const tool = S.tool;
  if (tool === 'hand') { action = { type: 'pan', sx: e.clientX, sy: e.clientY, v0: { ...S.view } }; return; }
  if (tool === 'lasso') {
    if (inSelBox(x, y)) { startMove(x, y); action = { type: 'move' }; requestDraw(); return; }
    clearSel(); lassoPts = [[x, y]]; action = { type: 'lasso' }; return;
  }
  const layer = activeLayer();
  if (!layer.visible || layer.locked) { toast(layer.locked ? '잠긴 레이어예요. 레이어 패널에서 잠금을 풀어 주세요' : '숨긴 레이어예요. 레이어를 켜 주세요'); action = { type: 'none' }; return; }
  if (tool === 'eraser' && layer.kind === 'paint') { live = { id: uid(), tool: 'erase', color: '#000', width: S.eraser.width, opacity: 1, pts: [[x, y, 1]] }; action = { type: 'draw', last: [x, y] }; requestDraw(); return; }
  if (tool === 'eraser') { pushHistory(); action = { type: 'erase', removed: new Set(), layer }; eraseAt(x, y); return; }
  if (tool === 'draw') {
    const bs = S.brushSet[S.brushId];
    const mc = 6 * Math.pow(1 - S.input.stab, 2) + 0.25;
    inp = { fx: new OneEuro(mc, 0.015), fy: new OneEuro(mc, 0.015), lt: e.timeStamp, lx: x, ly: y, still: 0 };
    const fx = inp.fx.filter(x, e.timeStamp), fy = inp.fy.filter(y, e.timeStamp);
    live = { id: uid(), tool: 'brush', brush: S.brushId, color: bs.color, width: +bs.size.toFixed(2), opacity: bs.opacity, pts: [[r1(fx), r1(fy), pointP(e, 0), tiltOf(e)]] };
    if (S.brushId === 'hatch') live.angle = -Math.PI / 4;
    action = { type: 'draw', last: [fx, fy] }; armSnap(); requestDraw(); return;
  }
  const p = pressureOf(e);
  if (tool === 'pen') live = { id: uid(), tool: 'pen', color: S.pen.color, width: S.pen.width, opacity: 1, pts: [[Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100]] };
  else live = { id: uid(), tool: 'wash', color: S.brush.color, width: S.brush.width, opacity: S.brush.opacity, pts: [[x, y, 1]] };
  action = { type: 'draw', last: [x, y] };
  requestDraw();
}
const r1 = v => Math.round(v * 10) / 10;
let inp = null, snapTimer = 0;
const CURVES = { soft: 0.6, normal: 0.85, firm: 1.35 };
function pointP(e, speed) { // 필압 곡선 × 속도 → 0~1
  let p = e.pointerType === 'pen' ? Math.pow(Math.max(0.02, e.pressure || 0.5), CURVES[S.input.curve] || 0.85) : 0.72;
  if (S.input.speed && ['fineliner', 'brushpen', 'fountain'].includes(S.brushId)) p *= 1 / (1 + Math.max(0, speed - 0.6) * 0.18);
  return Math.round(Math.max(0.04, Math.min(1, p)) * 100) / 100;
}
function tiltOf(e) {
  if (e.pointerType !== 'pen') return 0;
  let alt = e.altitudeAngle;
  if (alt === undefined && (e.tiltX || e.tiltY)) { const tx = Math.tan(e.tiltX * Math.PI / 180), ty = Math.tan(e.tiltY * Math.PI / 180); alt = Math.atan(1 / Math.hypot(tx, ty)); }
  if (alt === undefined) return 0;
  return Math.round(Math.max(0, Math.min(1, (Math.PI / 2 - alt) / (Math.PI / 2 - 0.35))) * 100) / 100;
}
// 선 끝에서 펜을 멈추고 있으면 직선으로 (수평·수직 근처는 딱 맞춤)
function armSnap() {
  clearTimeout(snapTimer); if (!S.input.snap) return;
  snapTimer = setTimeout(() => {
    if (!action || action.type !== 'draw' || !live || live.tool !== 'brush' || live.snapped || live.pts.length < 6) return;
    const a = live.pts[0], b = live.pts[live.pts.length - 1];
    let L = 0; for (let i = 1; i < live.pts.length; i++) L += Math.hypot(live.pts[i][0] - live.pts[i - 1][0], live.pts[i][1] - live.pts[i - 1][1]);
    const D = Math.hypot(b[0] - a[0], b[1] - a[1]); if (D < 30 / S.view.s || L > D * 1.35) return;
    live.snapped = { a: a.slice(), pAvg: live.pts.reduce((s, p) => s + p[2], 0) / live.pts.length };
    setSnapEnd(b[0], b[1]); toast('직선으로 맞췄어요 — 펜을 움직이면 끝점이 따라와요');
  }, 550);
}
function setSnapEnd(x, y) {
  const { a, pAvg } = live.snapped; let dx = x - a[0], dy = y - a[1];
  const ang = Math.atan2(dy, dx), L = Math.hypot(dx, dy);
  for (const t of [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI]) if (Math.abs(ang - t) < 0.07) { dx = Math.cos(t) * L; dy = Math.sin(t) * L; }
  const n = Math.max(2, Math.ceil(L / 6)), pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n; pts.push([r1(a[0] + dx * t), r1(a[1] + dy * t), Math.round(pAvg * 100) / 100, a[3] || 0]); }
  live.pts = pts;
}
function moveAction(e) {
  if (!action) return;
  if (action.type === 'draw' && live && live.tool === 'brush') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (evs.length ? evs : [e])) {
      const [x, y] = toDoc(ev.clientX, ev.clientY);
      if (live.snapped) { setSnapEnd(x, y); continue; }
      const fx = inp.fx.filter(x, ev.timeStamp), fy = inp.fy.filter(y, ev.timeStamp);
      const [lx, ly] = action.last, d = Math.hypot(fx - lx, fy - ly);
      if (d < 0.5 / S.view.s) continue;
      const dt = Math.max(1, ev.timeStamp - inp.lt), speed = (d * S.view.s) / dt; inp.lt = ev.timeStamp;
      action.last = [fx, fy];
      live.pts.push([r1(fx), r1(fy), pointP(ev, speed), tiltOf(ev)]);
      if (Math.hypot(x - inp.lx, y - inp.ly) * S.view.s > 3) { inp.lx = x; inp.ly = y; armSnap(); }
    }
    // 예측 점: 펜 끝을 미리 따라가 지연을 줄임 (화면 표시만, 저장 안 함)
    const pr = e.getPredictedEvents ? e.getPredictedEvents() : [];
    live.pred = live.snapped ? null : pr.slice(0, 3).map(ev => { const [x, y] = toDoc(ev.clientX, ev.clientY); return [x, y, live.pts[live.pts.length - 1][2], live.pts[live.pts.length - 1][3]]; });
    requestDraw(); return;
  }
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  if (action.type === 'pan') { S.view = { ...action.v0, x: action.v0.x + e.clientX - action.sx, y: action.v0.y + e.clientY - action.sy }; requestDraw(); return; }
  if (action.type === 'move') { const [x, y] = toDoc(e.clientX, e.clientY); moveState.dx = x - moveState.sx; moveState.dy = y - moveState.sy; requestDraw(); return; }
  for (const ev of (evs.length ? evs : [e])) {
    const [x, y] = toDoc(ev.clientX, ev.clientY);
    if (action.type === 'lasso') { const l = lassoPts[lassoPts.length - 1]; if (Math.hypot(x - l[0], y - l[1]) > 3 / S.view.s) lassoPts.push([x, y]); }
    else if (action.type === 'erase') { eraseAt(x, y); }
    else if (action.type === 'draw') {
      const [lx, ly] = action.last; if (Math.hypot(x - lx, y - ly) < 0.9 / S.view.s) continue;
      const k = live.tool === 'pen' ? 0.55 : 0.4;
      const sx = lx + (x - lx) * k, sy = ly + (y - ly) * k;
      action.last = [sx, sy];
      live.pts.push([Math.round(sx * 10) / 10, Math.round(sy * 10) / 10, live.tool === 'pen' ? Math.round(pressureOf(ev) * 100) / 100 : 1]);
      if (live.tool === 'erase') cursor = [x, y];
    }
  }
  requestDraw();
}
function endAction() {
  if (!action) return;
  const a = action; action = null;
  if (a.type === 'draw' && live) {
    clearTimeout(snapTimer);
    const st = live; live = null; delete st.pred;
    if (st.tool === 'brush') { if (st.snapped) st.straight = true; delete st.snapped; if (st.pts.length > 3 && st.brush !== 'brushpen') { const q = st.pts; q[q.length - 1][2] = Math.min(q[q.length - 1][2], q[q.length - 2][2]); } }
    if (st.pts.length > 2) { const q = st.pts; q[q.length - 1][2] = Math.min(q[q.length - 1][2], 0.4); }
    const layer = activeLayer(); pushHistory();
    layer.strokes = [...layer.strokes, st];
    const c = cacheFor(layer); if (!c.dirty) drawStroke(c.g, st, layer);
    scheduleSave();
  } else if (a.type === 'erase') {
    if (!a.removed.size) { undoStack.pop(); updateUndoUI(); }
    else { a.layer.strokes = a.layer.strokes.filter(s => !a.removed.has(s.id)); for (const id of a.removed) hiddenIds.delete(id); dirty(a.layer); scheduleSave(); }
  } else if (a.type === 'lasso') { const poly = lassoPts; lassoPts = null; finishLasso(poly); }
  else if (a.type === 'move') endMove();
  else if (a.type === 'pan') scheduleViewSave();
  requestDraw();
}
function cancelAction() { clearTimeout(snapTimer); if (action?.type === 'erase') { for (const id of action.removed) hiddenIds.delete(id); dirty(action.layer); undoStack.pop(); updateUndoUI(); } live = null; lassoPts = null; if (moveState) { moveState = null; hiddenIds.clear(); S.doc.layers.forEach(dirty); } action = null; requestDraw(); }
let eraseRAF = false;
function eraseAt(x, y) {
  cursor = [x, y];
  const r = S.eraser.width / 2, l = action.layer; let hit = false;
  for (const st of l.strokes) if (!action.removed.has(st.id) && hitStroke(st, x, y, r)) { action.removed.add(st.id); hiddenIds.add(st.id); hit = true; }
  if (hit && !eraseRAF) { eraseRAF = true; requestAnimationFrame(() => { eraseRAF = false; dirty(l); requestDraw(); }); }
}

cv.addEventListener('pointerdown', e => {
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch {}
  if (e.pointerType === 'touch') {
    if (penActive) return; // 손바닥 무시
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1 && S.fingerDraw && !gesture) { startAction(e); action && (action.finger = e.pointerId); return; }
    if (action && action.finger !== undefined) cancelAction();
    beginGesture(); return;
  }
  if (e.pointerType === 'mouse' && (e.button === 1 || spaceDown)) { action = { type: 'pan', sx: e.clientX, sy: e.clientY, v0: { ...S.view } }; return; }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen') { penActive = true; if (gesture) { touches.clear(); gesture = null; } }
  startAction(e);
}, { passive: false });
cv.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (action && action.finger === e.pointerId) moveAction(e); else updateGesture();
    return;
  }
  if (e.pointerType === 'touch' && penActive) return;
  if (!action) { if (S.tool === 'eraser' && e.pointerType !== 'touch') { cursor = toDoc(e.clientX, e.clientY); requestDraw(); } return; }
  moveAction(e);
}, { passive: false });
const up = e => {
  if (e.pointerType === 'touch') {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (action && action.finger === e.pointerId) { if (e.type === 'pointercancel') cancelAction(); else endAction(); return; }
    endGestureIfDone(); return;
  }
  if (e.pointerType === 'pen') penActive = false;
  if (e.type === 'pointercancel') cancelAction(); else endAction();
  if (e.pointerType === 'pen') { cursor = null; requestDraw(); }
};
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !action) { cursor = null; requestDraw(); } });
cv.addEventListener('wheel', e => {
  e.preventDefault(); const r = cv.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    const k = Math.exp(-e.deltaY * 0.01), s = Math.max(0.05, Math.min(12, S.view.s * k));
    const mx = e.clientX - r.left, my = e.clientY - r.top, dx = (mx - S.view.x) / S.view.s, dy = (my - S.view.y) / S.view.s;
    S.view = { s, x: mx - dx * s, y: my - dy * s };
  } else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; }
  requestDraw(); scheduleViewSave();
}, { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
document.addEventListener('selectstart', e => { if (!e.target.closest('input,textarea')) e.preventDefault(); });
document.addEventListener('dblclick', e => { if (!e.target.closest('input,textarea')) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === ' ') { spaceDown = true; }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { transformSel(() => null); }
  else if (e.key === 'Escape') { clearSel(); closeAll(); }
  else if (!mod) { const k = e.key.toLowerCase(); if (k === 'b' || k === 'p') { if (k === 'b') S.brushId = 'watercolor'; setTool('draw'); } const m = { e: 'eraser', l: 'lasso', h: 'hand' }[k]; if (m) setTool(m); }
});
window.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });
window.addEventListener('resize', () => { resize(); });

// ───────── 도구 UI ─────────
const SWATCH = { pen: ['#24201c', '#5b3a22', '#1e2d55', '#55524e', '#b8382c', '#ffffff'], brush: ['#5b8fd1', '#8fb8dd', '#7fa66a', '#d9b45a', '#d77b4f', '#b5655f', '#8a7a6a', '#9a8fb8'] };
function setTool(t) {
  if (t === 'pen' || t === 'brush') t = 'draw';
  if (t === 'draw' && S.tool === 'draw' && !$('#brushLib').hidden) { $('#brushLib').hidden = true; return; }
  else if (t === 'draw' && S.tool === 'draw') { openBrushLib(); return; }
  $('#brushLib').hidden = true;
  S.tool = t; $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if (t !== 'lasso') clearSel();
  cv.style.cursor = t === 'hand' ? 'grab' : 'crosshair';
  syncToolControls(); requestDraw();
}
function syncToolControls() {
  const t = S.tool, sw = $('#swatches');
  const B = BRUSHES[S.brushId], bs = S.brushSet[S.brushId];
  $('#drawName').textContent = B.short;
  const kind = t === 'draw' && B.palette === 'wash' ? 'brush' : 'pen';
  const cur = t === 'draw' ? bs.color : S.pen.color;
  sw.innerHTML = '';
  for (const c of SWATCH[kind]) { const b = document.createElement('button'); b.className = 'sw' + (c === cur ? ' on' : ''); b.style.background = c; b.onclick = () => { setColor(c); }; sw.appendChild(b); }
  $('#colorPick').value = cur;
  const showColor = t === 'draw';
  $('#colorBox').style.display = showColor ? '' : 'none';
  const sizeMap = { draw: [bs.size, B.min, B.max], eraser: [S.eraser.width, 6, 160] };
  const sm = sizeMap[t];
  $('#sizeBox').style.display = sm ? '' : 'none';
  if (sm) sizeSlider.set(sm[0], sm[1], sm[2]);
  $('#opBox').style.display = t === 'draw' ? '' : 'none';
  opSlider.set(bs.opacity, 0.05, 1);
}
function setColor(c) { S.brushSet[S.brushId].color = c; saveBrushPrefs(); syncToolControls(); }
function vslider(el, onChange, fmt) {
  const knob = el.querySelector('.knob'), lab = el.parentElement.querySelector('.val');
  let min = 0, max = 1, val = 0;
  const draw = () => { const t = (val - min) / (max - min); knob.style.bottom = `calc(${t * 100}% - ${t * 22}px)`; lab.textContent = fmt(val); };
  const from = e => { const r = el.getBoundingClientRect(); const t = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - 11) / (r.height - 22))); val = min + (max - min) * t * t; draw(); onChange(val); };
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); from(e); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) from(e); });
  return { set(v, a, b) { min = a; max = b; val = v; const t = Math.sqrt((v - a) / (b - a)); const tt = Math.max(0, Math.min(1, t)); knob.style.bottom = `calc(${tt * 100}% - ${tt * 22}px)`; lab.textContent = fmt(v); } };
}
const sizeSlider = vslider($('#sizeBox .vs'), v => { if (S.tool === 'draw') S.brushSet[S.brushId].size = v; else S.eraser.width = v; saveBrushPrefs(); }, v => v < 10 ? v.toFixed(1) : Math.round(v));
const opSlider = vslider($('#opBox .vs'), v => { S.brushSet[S.brushId].opacity = v; saveBrushPrefs(); }, v => Math.round(v * 100) + '%');
// ───────── 브러시 라이브러리 ─────────
function saveBrushPrefs() { try { localStorage.setItem('sp:brush', JSON.stringify({ id: S.brushId, set: S.brushSet, input: S.input })); } catch {} }
function loadBrushPrefs() { try { const j = JSON.parse(localStorage.getItem('sp:brush') || 'null'); if (!j) return; if (BRUSHES[j.id]) S.brushId = j.id; for (const k in j.set || {}) if (S.brushSet[k]) Object.assign(S.brushSet[k], j.set[k]); Object.assign(S.input, j.input || {}); } catch {} }
function previewBrush(cvs, id) {
  const r = Math.min(window.devicePixelRatio || 1, 2), W = 150, H = 44; cvs.width = W * r; cvs.height = H * r;
  const g = cvs.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.fillStyle = '#fbf8f1'; g.fillRect(0, 0, W, H);
  const B = BRUSHES[id], bs = S.brushSet[id], pts = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40; pts.push([12 + t * 126, 22 + Math.sin(t * Math.PI * 2) * 9, Math.round((0.25 + 0.75 * Math.sin(t * Math.PI)) * 100) / 100, id === 'pencil' && t > 0.6 ? 0.6 : 0]); }
  const w = Math.min(bs.size, id === 'watercolor' || id === 'marker' ? 18 : id === 'hatch' || id === 'charcoal' ? 16 : 7);
  renderBrush(g, { id: 'pv' + id, tool: 'brush', brush: id, color: bs.color, width: Math.max(w, B.min), opacity: bs.opacity, pts }, bs.color);
}
function openBrushLib() {
  const box = $('#brushList'); box.innerHTML = '';
  for (const id of BRUSH_ORDER) {
    const B = BRUSHES[id], el = document.createElement('button'); el.className = 'brow' + (id === S.brushId ? ' on' : '');
    el.innerHTML = '<canvas></canvas><span><b></b><small></small></span>';
    el.querySelector('b').textContent = B.name; el.querySelector('small').textContent = B.desc;
    previewBrush(el.querySelector('canvas'), id);
    el.onclick = () => { S.brushId = id; saveBrushPrefs(); $$('#brushList .brow').forEach(x => x.classList.remove('on')); el.classList.add('on'); syncToolControls(); };
    box.appendChild(el);
  }
  $('#inStab').value = Math.round(S.input.stab * 100); $('#inStabVal').textContent = $('#inStab').value + '%';
  $('#inCurve').value = S.input.curve; $('#inSpeed').checked = S.input.speed; $('#inSnap').checked = S.input.snap;
  $('#brushLib').hidden = false;
}
$('#inStab').addEventListener('input', e => { S.input.stab = e.target.value / 100; $('#inStabVal').textContent = e.target.value + '%'; saveBrushPrefs(); });
$('#inCurve').addEventListener('change', e => { S.input.curve = e.target.value; saveBrushPrefs(); });
$('#inSpeed').addEventListener('change', e => { S.input.speed = e.target.checked; saveBrushPrefs(); });
$('#inSnap').addEventListener('change', e => { S.input.snap = e.target.checked; saveBrushPrefs(); });
$('#brushLibClose').onclick = () => { $('#brushLib').hidden = true; };
$$('#toolbar [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('#colorPick').addEventListener('input', e => setColor(e.target.value));

// ───────── 레이어 패널 ─────────
const KIND_LABEL = { color: '채색', shade: '명암', line: '선화', user: '드로잉', paint: 'AI 원화 · 지우개는 픽셀 단위' };
function renderLayers() {
  const box = $('#layerList'); box.innerHTML = '';
  for (const l of [...S.doc.layers].reverse()) {
    const row = document.createElement('div'); row.className = 'lrow' + (l.id === S.active ? ' on' : '');
    row.innerHTML = `<button class="eye ${l.visible ? '' : 'off'}" title="보이기">${l.visible ? ICON.eye : ICON.eyeOff}</button>
      <div class="lname"><b></b><small>${KIND_LABEL[l.kind] || ''} · 획 ${l.strokes.length.toLocaleString()}개</small></div>
      <button class="lock ${l.locked ? 'on' : ''}" title="잠금">${l.locked ? ICON.lock : ICON.unlock}</button>`;
    row.querySelector('b').textContent = l.name;
    row.querySelector('.eye').onclick = ev => { ev.stopPropagation(); pushHistory(); l.visible = !l.visible; renderLayers(); requestDraw(); scheduleSave(); };
    row.querySelector('.lock').onclick = ev => { ev.stopPropagation(); l.locked = !l.locked; renderLayers(); scheduleSave(); };
    row.onclick = () => { S.active = l.id; renderLayers(); };
    row.querySelector('.lname').ondblclick = () => { const n = prompt('레이어 이름', l.name); if (n) { l.name = n.trim().slice(0, 20); renderLayers(); scheduleSave(); } };
    box.appendChild(row);
  }
  const a = activeLayer();
  $('#layerOpacity').value = Math.round(a.opacity * 100); $('#layerOpacityVal').textContent = Math.round(a.opacity * 100) + '%';
  $('#layerBlend').value = a.blend;
}
$('#layerOpacity').addEventListener('input', e => { const a = activeLayer(); a.opacity = e.target.value / 100; $('#layerOpacityVal').textContent = e.target.value + '%'; requestDraw(); scheduleSave(); });
$('#layerOpacity').addEventListener('pointerdown', () => pushHistory());
$('#layerBlend').addEventListener('change', e => { pushHistory(); activeLayer().blend = e.target.value; requestDraw(); scheduleSave(); });
$('#lyAdd').onclick = () => { pushHistory(); const l = mkLayer('레이어 ' + (S.doc.layers.length + 1), 'user'); const i = S.doc.layers.indexOf(activeLayer()); S.doc.layers.splice(i + 1, 0, l); S.active = l.id; renderLayers(); requestDraw(); scheduleSave(); };
$('#lyDel').onclick = () => { if (S.doc.layers.length <= 1) return toast('레이어가 하나는 있어야 해요'); const a = activeLayer(); if (a.strokes.length && !confirm(`'${a.name}' 레이어를 삭제할까요?`)) return; pushHistory(); const i = S.doc.layers.indexOf(a); S.doc.layers.splice(i, 1); S.active = S.doc.layers[Math.max(0, i - 1)].id; renderLayers(); requestDraw(); scheduleSave(); };
$('#lyUp').onclick = () => moveLayer(1); $('#lyDown').onclick = () => moveLayer(-1);
$('#lyClear').onclick = () => { const a = activeLayer(); if (!a.strokes.length) return; pushHistory(); a.strokes = []; dirty(a); renderLayers(); requestDraw(); scheduleSave(); toast(`'${a.name}' 비움 (실행 취소 가능)`); };
function moveLayer(d) { const ls = S.doc.layers, a = activeLayer(), i = ls.indexOf(a), j = i + d; if (j < 0 || j >= ls.length) return; pushHistory(); ls.splice(i, 1); ls.splice(j, 0, a); renderLayers(); requestDraw(); scheduleSave(); }

// ───────── 스타일 패널 (일괄 변경, 비파괴) ─────────
function syncStylePanel() {
  const line = layerOfKind('line'), color = layerOfKind('color'), shade = layerOfKind('shade');
  $('#stInk').value = line?.style.ink || '';
  $('#stWidth').value = Math.round((line?.style.widthScale || 1) * 100); $('#stWidthVal').textContent = $('#stWidth').value + '%';
  $('#stTone').value = color?.style.tone || 'original';
  $('#stColorOp').value = Math.round((color?.opacity ?? 1) * 100); $('#stColorOpVal').textContent = $('#stColorOp').value + '%';
  $('#stShade').checked = !!shade?.visible;
  $('#stShadeOp').value = Math.round((shade?.opacity ?? 1) * 100); $('#stShadeOpVal').textContent = $('#stShadeOp').value + '%';
  $('#stDetail').value = Math.round(S.opts.detail * 100); $('#stRough').value = Math.round(S.opts.roughness * 100);
  $('#regenBox').style.display = S.source || S.opts.engine === 'master' ? '' : 'none';
}
function styleKinds(kinds, fn) { pushHistory(); for (const l of S.doc.layers) if (kinds.includes(l.kind)) { fn(l); dirty(l); } requestDraw(); scheduleSave(); }
$('#stInk').addEventListener('change', e => styleKinds(['line', 'shade'], l => l.style = { ...l.style, ink: e.target.value || null }));
$('#stTone').addEventListener('change', e => styleKinds(['color'], l => l.style = { ...l.style, tone: e.target.value }));
let sliderHist = false;
function liveSlider(id, valId, apply) {
  const el = $(id);
  el.addEventListener('pointerdown', () => { pushHistory(); sliderHist = true; });
  el.addEventListener('input', e => { if (!sliderHist) { pushHistory(); sliderHist = true; } $(valId).textContent = e.target.value + '%'; apply(e.target.value / 100); requestDraw(); });
  el.addEventListener('change', () => { sliderHist = false; scheduleSave(); });
}
liveSlider('#stWidth', '#stWidthVal', v => { for (const l of S.doc.layers) if (l.kind === 'line') { l.style = { ...l.style, widthScale: v }; dirty(l); } });
liveSlider('#stColorOp', '#stColorOpVal', v => { for (const l of S.doc.layers) if (l.kind === 'color') l.opacity = v; });
liveSlider('#stShadeOp', '#stShadeOpVal', v => { for (const l of S.doc.layers) if (l.kind === 'shade') l.opacity = v; });
$('#stShade').addEventListener('change', e => styleKinds(['shade'], l => l.visible = e.target.checked));
$$('#presetRow [data-preset]').forEach(b => b.onclick = () => {
  const P = { classic: { ink: '', tone: 'original', w: 1 }, warm: { ink: '#5b3a22', tone: 'warm', w: 1 }, night: { ink: '#1e2d55', tone: 'cool', w: 1.1 }, soft: { ink: '#55524e', tone: 'pastel', w: 0.8 }, mono: { ink: '', tone: 'mono', w: 1.15 } }[b.dataset.preset];
  pushHistory();
  for (const l of S.doc.layers) {
    if (l.kind === 'line' || l.kind === 'shade') { l.style = { ...l.style, ink: P.ink || null, widthScale: l.kind === 'line' ? P.w : l.style.widthScale }; dirty(l); }
    if (l.kind === 'color') { l.style = { ...l.style, tone: P.tone }; dirty(l); }
  }
  syncStylePanel(); requestDraw(); scheduleSave(); toast(b.textContent.trim() + ' 스타일 적용');
});
$('#btnRegen').onclick = async () => {
  if (S.opts.engine === 'master') { if (!S.paintApi) return toast('명화 엔진 연결이 필요해요'); return generateMaster(S.source, S.opts.desc || '', { ...S.opts, detail: $('#stDetail').value / 100, roughness: $('#stRough').value / 100 }, true); }
  if (!S.source) return;
  const o = { ...S.opts, detail: $('#stDetail').value / 100, roughness: $('#stRough').value / 100, seed: (S.opts.seed || 7) + 1 };
  await generateFromPhoto(S.source, o, true);
};

// ───────── 생성 스튜디오 (사진·주소·참고 이미지·내 화풍 → 후보 → 선택) ─────────
const PRESETS = [
  { id: 'urban', name: '펜 + 수채', desc: '클래식 어반스케치', prompt: 'confident fountain-pen ink lines with loose transparent watercolor washes, classic on-location urban sketch, white paper left for light', o: { wash: true, hatching: true, ink: 'ink', roughness: 0.5 }, demo: ['fineliner', 'watercolor'] },
  { id: 'pencil', name: '연필 드로잉', desc: '부드러운 흑연 명암', prompt: 'graphite pencil drawing in a sketchbook, soft tonal shading, smudges, faint construction lines left visible', o: { wash: false, hatching: true, ink: 'gray', roughness: 0.45 }, demo: ['pencil', 'pencil'] },
  { id: 'fountain', name: '만년필 해칭', desc: '세피아 잉크 펜화', prompt: 'monochrome sepia fountain-pen drawing with dense expressive cross-hatching, no color, varied nib line width', o: { wash: false, hatching: true, ink: 'sepia', roughness: 0.55, tone: 'mono' }, demo: ['fountain', 'hatch'] },
  { id: 'marker', name: '마커 일러스트', desc: '회색 톤 + 포인트 색', prompt: 'alcohol marker illustration with fine-liner outlines, layered cool grey marker tones and a few accent colours, streaky marker strokes', o: { wash: true, hatching: false, ink: 'ink', roughness: 0.35, tone: 'pastel' }, demo: ['fineliner', 'marker'] },
  { id: 'sumuk', name: '수묵 담채', desc: '붓 먹선과 옅은 채색', prompt: 'Korean ink-wash painting (sumuk-damchae) with expressive brush-pen ink strokes, pale light colour washes and generous empty space', o: { wash: true, hatching: false, ink: 'ink', roughness: 0.8, tone: 'pastel' }, demo: ['brushpen', 'watercolor'] },
  { id: 'cpencil', name: '색연필', desc: '결이 보이는 따뜻한 색', prompt: 'coloured pencil drawing with visible directional strokes and paper grain, gentle warm colours, light hand', o: { wash: true, hatching: true, ink: 'gray', roughness: 0.4, tone: 'warm' }, demo: ['pencil', 'charcoal'] },
];
const GEN = { subject: null, refs: [], useMine: false, preset: 'urban', count: 4, lastBatch: null };
let pendingImg = null; // (호환) 대상 사진
function shrinkDataURL(src, max = 1600, q = 0.88) { return loadImg(src).then(im => toDataURL(im, max, q)); }
function loadImageFile(f) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(f), img = new Image();
    img.onload = () => { const d = toDataURL(img, 1600, 0.88); URL.revokeObjectURL(url); loadImg(d).then(res, rej); };
    img.onerror = rej; img.src = url;
  });
}
async function fetchUrlImage(u) {
  u = (u || '').trim(); if (!/^https?:\/\//i.test(u)) throw new Error('https:// 로 시작하는 이미지 주소를 넣어 주세요');
  const r = await fetch('/api/fetch?url=' + encodeURIComponent(u));
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || !j.dataUrl) throw new Error(j.error || '이 화면(미리보기)에서는 주소로 불러올 수 없어요. 사진으로 올려 주세요');
  return shrinkDataURL(j.dataUrl);
}
async function setSubject(dataUrl) {
  GEN.subject = dataUrl; pendingImg = dataUrl ? await loadImg(dataUrl) : null;
  $('#genPreview').src = dataUrl || ''; $('#genDrop').classList.toggle('has', !!dataUrl);
}
$('#genFile').addEventListener('change', async e => {
  const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
  try { const im = await loadImageFile(f); await setSubject(im.src); } catch { toast('사진을 열 수 없어요'); }
});
$('#genClear').onclick = e => { e.preventDefault(); e.stopPropagation(); setSubject(null); };
$('#subUrlGo').onclick = async () => { busy('이미지 가져오는 중'); try { await setSubject(await fetchUrlImage($('#subUrl').value)); $('#subUrl').value = ''; } catch (err) { toast(err.message); } finally { busy(null); } };
$('#refUrlGo').onclick = async () => { if (GEN.refs.length >= 3) return toast('참고 이미지는 3장까지예요'); busy('이미지 가져오는 중'); try { GEN.refs.push(await fetchUrlImage($('#refUrl').value)); $('#refUrl').value = ''; renderRefs(); } catch (err) { toast(err.message); } finally { busy(null); } };
function thumbsUI(box, list, max, onChange) {
  box.innerHTML = '';
  list.forEach((src, i) => { const t = document.createElement('div'); t.className = 't'; t.innerHTML = '<img alt=""><button type="button" title="빼기">✕</button>'; t.querySelector('img').src = src; t.querySelector('button').onclick = () => { list.splice(i, 1); onChange(); }; box.appendChild(t); });
  if (list.length < max) {
    const add = document.createElement('label'); add.className = 'add'; add.innerHTML = '＋<input type="file" accept="image/*" multiple>';
    add.querySelector('input').onchange = async e => { for (const f of [...e.target.files].slice(0, max - list.length)) { try { list.push((await loadImageFile(f)).src); } catch {} } onChange(); };
    box.appendChild(add);
  }
}
function renderRefs() { thumbsUI($('#refThumbs'), GEN.refs, 3, renderRefs); }
// 내 화풍 (이 기기에 저장)
let MINE = []; try { MINE = JSON.parse(localStorage.getItem('sp:mine') || '[]'); } catch {}
async function saveMine() { MINE = await Promise.all(MINE.map(s => s.length > 120000 ? shrinkDataURL(s, 480, 0.82) : s)); try { localStorage.setItem('sp:mine', JSON.stringify(MINE)); } catch { toast('저장 공간이 부족해요'); } renderMine(); }
function renderMine() {
  thumbsUI($('#mineThumbs'), MINE, 3, saveMine);
  $('#mineNote').textContent = MINE.length ? `등록된 내 그림 ${MINE.length}장의 손버릇대로 그려요` : '내가 그린 그림을 등록하면 그 손버릇대로 그려요';
  if (!MINE.length) $('#useMine').checked = false;
}
$('#mineManage').onclick = e => { e.preventDefault(); openModal('#modal-mine'); };
$('#useMine').addEventListener('change', e => { if (e.target.checked && !MINE.length) { e.target.checked = false; openModal('#modal-mine'); } });
// 붙여넣기 (사진 복사 → 붙여넣기, 이미지 주소 붙여넣기)
document.addEventListener('paste', async e => {
  if ($('#modal-generate').hidden || e.target.closest('input,textarea')) return;
  const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (f) { e.preventDefault(); const im = await loadImageFile(f); if (!GEN.subject) await setSubject(im.src); else if (GEN.refs.length < 3) { GEN.refs.push(im.src); renderRefs(); } return; }
  const t = e.clipboardData?.getData('text') || ''; if (/^https?:\/\//.test(t)) { $(GEN.subject ? '#refUrl' : '#subUrl').value = t; }
});
// 화풍 프리셋 카드 (실제 브러시로 그린 미리보기)
function renderPresets() {
  const box = $('#presetGrid'); box.innerHTML = '';
  for (const P of PRESETS) {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'preset' + (P.id === GEN.preset ? ' on' : '');
    el.innerHTML = '<canvas width="220" height="100"></canvas><b></b><small></small>';
    el.querySelector('b').textContent = P.name; el.querySelector('small').textContent = P.desc;
    const g = el.querySelector('canvas').getContext('2d'); g.fillStyle = '#fbf8f1'; g.fillRect(0, 0, 220, 100);
    const house = [[30, 82], [30, 44], [80, 20], [130, 44], [130, 82]], tower = [[140, 82], [140, 30], [190, 30], [190, 82]];
    const [lineB, fillB] = P.demo;
    if (fillB === 'watercolor' || fillB === 'marker') {
      const col = P.id === 'marker' ? '#9aa3ad' : P.id === 'sumuk' ? '#b9c7b0' : '#8fb3d9';
      renderBrush(g, { id: P.id + 'f', tool: 'brush', brush: fillB, color: col, width: 26, opacity: fillB === 'marker' ? 0.5 : 0.55, pts: [[40, 60, .8], [120, 66, .8]] }, col);
      renderBrush(g, { id: P.id + 'f2', tool: 'brush', brush: fillB, color: P.id === 'urban' ? '#d9a46a' : col, width: 22, opacity: 0.5, pts: [[150, 45, .8], [182, 72, .8]] }, P.id === 'urban' ? '#d9a46a' : col);
    } else {
      renderBrush(g, { id: P.id + 'h', tool: 'brush', brush: fillB, color: P.o.ink === 'sepia' ? '#5b3a22' : '#55524e', width: fillB === 'hatch' ? 22 : 10, opacity: 0.7, pts: [[145, 40, .7, .6], [185, 76, .7, .6]] }, P.o.ink === 'sepia' ? '#5b3a22' : '#55524e');
    }
    const ink = P.o.ink === 'sepia' ? '#5b3a22' : P.o.ink === 'gray' ? '#4a4642' : '#24201c';
    for (const path of [house, tower, [[8, 84], [212, 84]]]) renderBrush(g, { id: P.id + path.length, tool: 'brush', brush: lineB, color: ink, width: lineB === 'brushpen' ? 5 : lineB === 'pencil' ? 2.4 : 2.2, opacity: 1, pts: path.map(p => [p[0], p[1], 0.75]), straight: true }, ink);
    el.onclick = () => { GEN.preset = P.id; const o = { ...readGenOpts(), ...P.o }; if (!P.o.tone) o.tone = 'original'; writeGenOpts(o); renderPresets(); };
    box.appendChild(el);
  }
}
function readGenOpts() {
  return { ...S.opts, detail: $('#gDetail').value / 100, roughness: $('#gRough').value / 100, hatching: $('#gHatch').checked, wash: $('#gWash').checked, ink: $('#gInk').value, tone: $('#gTone').value };
}
function writeGenOpts(o) {
  $('#gDetail').value = Math.round(o.detail * 100); $('#gRough').value = Math.round(o.roughness * 100);
  $('#gHatch').checked = o.hatching; $('#gWash').checked = o.wash; $('#gInk').value = o.ink; $('#gTone').value = o.tone;
}
let descTimer = 0;
$('#genDesc').addEventListener('input', () => {
  clearTimeout(descTimer);
  descTimer = setTimeout(() => {
    const t = $('#genDesc').value; const o = parseStyle(t, readGenOpts()); writeGenOpts(o);
    $('#genNotes').innerHTML = o.notes.length ? o.notes.map(n => `<span class="chip ok">${n}</span>`).join('') : '';
  }, 250);
});
$$('input[name=gcount]').forEach(r => r.onchange = () => { GEN.count = +r.value; });

// 참고 이미지의 색감 뽑기 (빠른 엔진용 팔레트 전이)
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0; if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return [h, s, l]; }
async function paletteFrom(srcs) {
  const px = [];
  for (const src of srcs) {
    const im = await loadImg(src), c = document.createElement('canvas'); c.width = 56; c.height = 56; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, 56, 56);
    const d = g.getImageData(0, 0, 56, 56).data;
    for (let i = 0; i < d.length; i += 4) { const [, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]); if (l > 0.18 && l < 0.93 && s > 0.06) px.push([d[i], d[i + 1], d[i + 2]]); }
  }
  if (px.length < 30) return null;
  let C = Array.from({ length: 6 }, (_, k) => px[Math.floor((k + 0.5) / 6 * px.length)]);
  for (let it = 0; it < 8; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const p of px) { let bi = 0, bd = 1e9; C.forEach((c, j) => { const dd = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (dd < bd) { bd = dd; bi = j; } }); const a = acc[bi]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++; }
    C = C.map((c, j) => acc[j][3] ? [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]] : c);
  }
  return C;
}
function recolor(strokes, pal) {
  if (!pal) return strokes;
  const map = new Map();
  return strokes.map(st => {
    if (!map.has(st.color)) {
      const [r, g, b] = hexToRgb(st.color), [h, s, l] = rgb2hsl(r, g, b);
      let best = pal[0], bd = 1e9;
      for (const c of pal) { const [h2, s2, l2] = rgb2hsl(...c); const dh = Math.min(Math.abs(h - h2), 360 - Math.abs(h - h2)) / 180; const dd = (l - l2) ** 2 * 3 + dh * dh * s * s2 + (s - s2) ** 2; if (dd < bd) { bd = dd; best = c; } }
      const k = 0.72; map.set(st.color, '#' + [0, 1, 2].map(i => Math.round([r, g, b][i] * (1 - k) + best[i] * k).toString(16).padStart(2, '0')).join(''));
    }
    return { ...st, color: map.get(st.color) };
  });
}
// 빠른 엔진 결과를 작은 그림으로
function drawQuickThumb(cvs, res, o) {
  const W = res.width, H = res.height, k = cvs.width / W; cvs.height = Math.round(H * k);
  const g = cvs.getContext('2d'); g.fillStyle = '#fbf8f1'; g.fillRect(0, 0, cvs.width, cvs.height);
  const t = document.createElement('canvas'); t.width = cvs.width; t.height = cvs.height; const tg = t.getContext('2d');
  const layers = genLayers(res, o, false).slice(0, 3);
  for (const l of layers) {
    tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, t.width, t.height); tg.setTransform(k, 0, 0, k, 0, 0);
    renderStrokes(tg, l, null);
    g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend; g.drawImage(t, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }
}
const QUICK_VARIANTS = [
  o => o,
  o => ({ ...o, roughness: Math.min(1, o.roughness + 0.3), detail: Math.max(0.2, o.detail - 0.15) }),
  o => ({ ...o, roughness: Math.max(0.1, o.roughness - 0.25), detail: Math.min(0.9, o.detail + 0.2), hatching: !o.hatching }),
  o => ({ ...o, wash: !o.wash, roughness: 0.75 }),
];
async function runBatch() {
  const desc = $('#genDesc').value.trim(), o = readGenOpts(), P = PRESETS.find(p => p.id === GEN.preset);
  const master = $('#engMaster').checked;
  if (master && !S.paintApi) { $('#engQuick').checked = true; return toast('명화 엔진이 아직 연결되지 않았어요 — 빠른 엔진으로 바꿨어요'); }
  if (!master && !GEN.subject) return toast('빠른 엔진은 사진이 필요해요. 사진을 고르거나 명화 엔진을 써 주세요');
  if (master && !GEN.subject && !desc) return toast('사진을 고르거나 그릴 장면을 설명해 주세요');
  const refs = GEN.useMine || $('#useMine').checked ? MINE.slice(0, 3) : GEN.refs.slice(0, 3);
  const refMode = ($('#useMine').checked && MINE.length) ? 'mine' : (refs.length ? 'ref' : null);
  GEN.lastBatch = { desc, o, P, master, refs, refMode };
  openModal('#modal-cands');
  const grid = $('#candGrid'); grid.innerHTML = '';
  const n = GEN.count, slots = [];
  for (let i = 0; i < n; i++) { const b = document.createElement('button'); b.className = 'cand'; b.innerHTML = '<div class="wait"><div class="spinner"></div><span>그리는 중</span></div>'; grid.appendChild(b); slots.push(b); }
  const fill = (slot, node, label, onPick) => { slot.innerHTML = ''; slot.appendChild(node); const lb = document.createElement('span'); lb.className = 'lab'; lb.textContent = label; slot.appendChild(lb); slot.onclick = onPick; };
  const fail = (slot, msg) => { slot.classList.add('err'); slot.querySelector('.wait').innerHTML = '<span></span>'; slot.querySelector('.wait span').textContent = msg; };
  if (master) {
    let ar = 4 / 3, subj = null;
    if (GEN.subject) { const im = await loadImg(GEN.subject); ar = im.naturalWidth / im.naturalHeight; subj = toDataURL(im, 500, 0.9); }
    const refsSmall = await Promise.all(refs.map(r => shrinkDataURL(r, 500, 0.88)));
    const images = subj ? [subj, ...refsSmall].slice(0, 4) : refsSmall.slice(0, 4);
    const ow = ar >= 1 ? 1536 : 1536 * ar, oh = ar >= 1 ? 1536 / ar : 1536;
    slots.forEach((slot, i) => {
      callPaint({ images, hasSubject: !!subj, refMode, preset: P.prompt, prompt: desc, style: styleEnglish(o), width: r16(ow), height: r16(oh), seed: Math.floor(Math.random() * 1e9) })
        .then(ai => { const im = new Image(); im.src = ai; fill(slot, im, `후보 ${i + 1}`, () => { closeAll(); applyMasterBusy(ai, GEN.subject, desc, { ...o, preset: P.id }); }); })
        .catch(err => fail(slot, err.message));
    });
  } else {
    const pal = refs.length ? await paletteFrom(refs) : null;
    const img = await loadImg(GEN.subject);
    for (let i = 0; i < n; i++) {
      const oi = { ...QUICK_VARIANTS[i % 4](o), seed: Math.floor(Math.random() * 1e6) };
      try {
        await new Promise(r => setTimeout(r, 30));
        const res = await photoToSketch(img, oi, () => {});
        res.color = recolor(res.color, pal);
        const c = document.createElement('canvas'); c.width = 640; drawQuickThumb(c, res, oi);
        fill(slots[i], c, ['기본', '자유로운 선', '꼼꼼한 선', oi.wash ? '채색 추가' : '펜화만'][i % 4], async () => { closeAll(); await applyQuick(res, GEN.subject, desc, oi, false); });
      } catch (err) { fail(slots[i], err.message); }
    }
  }
}
$('#btnGenGo').onclick = () => runBatch();
$('#candMore').onclick = () => runBatch();
$('#candBack').onclick = () => openModal('#modal-generate');
renderPresets(); renderRefs(); renderMine();
function genLayers(res, o, keepUser) {
  const ink = INKS[o.ink] || INKS.ink;
  const color = mkLayer('채색', 'color'), shade = mkLayer('명암', 'shade'), line = mkLayer('선화', 'line');
  color.strokes = res.color; shade.strokes = res.shade; line.strokes = res.line;
  color.style.tone = o.tone || 'original';
  const user = keepUser && S.doc && S.doc.w === res.width && S.doc.h === res.height ? S.doc.layers.filter(l => l.kind === 'user') : [];
  return [color, shade, line, ...(user.length ? user : [mkLayer('내 드로잉', 'user')])];
}
async function generateFromPhoto(src, o, isRegen, desc = '') {
  busy('사진 분석 중');
  try {
    const img = await loadImg(src);
    const res = await photoToSketch(img, o, s => busy(s));
    await applyQuick(res, src, desc, o, isRegen);
  } catch (err) { console.error(err); toast('그리는 중 문제가 생겼어요: ' + err.message); }
  finally { busy(null); }
}
async function applyQuick(res, src, desc, o, isRegen) {
  const same = isRegen && S.doc && S.doc.w === res.width && S.doc.h === res.height;
  if (!isRegen && S.doc && S.doc.layers.some(l => l.strokes.length || l.img)) { await saveNow(); newWorkId(); $('#title').value = '새 작품'; }
  if (same) pushHistory(); else resetHistory();
  const layers = genLayers(res, o, same);
  S.doc = same ? { ...S.doc, layers } : { w: res.width, h: res.height, bg: '#fbf8f1', layers };
  S.active = layers[layers.length - 1].id; S.source = src; S.opts = { ...o };
  caches.clear(); clearSel(); renderLayers(); syncStylePanel(); if (!same) fitView(); requestDraw();
  if (!isRegen && desc && $('#title').value === '새 작품') $('#title').value = desc.slice(0, 18);
  await saveNow();
  if (!isRegen) toast('완성 — 내보내기에서 ‘그리는 과정 영상’을 만들 수 있어요');
}
async function generateFromText(desc, o) {
  busy('AI가 장면을 구상하는 중 (30초~1분)');
  try {
    const r = await fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'scene', description: desc, style: o }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
    const W = 2000, H = 1500, k = 2, R = rng(Date.now() % 1e6), ink = INKS[o.ink] || INKS.ink;
    const res = { width: W, height: H, line: [], shade: [], color: [] };
    for (const s of j.strokes || []) {
      if (!Array.isArray(s.points) || s.points.length < 2) continue;
      const pts = s.points.map(p => [p[0] * k, p[1] * k]);
      if (s.layer === 'color') { if (o.wash) res.color.push(washPolyline(pts, s.color || '#8fb8dd', (s.width || 30) * k, 0.3)); }
      else if (s.layer === 'shade') { if (o.hatching) { const st = sketchPolyline(pts, R, o.roughness * 0.4, ink, 1.35, { overshoot: false, opacity: 0.8 }); st && res.shade.push(st); } }
      else { const st = sketchPolyline(pts, R, o.roughness, ink, (s.width || 2.4) * 1.1); st && res.line.push(st); }
    }
    if (S.doc && S.doc.layers.some(l => l.strokes.length)) { await saveNow(); newWorkId(); }
    resetHistory();
    const layers = genLayers(res, o, false);
    S.doc = { w: W, h: H, bg: '#fbf8f1', layers }; S.active = layers[layers.length - 1].id; S.source = null; S.opts = { ...o };
    caches.clear(); clearSel(); renderLayers(); syncStylePanel(); fitView();
    if ($('#title').value === '새 작품') $('#title').value = desc.slice(0, 18);
    await saveNow(); toast(j.message || '완성 — 펜으로 이어서 다듬어 보세요');
  } catch (err) { toast('AI 생성 실패: ' + err.message); }
  finally { busy(null); }
}

// ───────── 명화 엔진 ─────────
const r16 = v => Math.max(256, Math.min(1920, Math.round(v / 16) * 16));
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function toDataURL(src, maxSide, q = 0.9) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
function styleEnglish(o) {
  const a = [];
  a.push({ warm: 'warm golden afternoon light', cool: 'cool blue-hour atmosphere', pastel: 'soft, airy pastel palette', vivid: 'rich saturated colors', mono: 'monochrome ink and grey wash only, no color' }[o.tone] || '');
  a.push({ sepia: 'sepia brown ink lines', navy: 'navy blue ink lines', gray: 'soft graphite pencil lines instead of ink' }[o.ink] || '');
  if (!o.wash) a.push('pen and ink drawing only, no watercolor, white paper');
  if (o.hatching) a.push('expressive cross-hatching in the shadows');
  if (o.roughness > 0.7) a.push('bold, fast, gestural, energetic lines'); else if (o.roughness < 0.3) a.push('careful, precise, refined lines');
  if (o.detail > 0.7) a.push('rich architectural detail'); else if (o.detail < 0.35) a.push('minimal, very loose, only essential lines');
  return a.filter(Boolean).join(', ');
}
async function callPaint(body) {
  const r = await fetch('/api/paint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || ('오류 ' + r.status));
  return j.image;
}
async function generateMaster(src, desc, o, isRegen) {
  busy('명화 엔진이 그리는 중 (보통 20초~1분)');
  try {
    let input = null, ar = 4 / 3;
    if (src) { const im = await loadImg(src); ar = im.naturalWidth / im.naturalHeight; input = toDataURL(im, 500, 0.9); }
    const ow = ar >= 1 ? 1536 : 1536 * ar, oh = ar >= 1 ? 1536 / ar : 1536;
    const t0 = performance.now();
    const ai = await callPaint({ image: input, hasSubject: !!input, prompt: desc, style: styleEnglish(o), preset: (PRESETS.find(p => p.id === o.preset) || PRESETS[0]).prompt, width: r16(ow), height: r16(oh), seed: Math.floor(Math.random() * 1e9) });
    await applyMaster(ai, src, desc, o, isRegen);
  } catch (err) { console.error(err); toast('명화 엔진: ' + err.message); }
  finally { busy(null); }
}
async function applyMasterBusy(ai, src, desc, o) { try { await applyMaster(ai, src, desc, o, false); } catch (err) { toast('명화 엔진: ' + err.message); } finally { busy(null); } }
async function applyMaster(ai, src, desc, o, isRegen) {
    busy('편집할 수 있게 레이어로 나누는 중');
    const aiImg = await loadImg(ai), ar = aiImg.naturalWidth / aiImg.naturalHeight;
    const W = ar >= 1 ? 2000 : Math.round(2000 * ar), H = ar >= 1 ? Math.round(2000 / ar) : 2000;
    // 원화를 문서 크기로 고정
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(aiImg, 0, 0, W, H);
    const paintSrc = c.toDataURL('image/jpeg', 0.92);
    // 원화에서 펜 선을 벡터로 따 둔다 (원화를 끄고 선화로 쓰거나, 선만 고칠 때)
    const lines = await photoToSketch(c, { ...o, wash: false, hatching: false, roughness: 0.25, detail: 0.6, seed: 3 }, () => {});
    const same = isRegen && S.doc && S.doc.w === W && S.doc.h === H;
    if (!isRegen && S.doc && S.doc.layers.some(l => l.strokes.length || l.img)) { await saveNow(); newWorkId(); $('#title').value = '새 작품'; }
    if (same) pushHistory(); else resetHistory();
    const paint = mkLayer('AI 원화', 'paint'); paint.img = paintSrc; paint.blend = 'source-over';
    const line = mkLayer('선화 (원화에서 추출)', 'line'); line.strokes = lines.line; line.visible = false;
    const user = same ? S.doc.layers.filter(l => l.kind === 'user') : [mkLayer('내 드로잉', 'user')];
    const layers = [paint, line, ...user];
    S.doc = same ? { ...S.doc, layers } : { w: W, h: H, bg: '#fbf8f1', layers };
    S.active = layers[layers.length - 1].id; S.source = src; S.opts = { ...o, engine: 'master', desc };
    caches.clear(); clearSel(); renderLayers(); syncStylePanel(); if (!same) fitView(); requestDraw();
    if (!isRegen && desc && $('#title').value === '새 작품') $('#title').value = desc.slice(0, 18);
    await saveNow();
    toast('완성 — 펜으로 덧그리고, 영역을 골라 말로 고치고, 그리는 과정 영상도 만들 수 있어요');
}
function featherMask(w, h, poly, ox, oy, feather) {
  const m = document.createElement('canvas'); m.width = w; m.height = h; const g = m.getContext('2d');
  g.fillStyle = '#000';
  if (!poly) { g.fillRect(0, 0, w, h); return m; }
  const inset = () => { g.beginPath(); poly.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, p[0] - ox, p[1] - oy)); g.closePath(); g.fill(); };
  if ('filter' in g) { g.filter = `blur(${feather}px)`; inset(); g.filter = 'none'; return m; }
  // 필터 미지원 브라우저: 축소 후 확대로 부드럽게
  const s = document.createElement('canvas'); s.width = Math.max(1, w / 8 | 0); s.height = Math.max(1, h / 8 | 0);
  inset(); const sg = s.getContext('2d'); sg.drawImage(m, 0, 0, s.width, s.height);
  g.clearRect(0, 0, w, h); g.imageSmoothingQuality = 'high'; g.drawImage(s, 0, 0, w, h); return m;
}
async function paintEdit(cmd) {
  const pl = layerOfKind('paint'); if (!pl || !pl.visible) return false;
  const W = S.doc.w, H = S.doc.h;
  let [x0, y0, x1, y1] = S.sel ? S.sel.bbox : [0, 0, W, H];
  const pad = Math.max(24, Math.max(x1 - x0, y1 - y0) * 0.08);
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad)); x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
  const bw = x1 - x0, bh = y1 - y0; if (bw < 16 || bh < 16) return false;
  busy('명화 엔진이 이 부분을 다시 그리는 중');
  try {
    const cache = cacheFor(pl); if (cache.dirty) renderLayer(pl);
    const crop = document.createElement('canvas'); crop.width = bw; crop.height = bh;
    const cg = crop.getContext('2d'); cg.fillStyle = S.doc.bg; cg.fillRect(0, 0, bw, bh); cg.drawImage(cache.cvs, x0, y0, bw, bh, 0, 0, bw, bh);
    const ar = bw / bh, long = Math.min(1536, Math.max(512, Math.max(bw, bh)));
    const out = await callPaint({ mode: 'edit', image: toDataURL(crop, 500, 0.92), prompt: cmd, width: r16(ar >= 1 ? long : long * ar), height: r16(ar >= 1 ? long / ar : long) });
    const res = await loadImg(out);
    const patch = document.createElement('canvas'); patch.width = bw; patch.height = bh; const pg = patch.getContext('2d');
    pg.imageSmoothingQuality = 'high'; pg.drawImage(res, 0, 0, bw, bh);
    if (S.sel && S.sel.poly) { pg.globalCompositeOperation = 'destination-in'; pg.drawImage(featherMask(bw, bh, S.sel.poly, x0, y0, Math.max(6, Math.min(bw, bh) * 0.04)), 0, 0); }
    const full = document.createElement('canvas'); full.width = W; full.height = H; const fg = full.getContext('2d');
    fg.fillStyle = S.doc.bg; fg.fillRect(0, 0, W, H); fg.drawImage(cache.cvs, 0, 0); fg.drawImage(patch, x0, y0);
    pushHistory(); pl.img = full.toDataURL('image/jpeg', 0.92); pl.strokes = []; dirty(pl);
    renderLayers(); requestDraw(); scheduleSave();
    toast('원화의 해당 부분을 다시 그렸어요 (실행 취소로 되돌릴 수 있어요)');
  } catch (err) { toast('명화 엔진: ' + err.message); }
  finally { busy(null); }
  return true;
}

// ───────── AI 수정 (말로 부분 수정) ─────────
const COLORS = [['빨간', '#c8402f'], ['빨강', '#c8402f'], ['주황', '#e07b2e'], ['노란', '#e3b53c'], ['노랑', '#e3b53c'], ['초록', '#5b8f4e'], ['녹색', '#5b8f4e'], ['하늘', '#7fb2de'], ['파란', '#3d6fb6'], ['파랑', '#3d6fb6'], ['남색', '#22325e'], ['보라', '#7d5ba6'], ['분홍', '#e48aa6'], ['갈색', '#7a5236'], ['검정', '#1f1c19'], ['검은', '#1f1c19'], ['회색', '#7a7a7a'], ['흰', '#ffffff']];
function parseLocalEdit(t) {
  const has = (...w) => w.some(x => t.includes(x)); const ops = [];
  const wantsAdd = has('추가', '그려', '넣어', '그리기', '만들어', '채워');
  if (has('지워', '지우', '삭제', '없애', '빼줘', '빼 줘', '제거')) ops.push({ op: 'delete' });
  let widthDone = false;
  if (has('굵게', '두껍게', '두꺼', '굵은')) { ops.push({ op: 'width', factor: 1.5 }); widthDone = true; }
  if (has('얇게', '가늘게', '얇은', '가는 선')) { ops.push({ op: 'width', factor: 0.65 }); widthDone = true; }
  if (has('연하게', '흐리게', '옅게', '투명')) ops.push({ op: 'opacity', factor: 0.6 });
  else if (has('진하게', '짙게') && !widthDone) ops.push({ op: 'opacity', factor: 1.5 });
  for (const [k, c] of COLORS) if (t.includes(k + '색') || t.includes(k + ' 색') || (k.length > 1 && t.includes(k) && !wantsAdd)) { ops.push({ op: 'color', color: c }); break; }
  if (has('따뜻')) ops.push({ op: 'tone', tone: 'warm' });
  else if (has('차갑', '차가', '시원')) ops.push({ op: 'tone', tone: 'cool' });
  else if (has('파스텔')) ops.push({ op: 'tone', tone: 'pastel' });
  else if (has('흑백', '무채색')) ops.push({ op: 'tone', tone: 'mono' });
  else if (has('선명', '쨍하게')) ops.push({ op: 'tone', tone: 'vivid' });
  if (has('거칠', '러프', '자유롭')) ops.push({ op: 'roughen', amount: 1 });
  if (has('부드럽', '매끄럽', '정돈', '깔끔')) ops.push({ op: 'smooth' });
  if (has('단순', '간단', '간결')) ops.push({ op: 'simplify' });
  if (has('크게', '키워', '확대')) ops.push({ op: 'scale', factor: 1.2 });
  if (has('작게', '줄여', '축소')) ops.push({ op: 'scale', factor: 0.83 });
  const amt = has('조금', '살짝') ? 0.025 : 0.06;
  if (has('왼쪽으로')) ops.push({ op: 'move', dx: -amt, dy: 0 });
  if (has('오른쪽으로')) ops.push({ op: 'move', dx: amt, dy: 0 });
  if (has('위로')) ops.push({ op: 'move', dx: 0, dy: -amt });
  if (has('아래로', '밑으로')) ops.push({ op: 'move', dx: 0, dy: amt });
  return { ops: wantsAdd ? ops.filter(o => o.op !== 'color') : ops, needsAI: wantsAdd || !ops.length };
}
function editTarget(t) {
  const has = (...w) => w.some(x => t.includes(x));
  const tool = has('채색', '색칠', '물감', '수채') ? 'wash' : has('선을', '선이', '선은', '선만', '펜선', '선화', '라인', '테두리') ? 'pen' : null;
  if (S.sel && selCount()) return { map: S.sel.ids, label: '선택 영역' + (tool ? (tool === 'pen' ? '의 선' : '의 채색') : ''), tool };
  const kinds = [];
  if (has('채색', '색칠', '물감', '수채')) kinds.push('color');
  if (has('명암', '해칭', '그림자')) kinds.push('shade');
  if (has('선화', '선을', '선이', '펜선', '라인')) kinds.push('line');
  const map = new Map(); let label;
  if (kinds.length) { for (const l of S.doc.layers) if (kinds.includes(l.kind) && !l.locked) map.set(l.id, new Set(l.strokes.map(s => s.id))); label = kinds.map(k => KIND_LABEL[k]).join('·') + ' 전체'; }
  else { const a = activeLayer(); map.set(a.id, new Set(a.strokes.map(s => s.id))); label = `'${a.name}' 레이어 전체`; }
  return { map, label, tool: null };
}
function roughen(st, amt, R) {
  const P = st.pts, n = P.length, ph = R() * 6.28, A = 2.2 * amt;
  return { ...st, pts: P.map((p, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)]; let tx = b[0] - a[0], ty = b[1] - a[1]; const d = Math.hypot(tx, ty) || 1; const o = A * Math.sin(ph + i * 0.9) + (R() - 0.5) * A; return [Math.round((p[0] - ty / d * o) * 10) / 10, Math.round((p[1] + tx / d * o) * 10) / 10, p[2]]; }) };
}
function smoothSt(st) {
  let P = st.pts; if (P.length < 4) return st;
  for (let k = 0; k < 2; k++) P = P.map((p, i) => i === 0 || i === P.length - 1 ? p : [(P[i - 1][0] + p[0] * 2 + P[i + 1][0]) / 4, (P[i - 1][1] + p[1] * 2 + P[i + 1][1]) / 4, p[2]]);
  return { ...st, pts: P.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, p[2]]) };
}
function simplifySt(st) { if (st.pts.length < 4) return st; const q = resample(rdp(st.pts, 3), 8); return { ...st, pts: q.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round((p[2] ?? 0.7) * 100) / 100]) }; }
function applyOps(ops, target, addStrokes = []) {
  const valid = ops.filter(o => ['delete', 'width', 'opacity', 'color', 'tone', 'roughen', 'smooth', 'simplify', 'scale', 'move'].includes(o.op));
  if (!valid.length && !addStrokes.length) return 0;
  pushHistory();
  let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  for (const [lid, ids] of target.map) for (const st of L(lid)?.strokes || []) if (ids.has(st.id)) { const b = sbox(st); bx0 = Math.min(bx0, b[0]); by0 = Math.min(by0, b[1]); bx1 = Math.max(bx1, b[2]); by1 = Math.max(by1, b[3]); }
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, R = rng(Date.now() % 1e6);
  let changed = 0;
  if (valid.length) for (const l of S.doc.layers) {
    const ids = target.map.get(l.id); if (!ids || l.locked) continue;
    const out = [];
    for (const st0 of l.strokes) {
      if (!ids.has(st0.id) || (target.tool && st0.tool !== target.tool)) { out.push(st0); continue; }
      let st = st0, del = false; changed++;
      for (const o of valid) {
        if (o.op === 'delete') { del = true; break; }
        if (o.op === 'width') st = { ...st, width: Math.max(0.3, st.width * (+o.factor || 1)) };
        if (o.op === 'opacity') st = { ...st, opacity: Math.max(0.03, Math.min(1, (st.opacity ?? 1) * (+o.factor || 1))) };
        if (o.op === 'color' && /^#[0-9a-f]{6}$/i.test(o.color)) st = { ...st, color: o.color };
        if (o.op === 'tone') st = { ...st, color: applyTone(st.color, o.tone) };
        if (o.op === 'roughen') st = roughen(st, +o.amount || 1, R);
        if (o.op === 'smooth') st = smoothSt(st);
        if (o.op === 'simplify') st = simplifySt(st);
        if (o.op === 'scale') { const f = +o.factor || 1; st = mapPts(st, (x, y) => [cx + (x - cx) * f, cy + (y - cy) * f]); }
        if (o.op === 'move') { const dx = (+o.dx || 0) * S.doc.w, dy = (+o.dy || 0) * S.doc.h; st = mapPts(st, (x, y) => [x + dx, y + dy]); }
      }
      if (!del) out.push(st); else ids.delete(st0.id);
    }
    l.strokes = out; dirty(l);
  }
  for (const { layerKind, st } of addStrokes) {
    let l = (layerKind === 'line' ? (activeLayer().kind === 'user' ? activeLayer() : layerOfKind('line')) : layerOfKind(layerKind)) || activeLayer();
    if (l.locked) l = activeLayer();
    l.strokes = [...l.strokes, st]; dirty(l); changed++;
    if (S.sel) { if (!S.sel.ids.has(l.id)) S.sel.ids.set(l.id, new Set()); S.sel.ids.get(l.id).add(st.id); }
  }
  if (S.sel) { if (selCount()) { recomputeSelBox(); showSelBar(); } else clearSel(); }
  renderLayers(); requestDraw(); scheduleSave();
  return changed;
}
async function runEdit(cmd) {
  cmd = cmd.trim(); if (!cmd) return;
  const target = editTarget(cmd), local = parseLocalEdit(cmd);
  let total = 0; for (const s of target.map.values()) total += s.size;
  const pl = layerOfKind('paint');
  if (pl && pl.visible && (local.needsAI || (S.sel && !selCount()) || (!S.sel && activeLayer().kind === 'paint'))) {
    if (!S.paintApi) { toast('원화를 말로 고치려면 명화 엔진 연결이 필요해요'); return; }
    await paintEdit(cmd); return;
  }
  if (!local.needsAI) {
    const n = applyOps(local.ops, target);
    toast(n ? `${target.label}에 적용했어요 (획 ${n}개)` : '바꿀 획이 없어요'); return;
  }
  if (!S.api) {
    if (local.ops.length) { const n = applyOps(local.ops, target); toast(`가능한 부분만 적용했어요 (획 ${n}개). 새로 그려 넣기는 AI 연결 후 사용할 수 있어요`); }
    else toast('이 요청은 AI 연결이 필요해요. 지금은 "굵게, 지워, 따뜻하게, 거칠게, 파란색으로, 왼쪽으로" 같은 수정이 바로 돼요');
    return;
  }
  const bbox = S.sel ? S.sel.bbox.map(Math.round) : [0, 0, S.doc.w, S.doc.h];
  const colors = {}; for (const [lid, ids] of target.map) for (const st of L(lid)?.strokes || []) if (ids.has(st.id)) colors[st.color] = (colors[st.color] || 0) + 1;
  const summary = { selectedStrokes: total, scope: target.label, topColors: Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]) };
  busy('AI가 수정하는 중');
  try {
    const r = await fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'edit', command: cmd, bbox, doc: { w: S.doc.w, h: S.doc.h }, summary }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
    const [x0, y0, x1, y1] = bbox, bw = x1 - x0, bh = y1 - y0, R = rng(Date.now() % 1e6), rough = S.opts.roughness ?? 0.5;
    const ink = layerOfKind('line')?.style.ink || INKS[S.opts.ink] || INKS.ink;
    const add = [];
    for (const s of j.strokes || []) {
      if (!Array.isArray(s.points) || s.points.length < 2) continue;
      const pts = s.points.map(p => [x0 + p[0] * bw, y0 + p[1] * bh]);
      const kind = ['line', 'shade', 'color'].includes(s.layer) ? s.layer : 'line';
      let st;
      if (kind === 'color') st = washPolyline(pts, s.color || '#8fb8dd', Math.max(8, (s.width || 0.05) * Math.max(bw, bh)), s.opacity ?? 0.32);
      else st = sketchPolyline(pts, R, kind === 'shade' ? rough * 0.4 : rough, s.color || ink, kind === 'shade' ? 1.35 : (s.width && s.width < 12 ? s.width : 2.6), { overshoot: kind !== 'shade', opacity: kind === 'shade' ? 0.8 : 1 });
      if (st) add.push({ layerKind: kind, st });
    }
    const ops = (j.ops || []).filter(o => o && o.op);
    const n = applyOps(ops.length ? ops : local.ops, target, add);
    toast(j.message || `적용했어요 (획 ${n}개)`);
  } catch (err) { toast('AI 수정 실패: ' + err.message); }
  finally { busy(null); }
}
$('#btnAIGo').onclick = () => { const c = $('#aiCmd').value; closeAll(); runEdit(c); };
$$('#aiChips .chip').forEach(c => c.onclick = () => { $('#aiCmd').value = c.textContent; });

// ───────── 선택 바 ─────────
$('#sbDel').onclick = () => transformSel(() => null);
$('#sbThick').onclick = () => transformSel(st => ({ ...st, width: st.width * 1.35 }));
$('#sbThin').onclick = () => transformSel(st => ({ ...st, width: Math.max(0.3, st.width * 0.72) }));
$('#sbColor').onclick = () => transformSel(st => ({ ...st, color: S.brushSet[S.brushId].color }));
$('#sbDup').onclick = () => {
  if (!S.sel || !selCount()) return; pushHistory(); const nids = new Map();
  for (const l of S.doc.layers) { const ids = S.sel.ids.get(l.id); if (!ids) continue; const add = l.strokes.filter(s => ids.has(s.id)).map(s => ({ ...mapPts(s, (x, y) => [x + 30, y + 30]), id: uid() })); l.strokes = [...l.strokes, ...add]; nids.set(l.id, new Set(add.map(s => s.id))); dirty(l); }
  S.sel.ids = nids; recomputeSelBox(); showSelBar(); requestDraw(); scheduleSave();
};
$('#sbAI').onclick = () => openModal('#modal-ai');
$('#sbClose').onclick = () => clearSel();

// ───────── 저장 (IndexedDB) ─────────
const DB = {
  db: null,
  open() { return new Promise((res, rej) => { const r = indexedDB.open('sketchpick', 1); r.onupgradeneeded = () => r.result.createObjectStore('works', { keyPath: 'id' }); r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error); }); },
  tx(mode, fn) { return new Promise((res, rej) => { const t = this.db.transaction('works', mode), st = t.objectStore('works'); const q = fn(st); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); },
  put(o) { return this.tx('readwrite', s => s.put(o)); }, get(id) { return this.tx('readonly', s => s.get(id)); },
  all() { return this.tx('readonly', s => s.getAll()); }, del(id) { return this.tx('readwrite', s => s.delete(id)); },
};
function newWorkId() { S.workId = 'w' + Date.now().toString(36); }
let saveTimer = 0, viewTimer = 0;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1200); }
function scheduleViewSave() { clearTimeout(viewTimer); viewTimer = setTimeout(() => { try { localStorage.setItem('sp:view:' + S.workId, JSON.stringify(S.view)); } catch {} }, 600); }
function thumb() {
  const k = 360 / Math.max(S.doc.w, S.doc.h), c = document.createElement('canvas'); c.width = Math.round(S.doc.w * k); c.height = Math.round(S.doc.h * k);
  const g = c.getContext('2d'); g.scale(k, k); compose(g, S.doc.w, S.doc.h); return c.toDataURL('image/jpeg', 0.7);
}
async function saveNow() {
  clearTimeout(saveTimer); if (!DB.db || !S.doc) return;
  if (!S.doc.layers.some(l => l.strokes.length || l.img) && !S.source) return;
  try {
    await DB.put({ id: S.workId, title: $('#title').value.trim() || '새 작품', updated: Date.now(), thumb: thumb(), doc: S.doc, source: S.source, opts: S.opts, active: S.active });
    localStorage.setItem('sp:last', S.workId); $('#saveState').textContent = '저장됨';
  } catch (e) { console.warn(e); $('#saveState').textContent = '저장 실패'; }
}
async function openWork(id) {
  const w = await DB.get(id); if (!w) return false;
  S.workId = w.id; S.doc = w.doc; S.source = w.source || null; S.opts = { ...DEFAULT_OPTS, ...(w.opts || {}) }; S.active = w.active || S.doc.layers[S.doc.layers.length - 1].id;
  for (const l of S.doc.layers) { l.style = { widthScale: 1, ink: null, tone: 'original', ...(l.style || {}) }; l.blend = l.blend || 'source-over'; }
  $('#title').value = w.title; caches.clear(); resetHistory(); clearSel(); renderLayers(); syncStylePanel();
  let v = null; try { v = JSON.parse(localStorage.getItem('sp:view:' + id)); } catch {}
  if (v && v.s) { S.view = v; requestDraw(); } else fitView();
  localStorage.setItem('sp:last', id); return true;
}
async function startBlank() { await saveNow(); newWorkId(); S.doc = newDoc(); S.active = S.doc.layers[3].id; S.source = null; S.opts = { ...DEFAULT_OPTS }; $('#title').value = '새 작품'; caches.clear(); resetHistory(); clearSel(); renderLayers(); syncStylePanel(); fitView(); }
async function renderGallery() {
  const box = $('#galList'); box.innerHTML = '<div class="hint">불러오는 중…</div>';
  let works = []; try { works = (await DB.all()).sort((a, b) => b.updated - a.updated); } catch {}
  box.innerHTML = '';
  if (!works.length) { box.innerHTML = '<div class="hint">아직 저장된 작품이 없어요.</div>'; return; }
  for (const w of works) {
    const el = document.createElement('div'); el.className = 'gcard' + (w.id === S.workId ? ' on' : '');
    el.innerHTML = `<img alt=""><div class="gmeta"><b></b><small>${new Date(w.updated).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div><button class="gdel" title="삭제">${ICON.trash}</button>`;
    el.querySelector('img').src = w.thumb || ''; el.querySelector('b').textContent = w.title;
    el.onclick = async () => { await saveNow(); await openWork(w.id); closeAll(); };
    el.querySelector('.gdel').onclick = async ev => { ev.stopPropagation(); if (!confirm(`'${w.title}'을(를) 삭제할까요?`)) return; await DB.del(w.id); if (w.id === S.workId) { newWorkId(); } renderGallery(); };
    box.appendChild(el);
  }
}
$('#galNew').onclick = async () => { await startBlank(); closeAll(); };
$('#galPhoto').onclick = () => { closeAll(); openModal('#modal-generate'); };
$('#title').addEventListener('change', scheduleSave);

// ───────── 내보내기 ─────────
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const fname = ext => (($('#title').value.trim() || '스케치픽').replace(/[\\/:*?"<>|]/g, '') + '.' + ext);
$('#exPng').onclick = () => { const c = document.createElement('canvas'); c.width = S.doc.w; c.height = S.doc.h; compose(c.getContext('2d'), S.doc.w, S.doc.h); c.toBlob(b => shareOrDownload(b, fname('png')), 'image/png'); };
$('#exSvg').onclick = () => {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S.doc.w} ${S.doc.h}" width="${S.doc.w}" height="${S.doc.h}"><rect width="100%" height="100%" fill="${S.doc.bg}"/>`];
  for (const l of S.doc.layers) {
    if (!l.visible) continue;
    out.push(`<g id="${l.name.replace(/[<>&"]/g, '')}" opacity="${l.opacity}" style="mix-blend-mode:${l.blend === 'multiply' ? 'multiply' : 'normal'}">`);
    if (l.kind === 'paint') { const c = cacheFor(l); if (c.dirty) renderLayer(l); out.push(`<image href="${c.cvs.toDataURL('image/jpeg', 0.9)}" width="${S.doc.w}" height="${S.doc.h}"/></g>`); continue; }
    for (const st of l.strokes) {
      const c = strokeColor(st, l), P = st.pts;
      if (st.tool === 'wash') out.push(`<polyline fill="none" stroke="${c}" stroke-opacity="${st.opacity}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round" style="mix-blend-mode:multiply" points="${P.map(p => p[0] + ',' + p[1]).join(' ')}"/>`);
      else { const w = st.width * (l.style.widthScale || 1), avg = P.reduce((a, p) => a + (p[2] ?? 0.6), 0) / P.length; out.push(`<polyline fill="none" stroke="${c}" stroke-opacity="${st.opacity ?? 1}" stroke-width="${(w * avg).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" points="${P.map(p => p[0] + ',' + p[1]).join(' ')}"/>`); }
    }
    out.push('</g>');
  }
  out.push('</svg>'); shareOrDownload(new Blob([out.join('')], { type: 'image/svg+xml' }), fname('svg'));
};
$('#exProj').onclick = () => shareOrDownload(new Blob([JSON.stringify({ app: 'sketchpick', v: 1, title: $('#title').value, doc: S.doc, opts: S.opts })], { type: 'application/json' }), fname('sketchpick.json'));
$('#imProj').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
  try { const j = JSON.parse(await f.text()); if (j.app !== 'sketchpick' || !j.doc?.layers) throw 0; await saveNow(); newWorkId(); S.doc = j.doc; S.opts = { ...DEFAULT_OPTS, ...(j.opts || {}) }; S.source = null; S.active = S.doc.layers[S.doc.layers.length - 1].id; $('#title').value = j.title || '가져온 작품'; caches.clear(); resetHistory(); clearSel(); renderLayers(); syncStylePanel(); fitView(); await saveNow(); closeAll(); toast('작품을 열었어요'); }
  catch { toast('스케치픽 작품 파일이 아니에요'); }
});
$('#fingerDraw').addEventListener('change', e => { S.fingerDraw = e.target.checked; try { localStorage.setItem('sp:finger', S.fingerDraw ? '1' : ''); } catch {} });

// ───────── 그리는 과정 재생 · 영상 저장 (내가 그린 것처럼) ─────────
const RP = { plan: null, raf: 0, rec: null };
async function buildReplayPlan() {
  const W = S.doc.w, H = S.doc.h, paint = S.doc.layers.find(l => l.kind === 'paint' && l.visible && l.img);
  const vis = S.doc.layers.filter(l => l.visible);
  const area = st => { const b = sbox(st); return (b[2] - b[0]) * (b[3] - b[1]); };
  let lines = [], shade = [], color = [], user = [], reveal = null;
  for (const l of vis) {
    if (l.kind === 'paint') continue;
    const tagged = l.strokes.filter(st => st.tool !== 'erase').map(st => ({ st, l }));
    if (l.kind === 'line') lines.push(...tagged); else if (l.kind === 'shade') shade.push(...tagged); else if (l.kind === 'color') color.push(...tagged); else user.push(...tagged);
  }
  if (paint) {
    // 원화가 있으면: 추출 선화를 먼저 긋고, 붓질 모양으로 원화를 드러냄
    const ln = S.doc.layers.find(l => l.kind === 'line');
    if (ln && !ln.visible) lines = ln.strokes.map(st => ({ st, l: { ...ln, visible: true } }));
    const im = await loadImg(paint.img);
    const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(im, 0, 0, W, H);
    reveal = { img: c, strokes: (await photoToSketch(c, { ...DEFAULT_OPTS, wash: true, hatching: false, seed: 5 }, () => {})).color };
  }
  // 큰 형태부터, 위에서 아래로 — 사람이 그리는 순서처럼
  lines.sort((a, b) => area(b.st) - area(a.st));
  const big = lines.slice(0, Math.ceil(lines.length * 0.25)), rest = lines.slice(big.length).sort((a, b) => sbox(a.st)[1] - sbox(b.st)[1]);
  lines = big.concat(rest);
  color.sort((a, b) => (a.st.g ?? 0) - (b.st.g ?? 0) || sbox(a.st)[1] - sbox(b.st)[1]);
  const phases = [
    { kind: 'line', items: lines, dur: 0.42 },
    { kind: 'shade', items: shade, dur: 0.14 },
    reveal ? { kind: 'reveal', items: reveal.strokes, dur: 0.34 } : { kind: 'color', items: color, dur: 0.34 },
    { kind: 'user', items: user, dur: 0.1 },
  ].filter(p => p.items.length);
  const tot = phases.reduce((a, p) => a + p.dur, 0); phases.forEach(p => p.dur /= tot);
  return { W, H, phases, reveal, total: 12000 + Math.min(10000, lines.length * 4) };
}
function replayCanvas() {
  const cv2 = $('#replayCv'), W = Math.min(1600, S.doc.w), k = W / S.doc.w;
  cv2.width = W; cv2.height = Math.round(S.doc.h * k);
  return { cv2, k };
}
function playReplay(onDone) {
  cancelAnimationFrame(RP.raf);
  const { cv2, k } = replayCanvas(), g = cv2.getContext('2d'), P = RP.plan;
  const mk = () => { const c = document.createElement('canvas'); c.width = cv2.width; c.height = cv2.height; const x = c.getContext('2d'); x.setTransform(k, 0, 0, k, 0, 0); return [c, x]; };
  const [inkC, inkG] = mk(), [colC, colG] = mk(), [maskC, maskG] = mk(), [userC, userG] = mk();
  const done = P.phases.map(() => 0); let t0 = performance.now();
  const strokeBy = (ph, ctx2, it, frac) => {
    if (ph.kind === 'reveal') { ctx2.strokeStyle = '#000'; ctx2.lineCap = ctx2.lineJoin = 'round'; ctx2.lineWidth = it.width * 1.7; const pts = it.pts; const n = Math.max(2, Math.ceil(pts.length * frac)); ctx2.beginPath(); ctx2.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < n; i++) ctx2.lineTo(pts[i][0], pts[i][1]); ctx2.stroke(); return; }
    const { st, l } = it, n = Math.max(1, Math.ceil(st.pts.length * frac));
    drawStroke(ctx2, frac >= 1 ? st : { ...st, pts: st.pts.slice(0, n) }, l);
  };
  const frame = now => {
    const T = Math.min(1, (now - t0) / P.total);
    let acc = 0;
    P.phases.forEach((ph, pi) => {
      const local = Math.max(0, Math.min(1, (T - acc) / ph.dur)); acc += ph.dur;
      const target = local * ph.items.length, whole = Math.floor(target);
      const ctx2 = ph.kind === 'line' || ph.kind === 'shade' ? inkG : ph.kind === 'color' ? colG : ph.kind === 'reveal' ? maskG : userG;
      while (done[pi] < whole) { strokeBy(ph, ctx2, ph.items[done[pi]], 1); done[pi]++; }
      RP.partial = RP.partial || [];
      RP.partial[pi] = done[pi] < ph.items.length && target > whole ? [ph, ph.items[done[pi]], target - whole] : null;
    });
    // 합성
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.fillStyle = S.doc.bg; g.fillRect(0, 0, cv2.width, cv2.height);
    if (P.reveal) {
      const [tc, tg] = mk(); tg.setTransform(1, 0, 0, 1, 0, 0); tg.drawImage(maskC, 0, 0);
      const pr = RP.partial.find(x => x && x[0].kind === 'reveal'); if (pr) { tg.setTransform(k, 0, 0, k, 0, 0); strokeBy(pr[0], tg, pr[1], pr[2]); tg.setTransform(1, 0, 0, 1, 0, 0); }
      tg.globalCompositeOperation = 'source-in'; tg.drawImage(P.reveal.img, 0, 0, cv2.width, cv2.height);
      if (T >= 0.97) { tg.globalCompositeOperation = 'source-over'; tg.globalAlpha = (T - 0.97) / 0.03; tg.drawImage(P.reveal.img, 0, 0, cv2.width, cv2.height); }
      g.drawImage(tc, 0, 0);
    } else { g.globalCompositeOperation = 'multiply'; g.drawImage(colC, 0, 0); g.globalCompositeOperation = 'source-over'; }
    if (!P.reveal || T < 0.97) { g.globalAlpha = P.reveal ? Math.max(0, 1 - Math.max(0, T - 0.6) / 0.37) : 1; g.drawImage(inkC, 0, 0); g.globalAlpha = 1; }
    g.drawImage(userC, 0, 0);
    // 지금 긋는 중인 획
    g.setTransform(k, 0, 0, k, 0, 0);
    for (const pr of RP.partial || []) if (pr && pr[0].kind !== 'reveal') strokeBy(pr[0], g, pr[1], pr[2]);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (T < 1) RP.raf = requestAnimationFrame(frame); else { RP.partial = []; onDone && onDone(); }
  };
  RP.partial = []; RP.raf = requestAnimationFrame(frame);
}
async function openReplay() {
  if (!S.doc.layers.some(l => l.strokes.length || l.img)) return toast('먼저 그림을 그려 주세요');
  busy('그리는 순서를 정리하는 중');
  try { RP.plan = await buildReplayPlan(); } finally { busy(null); }
  openModal('#modal-replay'); playReplay();
}
$('#exReplay').onclick = () => openReplay();
$('#replayPlay').onclick = () => playReplay();
$('#replayRec').onclick = () => {
  const cv2 = $('#replayCv');
  if (!cv2.captureStream || !window.MediaRecorder) return toast('이 브라우저는 영상 저장을 지원하지 않아요');
  const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) return toast('이 브라우저는 영상 저장을 지원하지 않아요');
  const rec = new MediaRecorder(cv2.captureStream(30), { mimeType: type, videoBitsPerSecond: 6e6 }), chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => { $('#replayRec').disabled = false; $('#replayRec').textContent = '영상으로 저장'; shareOrDownload(new Blob(chunks, { type: type.split(';')[0] }), fname(type.includes('mp4') ? 'mp4' : 'webm')); };
  $('#replayRec').disabled = true; $('#replayRec').textContent = '녹화 중…';
  rec.start(500);
  playReplay(() => setTimeout(() => rec.stop(), 1200));
};

// ───────── 패널/모달 ─────────
function closeAll() { cancelAnimationFrame(RP.raf); $('#brushLib').hidden = true; $$('.panel,.modal').forEach(p => p.hidden = true); $$('#topbar .tb-btn').forEach(b => b.classList.remove('on')); $('#scrim').hidden = true; }
function togglePanel(sel, btn) { const p = $(sel), open = p.hidden; closeAll(); if (open) { p.hidden = false; btn?.classList.add('on'); } }
function openModal(sel) { closeAll(); $(sel).hidden = false; $('#scrim').hidden = false; if (sel === '#modal-ai') { $('#aiScope').textContent = S.sel ? (selCount() ? `선택한 ${selCount()}개 획에 적용` : '선택한 빈 영역에 그려 넣기') : '선택 없음 — "채색/선화/명암" 같은 단어로 대상을 지정하거나, 현재 레이어 전체에 적용돼요'; $('#aiApi').hidden = S.api; setTimeout(() => $('#aiCmd').focus(), 50); } if (sel === '#modal-gallery') renderGallery(); if (sel === '#modal-mine') renderMine(); }
$('#btnLayers').onclick = e => togglePanel('#panel-layers', e.currentTarget);
$('#btnStyle').onclick = e => { syncStylePanel(); togglePanel('#panel-style', e.currentTarget); };
$('#btnExport').onclick = e => togglePanel('#panel-export', e.currentTarget);
$('#btnGenerate').onclick = () => openModal('#modal-generate');
$('#btnAI').onclick = () => openModal('#modal-ai');
$('#btnGallery').onclick = () => openModal('#modal-gallery');
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnFit').onclick = fitView;
$$('[data-close]').forEach(b => b.onclick = closeAll);
$('#scrim').onclick = closeAll;

let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
function busy(msg) { const b = $('#busy'); if (msg) { $('#busyText').textContent = msg; b.hidden = false; } else b.hidden = true; }

const ICON = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.3 6.3A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.7-1.8"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

// ───────── 시작 ─────────
(async function init() {
  try { S.fingerDraw = localStorage.getItem('sp:finger') === '1'; $('#fingerDraw').checked = S.fingerDraw; } catch {}
  resize();
  let opened = false;
  // 들어올 때마다 새 종이로 시작 — 이전 작품은 자동 저장돼 있고 '작품'에서 이어서 열 수 있음
  try { await DB.open(); } catch (e) { console.warn('IndexedDB', e); toast('이 브라우저에서는 자동 저장이 꺼져 있어요'); }
  if (!opened) { newWorkId(); S.doc = newDoc(); S.active = S.doc.layers[3].id; renderLayers(); syncStylePanel(); fitView(); }
  loadBrushPrefs(); S.tool = 'eraser'; setTool('draw'); updateUndoUI();
  fetch('/api/ai').then(r => r.ok ? r.json() : { ready: false }).then(j => { S.api = !!j.ready; }).catch(() => {});
  fetch('/api/paint').then(r => r.ok ? r.json() : { ready: false }).catch(() => ({ ready: false })).then(j => {
    S.paintApi = !!j.ready;
    $$('.ai-badge').forEach(b => b.textContent = '');
    $('#engMaster').checked = S.paintApi; $('#engQuick').checked = !S.paintApi;
    $('#engMasterNote').textContent = S.paintApi ? '최고 품질 · 하루 사용량 제한' : '준비 중';
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  setTimeout(() => { $('#splash').classList.add('out'); setTimeout(() => $('#splash').remove(), 600); if (!opened) setTimeout(() => openModal('#modal-generate'), 500); }, 1300);
})();
if (location.hostname === 'localhost') window.__sp = S;

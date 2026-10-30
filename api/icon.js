// 홈 화면 아이콘(PNG)을 코드로 그려서 돌려준다 — 이미지 파일 없이 동작
import zlib from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
export function iconPNG(S = 180) {
  const k = S / 64, bg = [23, 72, 201];
  const path = [[12, 48], [23, 22], [33, 40], [40, 29], [52, 48]].map(([x, y]) => [x * k, y * k]);
  const lw = 1.8 * k, cx = 45 * k, cy = 17 * k, cr = 4.6 * k, cw = 1.5 * k;
  const raw = Buffer.alloc((S * 3 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 3 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      let d = 1e9;
      for (let i = 1; i < path.length; i++) d = Math.min(d, segDist(px, py, ...path[i - 1], ...path[i]));
      const a1 = Math.max(0, Math.min(1, lw + 0.5 - d));
      const a2 = Math.max(0, Math.min(1, cw + 0.5 - Math.abs(Math.hypot(px - cx, py - cy) - cr)));
      const a = Math.max(a1, a2), o = y * (S * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bg[c] * (1 - a) + 255 * a);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export default function handler(req, res) {
  const size = Math.max(32, Math.min(1024, parseInt(req.query?.s, 10) || 180));
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).send(iconPNG(size));
}

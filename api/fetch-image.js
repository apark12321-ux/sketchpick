// 이미지 주소(URL)를 받아 서버에서 가져와 data URL로 돌려준다 (브라우저 CORS 우회용, 내부망 주소 차단)
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivate(ip) {
  if (net.isIPv6(ip)) { const v = ip.toLowerCase(); return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.'); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export default async function handler(req, res) {
  try {
    const url = new URL(String(req.query?.url || ''));
    if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'http(s) 주소만 가능해요' });
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) return res.status(400).json({ error: '가져올 수 없는 주소예요' });
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 SketchPick' } });
    clearTimeout(t);
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok) return res.status(400).json({ error: `이미지를 못 가져왔어요 (${r.status})` });
    if (!ct.startsWith('image/')) return res.status(400).json({ error: '이미지 주소가 아니에요 (이미지를 길게 눌러 "이미지 주소 복사"로 넣어 주세요)' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: '8MB보다 큰 이미지예요' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dataUrl: `data:${ct};base64,${buf.toString('base64')}` });
  } catch (e) {
    return res.status(400).json({ error: e.name === 'AbortError' ? '응답이 너무 느려요' : '주소를 확인해 주세요' });
  }
}

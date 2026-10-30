// 스케치픽 명화 엔진 — Cloudflare Workers AI(FLUX.2, 무료 일일 할당량)로 사진을 거장급 어반스케치로 그린다.
// 필요한 Vercel 환경변수: CF_ACCOUNT_ID, CF_API_TOKEN (Cloudflare 무료 계정)
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const MODELS = [
  { id: '@cf/black-forest-labs/flux-2-dev', steps: 28 },
  { id: '@cf/black-forest-labs/flux-2-klein-9b' },
  { id: '@cf/black-forest-labs/flux-2-klein-4b' },
];

const MASTER = [
  'A masterful urban sketch painted on location by a celebrated plein-air artist with fifty years of experience',
  'confident, economical fountain-pen ink linework with lively varied line weight, slightly broken and overshooting lines, accurate two-point perspective',
  'selective detail: crisp focal point, loosely suggested edges and figures elsewhere',
  'transparent watercolor washes laid over the ink, wet-in-wet blooms, soft bleeds, pigment granulation, deliberate unpainted white paper for highlights and sky',
  'limited harmonious palette, luminous shadows with cool violet-blue, warm sunlit planes',
  'visible cold-press watercolor paper texture, hand-made, gallery-quality sketchbook page, no text, no signature, no watermark, not a photo, not digital art, not 3D',
].join(', ');

function dataUrlToBlob(u) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(u || '');
  if (!m) return null;
  return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
}

async function runModel(model, fields, acc, token) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, v);
  if (model.steps) form.append('steps', String(model.steps));
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/${model.id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    let msg = r.status + '';
    try { const j = await r.json(); msg = j?.errors?.[0]?.message || JSON.stringify(j).slice(0, 300); } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  if (ct.startsWith('image/')) return 'data:' + ct + ';base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
  const j = await r.json();
  const img = j?.result?.image || j?.image;
  if (!img) throw new Error('이미지가 오지 않았어요');
  return img.startsWith('data:') ? img : 'data:image/jpeg;base64,' + img;
}

export default async function handler(req, res) {
  const acc = process.env.CF_ACCOUNT_ID, token = process.env.CF_API_TOKEN;
  if (req.method === 'GET') return res.status(200).json({ ready: !!(acc && token) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!acc || !token) return res.status(501).json({ error: '명화 엔진 키가 설정되지 않았어요' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const clamp16 = v => Math.max(256, Math.min(1920, Math.round((+v || 1024) / 16) * 16));
    const width = clamp16(b.width), height = clamp16(b.height);
    const style = String(b.style || '').slice(0, 500);
    const user = String(b.prompt || '').slice(0, 500);
    const preset = String(b.preset || '').slice(0, 300);
    const imgs = (Array.isArray(b.images) ? b.images : b.image ? [b.image] : []).slice(0, 4).map(dataUrlToBlob).filter(Boolean);
    const nRef = Math.max(0, imgs.length - (b.hasSubject ? 1 : 0));
    const HAND = 'It must look genuinely hand-made by a human on paper: imperfect slightly wobbly lines, uneven pressure, a few overshooting construction lines, unevenly mixed paint, nothing perfectly uniform, no digital gradients, not AI-looking';
    let refText = '';
    if (nRef) {
      const ids = Array.from({ length: nRef }, (_, i) => 'image ' + (i + (b.hasSubject ? 1 : 0))).join(', ');
      refText = b.refMode === 'mine'
        ? `${ids} are drawings made by the artist's own hand. Reproduce that exact person's hand and habits: their line weight, wobble, hatching, how loosely or tightly they paint, their palette and their paper, so the new picture looks drawn by the very same hand. Do not copy the subjects of those images.`
        : `Use ${ids} only as style references: match their medium, line quality, colour palette and mood. Do not copy their subjects.`;
    }
    let prompt;
    if (b.mode === 'edit') {
      prompt = `This is a crop of a hand-painted urban sketch (ink and watercolor). ${user}. Keep the exact same painting style, ink line quality, paper texture, palette and lighting so the result blends seamlessly with the surrounding painting. ${MASTER}`;
    } else if (b.hasSubject || (b.image && !b.images)) {
      prompt = `Redraw the scene in image 0 (a photo) as a hand-drawn artwork. Keep its composition, buildings, people, objects and their positions. Medium and style: ${preset || MASTER}. ${refText} ${style} ${user}. ${HAND}`;
    } else {
      prompt = `A hand-drawn artwork. Subject: ${user}. Medium and style: ${preset || MASTER}. ${refText} ${style}. ${HAND}`;
    }
    const fields = { prompt: prompt.slice(0, 2500), width: String(width), height: String(height), seed: String(b.seed ?? Math.floor(Math.random() * 1e9)) };
    imgs.forEach((blob, i) => { fields['input_image_' + i] = blob; });
    let lastErr;
    for (const m of MODELS) {
      try { const out = await runModel(m, fields, acc, token); return res.status(200).json({ image: out, model: m.id }); }
      catch (e) { lastErr = e; if (e.status === 401 || e.status === 403) break; }
    }
    const quota = /neuron|quota|limit|429/i.test(lastErr?.message || '') || lastErr?.status === 429;
    return res.status(502).json({ error: quota ? '오늘의 무료 생성량을 다 썼어요 (내일 다시 쓸 수 있어요)' : '명화 엔진 오류: ' + (lastErr?.message || '') });
  } catch (e) {
    return res.status(500).json({ error: e.message || '처리 오류' });
  }
}

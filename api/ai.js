// 스케치픽 AI 엔드포인트 — Vercel 환경변수 ANTHROPIC_API_KEY 가 있으면 동작
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const EDIT_SYSTEM = `You are the editing engine of an urban-sketch drawing app. The user selected a region of an editable vector sketch and gave a command in Korean.
Return ONLY a JSON object, no prose:
{"message":"짧은 한국어 결과 설명","ops":[...],"strokes":[...]}
ops (applied to the selected existing strokes, may be empty):
 {"op":"delete"} | {"op":"width","factor":1.5} | {"op":"opacity","factor":0.6} | {"op":"color","color":"#rrggbb"} |
 {"op":"tone","tone":"warm|cool|pastel|vivid|mono"} | {"op":"roughen","amount":1} | {"op":"smooth"} | {"op":"simplify"} |
 {"op":"scale","factor":1.2} | {"op":"move","dx":0.05,"dy":0}   (dx,dy = fraction of whole canvas)
strokes (NEW strokes to draw inside the selection box, may be empty):
 {"layer":"line|shade|color","color":"#rrggbb","width":number,"opacity":number,"points":[[u,v],...]}
 u,v are 0..1 inside the selection box (0,0 = top-left). line = pen contour (width 1.5-4, ink color), shade = short parallel hatching lines (2 points each), color = loose watercolor brush (width = fraction of box size, e.g. 0.06; opacity 0.25-0.4).
Draw like an urban sketcher: confident contours, simple shapes, slight perspective, loose wash that does not exactly follow the lines. For "add X" requests produce 15-120 strokes, each 2-25 points. Keep JSON compact (numbers with max 3 decimals).`;

const SCENE_SYSTEM = `You are an urban-sketch illustrator that draws with vector strokes. Canvas is 1000 x 750 (x right, y down).
Return ONLY a JSON object: {"message":"짧은 한국어 설명","strokes":[{"layer":"line|shade|color","color":"#rrggbb","width":number,"points":[[x,y],...]}]}
- line: ink contours in dark ink (#24201c), width 1.5-3.5. Use correct perspective (horizon around y=300-420), straight architectural edges, windows, signs, street, cars, a few simple people, trees as loose scribbles.
- shade: hatching lines in shadows (2 points each, parallel, ~45 degrees), width 1.2.
- color: watercolor wash strokes, width 20-70, muted urban-sketch palette, loosely covering areas, leave white paper for highlights and sky gaps.
Aim for 220-450 strokes total, each 2-20 points. Integers only. Compact JSON.`;

function extractJSON(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI 응답 형식 오류');
  return JSON.parse(text.slice(a, b + 1));
}

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return res.status(200).json({ ready: !!key });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!key) return res.status(501).json({ error: 'AI 키가 설정되지 않았어요' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    let system, user, max;
    if (body.mode === 'scene') {
      system = SCENE_SYSTEM; max = 20000;
      user = `장면 설명: ${String(body.description || '').slice(0, 600)}\n스타일: ${JSON.stringify(body.style || {})}`;
    } else {
      system = EDIT_SYSTEM; max = 8000;
      user = `명령: ${String(body.command || '').slice(0, 400)}\n선택 상자(문서 좌표 x0,y0,x1,y1): ${JSON.stringify(body.bbox)}\n문서 크기: ${JSON.stringify(body.doc)}\n선택 요약: ${JSON.stringify(body.summary || {})}`;
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j?.error?.message || 'AI 호출 실패' });
    const text = (j.content || []).map(c => c.text || '').join('');
    return res.status(200).json(extractJSON(text));
  } catch (e) {
    return res.status(500).json({ error: e.message || 'AI 처리 오류' });
  }
}

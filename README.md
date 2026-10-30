# 스케치픽 (SketchPick)

사진·참고 이미지·내 화풍으로 "내가 그린 것 같은" 어반스케치를 만들고, 아이패드에서 이어서 다듬는 웹앱.

- 정적 사이트 + Vercel 서버리스 함수(`api/`)
- 명화 엔진: Cloudflare Workers AI(FLUX.2) — 환경변수 `CF_ACCOUNT_ID`, `CF_API_TOKEN`
- (선택) 말로 수정: `ANTHROPIC_API_KEY`

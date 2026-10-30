// 배포용 빌드: 소스를 하나로 묶고 난독화해 public/ 으로 내보냄 (소스 구조·처리 방식 노출 방지)
import { build } from 'esbuild';
import { minify } from 'terser';
import fs from 'node:fs';
fs.rmSync('public', { recursive: true, force: true }); fs.mkdirSync('public');
const r = await build({ entryPoints: ['js/app.js'], bundle: true, format: 'esm', target: 'safari15', write: false, charset: 'utf8', legalComments: 'none' });
const m = await minify(r.outputFiles[0].text, { module: true, compress: { passes: 2, drop_console: false }, mangle: { toplevel: true }, format: { comments: false } });
fs.writeFileSync('public/a.js', m.code);
const css = await build({ entryPoints: ['style.css'], minify: true, write: false });
fs.writeFileSync('public/s.css', css.outputFiles[0].text);
let html = fs.readFileSync('index.html', 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s+/g, '\n');
fs.writeFileSync('public/index.html', html);
for (const f of ['manifest.webmanifest', 'icon.svg']) fs.copyFileSync(f, 'public/' + f);
console.log('built', fs.statSync('public/a.js').size);

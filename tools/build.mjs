// Сборка одного HTML-файла для публикации (Artifact) и для раздачи одним файлом.
// Запуск: node tools/build.mjs
//   dist/frame-journey.html   — содержимое без <html>/<head>/<body> (обёртку добавляет Artifact)
//   dist/frame-journey.standalone.html — полный документ одним файлом
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'style.css'), 'utf8');

const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
const js = scripts.map(src => `/* ==== ${src} ==== */\n` + readFileSync(join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script')).join('\n');

const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

const headKeep = head
  .split('\n')
  .filter(l => !/<meta charset|<meta name="viewport"|rel="stylesheet" href="style.css"/.test(l))
  .join('\n')
  .trim();
const bodyNoScripts = body.replace(/<script src="[^"]+"><\/script>\s*/g, '').trim();

const inner = `${headKeep}
<style>
${css}
</style>
${bodyNoScripts}
<script>
${js}
</script>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'frame-journey.html'), inner);
const standalone = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${headKeep}
<style>
${css}
</style>
</head>
<body>
${bodyNoScripts}
<script>
${js}
</script>
</body>
</html>
`;
writeFileSync(join(root, 'dist', 'frame-journey.standalone.html'), standalone);
console.log('dist/frame-journey.html', (inner.length / 1024).toFixed(0) + ' КБ,', scripts.length, 'скриптов');

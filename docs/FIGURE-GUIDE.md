# Как писать главу «Пути кадра»

Проект — одна страница `index.html` без сборки, открывается двойным кликом (`file://`) и публикуется как Artifact. Прочитай перед работой: `docs/superpowers/specs/2026-09-25-frame-journey-design.md`, `docs/research/*.md` (факты — только оттуда или из первоисточников, которые проверил сам).

## Жёсткие правила
- Обычные скрипты, без `type="module"`, без `import`, без `fetch` локальных файлов. Каждый файл — IIFE: `(function (root) { 'use strict'; const FJ = root.FJ; … })(window);`. Чистая логика, которую тестируем в node, заканчивается `if (typeof module !== 'undefined') module.exports = …` и оборачивается в `(typeof window !== 'undefined' ? window : globalThis)`.
- Не трогай чужие файлы: `index.html`, `style.css`, `js/00-util.js`, `js/01-charts.js`, `js/02-sources.js`, `js/10-film.js`, `js/2*`, `js/3*` и чужие главы. Стили главы добавляй через `FJ.addStyle(css)` в своём файле, с префиксом классов главы (например `.cdn-…`).
- Новые источники регистрируй в своём файле: `FJ.sources['my-key'] = ['Название', 'https://…'];` до вызова `FJ.cite('my-key')`.
- Весь текст — на русском, коротко, главное в начале. Типографика: «ёлочки», длинное тире с пробелами ( — ), неразрывный пробел `&nbsp;` после коротких предлогов и союзов (в, к, с, и, а, но, на, по, за, от, до, из, не, о, у) и между числом и единицей (`4&nbsp;Гц`), буква «ё», диапазоны через короткое тире (5–10), без висячих предлогов в заголовках.
- Только проверенные факты со ссылкой `FJ.cite(key)`. Иллюстративные числа подписывай «иллюстративно» / «модель». Реальные компании — только в фактах; наш сервис вымышленный, без названия бренда.
- Никаких `alert/confirm/prompt`, `console.log` в финале, ошибок в консоли. `localStorage` — только через `FJ.store`.
- Функциональный текст ≥ 12 px, абзацы ≥ 14 px. Капс только для коротких меток. Цветное свечение (`box-shadow`/`text-shadow` цветом) на элементах интерфейса запрещено; свечение внутри холста, где оно физически оправдано, — можно. В CSS анимируй только `transform` и `opacity`. Иконки — inline SVG, без эмодзи.
- Мобильная ширина 390 px: без горизонтальной прокрутки, колонки складываются, зоны нажатия ≥ 40 px.
- Производительность: `frame()` вызывается только пока фигура видна; держи ≤ 4 мс на кадр, не создавай лишних объектов в цикле.

## Регистрация фигуры
```js
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  FJ.figure({
    id: 'cdn', el: $('#fig-cdn'),
    mount(el) {           // один раз при загрузке: собрать DOM внутри el, написать текст главы в #cdnText
      $('#cdnText').innerHTML = `<p>… ${FJ.cite('oc')}</p>`;
    },
    start() { },          // фигура стала видимой
    stop() { },           // ушла из вида
    frame(dt, t) { },     // каждый кадр, пока видна; dt — секунды
  });
})(window);
```
Контейнеры глав уже есть в `index.html`: `#masterText/#fig-master`, `#shotsText/#fig-shots`, `#codecText/#fig-codec`, `#ladderText/#fig-ladder`, `#packText/#fig-pack`, `#cdnText/#fig-cdn` (во всю ширину), `#playerText/#fig-race` (во всю ширину), `#tvText/#fig-tv` (во всю ширину), `#liveText/#fig-live` (слева текст, справа фигура), `#scaleText/#fig-scale`. Текстовые контейнеры имеют класс `prose` (абзацы `<p>`, списки `<ul>`, `<strong>`, `<code>`).

## API
- `FJ.h(tag, attrs, children)` — создать элемент (`class`, `text`, `html`, `style: {'--c': 'var(--q1)'}`, `onclick`…); `FJ.$`, `FJ.$$`.
- `FJ.fmt`: `num(x, d)`, `int`, `kbps(bps)`, `mbps(bps)`, `rate(bps)` (кбит/Мбит/Гбит/Тбит), `bytes(b)`, `sec(s, d)`, `ms(s)`, `pct(x)`, `db(x)`, `tc(frame, fps)`, `plural(n, 'сегмент', 'сегмента', 'сегментов')`, `NB` (неразрывный пробел).
- `FJ.canvas(hostEl, {maxDpr})` → `{cv, ctx, w, h, dpr, fit(), clear(color)}`; у хоста должна быть высота из CSS (`height` или `aspect-ratio`); холст следит за размером сам.
- `FJ.Plot(ctx, {l,t,w,h}, {min,max,log?}, {min,max,log?})`: `sx/sy/ix/iy`, `gridX/gridY(ticks)`, `labelsX/labelsY(ticks, fmt)`, `frame()`, `line(pts, color, width, dash)`, `step(pts, color, width)`, `area(pts, color, base)`, `dot(x, y, r, color)`, `text(x, y, s, {px, align, color, size})`, `clip(fn)`. `FJ.ticks(min, max, n)`, `FJ.rrect(ctx, x, y, w, h, r)`.
- Цвета холста: `FJ.colors.ground, 'ground-2', panel, 'panel-2', bezel, line, 'line-2', text, 'text-2', muted, red, amber, blue, violet, q1…q5` и массив `FJ.colors.q` (качества 720p…180p = полосы SMPTE по убыванию яркости). `FJ.alpha(hex, a)`.
- Шрифты холста: `FJ.font.mono(px, weight)`, `FJ.font.text(px, w)`, `FJ.font.display(px, w)` (узкий заголовочный), `FJ.font.led(px)` (таймкоды, сейчас это тот же JetBrains Mono).
- Контролы: `FJ.seg(host, [{v, label, chip?}], value, onChange, {small})`, `FJ.slider(host, {id, label, min, max, step, value, fmt, onInput})`, `FJ.toggle(host, {id, label, value, onChange})`, кнопки `<button class="btn">` / `.btn.primary`.
- `FJ.rng(seed)` — детерминированный генератор: `r()`, `r.range(a,b)`, `r.int`, `r.gauss()`, `r.pick`. `FJ.math.clamp/lerp/smoothstep/ease`.
- `FJ.cite(key)` → сноска; `FJ.sources[key] = [title, url]`.
- Данные движка (если нужны): `FJ.asset` (лесенка `ladder[r] = {name, w, h, kbps}`, `segs[r][k].bytes`, `avgKbps(r)`, `peakKbps(r)`, `segDur` = 2, `segCount` = 32, `on('done'|'segment'|'progress', fn)`), `FJ.film` (`shots`, `render(i)` → canvas 1280×720, `FPS` = 24), `FJ.net` (`makeTrace(id)`, `capacityAt`, `downloadEnd`), `FJ.devices`, `FJ.Player`.

## CSS-классы
`.fig`, `.fig__canvas`, `.fig__bar`, `.panel`, `.panel-pad`, `.stat-row` + `.stat` (`<b>` число, `<span>` подпись), `.kv` (`<dl>` с `<dt>/<dd>`), `.meter` (`<i style="--v:.5">`), `.legend` (`<span><i style="--c:…"></i>текст</span>`), `.caption`, `.notice`, `.tbl-wrap` + `table.tbl`, `.code` (`<pre>`: `.k`, `.v`, `.c`, `.new`), `.monitor` + `.monitor__screen` + `.umd` + `.tally(.on/.warn)` + `.chip`, `.row`, `.stack`, `.stack-l`, `.eyebrow`, `.ctl-label`, `h3`.
Палитра: фон `#17181a`, панели `#212226`, линии `#33353a`, текст `#ecebe6`/`#bfc0c3`/`#8f9197`, красный `#ff4d3d` (плейхед, отказ), янтарный `#ffb02e` (буфер, предупреждение), синий `#6fb3ff` (сеть), фиолетовый `#a58bff` (оценка). Скругления маленькие: 2–4 px, мониторы 6 px. Шрифты: заголовки Sofia Sans Extra Condensed, текст Golos Text, данные JetBrains Mono.

## Проверка
- Синтаксис: `node --check js/<file>.js`. Логика: `node --test tests/*.test.js` (пиши свои `tests/<name>.test.js`).
- Не пользуйся браузерными инструментами — визуальную проверку делает ведущий. Страница доступна на `http://127.0.0.1:8766/index.html`, если нужен curl.

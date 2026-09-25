/* =====================================================================
   56-cdn — глава «Раздача»: карта-созвездие сети доставки.
   Модель — js/40-cdn.js (FJ.cdn): направление зрителей, кэши по Ципфу
   (LRU по Че и предзаливка), шилды, очередь ориджина, лавина премьеры.
   Здесь — отрисовка карты и частиц потоков, графики, управление, текст.
   Шилды и ориджин нарисованы «поднятыми» над своим городом: высота —
   это ярус сети, а не география.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const cdn = FJ.cdn;
  const K = cdn.K, NB = fmt.NB;
  const E = cdn.EDGES.length, S = cdn.SHIELDS.length, R = cdn.REGIONS.length, NN = E + S + 1, OR = E + S;

  const CPCT = [1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90];
  const DEF = { mode: 'lru', cIdx: 10, alpha: 0.8, sigma: 0.5, collapse: false, hour: 21 };
  const SPD = { day: 600, fail: 40, prem: 2, premMid: 12 };
  // порядок, в котором кнопка роняет узлы
  const DROP = ['spb', 'ekb', 'kzn', 'nsk', 'krd', 'rnd', 'vvo', 'smr', 'chl', 'krs', 'nn', 'irk', 'msk2', 'msk1'];
  const PMAX = 2600;
  const BG = '#060708';
  const DASH = [3, 3], DASH2 = [2, 3], NODASH = [];

  FJ.sources['oc-site'] = ['Netflix Open Connect: «18K+ servers in 6K+ locations»', 'https://openconnect.netflix.com/en/'];
  FJ.sources['oc-apnic'] = ['APNIC Blog. Netflix content distribution through Open Connect (20.06.2018)', 'https://blog.apnic.net/2018/06/20/netflix-content-distribution-through-open-connect/'];

  FJ.addStyle(`
    .cdn { display: grid; gap: 14px; min-width: 0; }
    .cdn-stats .stat b { font-size: 32px; white-space: nowrap; }
    .cdn-stats .stat b small { font-family: var(--f-mono); font-size: 13px; font-weight: 500; color: var(--text-2); margin-left: 6px; letter-spacing: .02em; }
    .cdn-stats .stat.is-bad b { color: var(--red); }
    .cdn-stats .stat.is-warn b { color: var(--amber); }
    .cdn-spark { position: relative; height: 26px; margin-top: 2px; }
    .cdn-spark canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .cdn-main { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
    @media (min-width: 1100px) { .cdn-main { grid-template-columns: minmax(0, 1fr) 340px; } }
    .cdn-mon { display: flex; flex-direction: column; min-width: 0; }
    .cdn-screen { aspect-ratio: auto; height: 380px; flex: 1 1 auto; background: ${BG}; }
    @media (min-width: 700px) { .cdn-screen { height: 480px; } }
    @media (min-width: 1100px) { .cdn-screen { height: auto; min-height: 560px; } }
    .cdn-screen canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .cdn-screen.is-hot canvas { cursor: pointer; }
    .cdn-stage { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    .cdn-hud { position: absolute; z-index: 1; left: 8px; top: 8px; right: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; pointer-events: none; font-family: var(--f-mono); font-size: 12px; color: #fff; }
    .cdn-hud:empty { display: none; }
    @media (min-width: 620px) { .cdn-hud { justify-content: flex-end; left: 30%; } }
    @media (max-width: 619px) { .cdn-hud { position: static; padding: 6px 0 0; } .cdn-tag { background: #111214; } }
    .cdn-tag { background: rgba(8, 8, 9, .8); padding: 4px 8px; border-radius: 2px; display: inline-flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; line-height: 1.4; max-width: 100%; }
    .cdn-tag b { font-weight: 600; letter-spacing: .06em; color: var(--text); }
    .cdn-tag.is-bad b { color: var(--red); }
    .cdn-tag.is-warn b { color: var(--amber); }
    .cdn-tag.is-ok b { color: var(--q4); }
    .cdn-tag span { color: var(--text-2); }
    .cdn-tip { position: absolute; z-index: 2; left: 0; top: 0; pointer-events: none; max-width: 270px; background: rgba(12, 13, 14, .95); border: 1px solid var(--line-2); border-radius: 3px; padding: 8px 10px; font-family: var(--f-mono); font-size: 12px; line-height: 1.5; color: var(--text-2); opacity: 0; transition: opacity .12s var(--ease); }
    .cdn-tip.is-on { opacity: 1; }
    .cdn-tip b { color: var(--text); font-weight: 600; }
    .cdn-tip .red { color: var(--red); }
    .cdn-legendbar { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 4px 6px; font-family: var(--f-mono); font-size: 12px; color: var(--text-2); }
    .cdn-legendbar span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .cdn-legendbar svg { width: 12px; height: 12px; flex: none; }
    .cdn-legendbar i { display: inline-block; width: 14px; height: 2px; background: var(--c); }
    .cdn-mon .umd { flex-wrap: nowrap; }
    .cdn-status { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .cdn-clock { font-family: var(--f-led); font-size: 17px; letter-spacing: .04em; color: var(--text); }
    .cdn-speed { color: var(--muted); margin-right: 8px; }
    .cdn-side { padding: 16px; display: grid; gap: 14px; align-content: start; min-width: 0; }
    .cdn-ctl { display: grid; gap: 8px; min-width: 0; }
    .cdn-ctl .slider { min-width: 0; }
    .cdn-row { display: flex; gap: 10px; align-items: flex-end; }
    .cdn-row .slider { flex: 1 1 auto; }
    .cdn-btns { display: flex; flex-wrap: wrap; gap: 8px; }
    .cdn-btns .btn { flex: 1 1 auto; min-height: 40px; }
    .cdn-hint { margin: 0; font-size: 12px; line-height: 1.45; color: var(--muted); }
    .cdn-hint code { font-family: var(--f-mono); font-size: 12px; color: var(--text-2); }
    .cdn-dim { opacity: .45; }
    .cdn-kv { border-top: 1px solid var(--line); padding-top: 12px; }
    .cdn-kv dd.is-bad { color: var(--red); }
    .cdn-kv dd.is-warn { color: var(--amber); }
    .cdn-charts { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
    @media (min-width: 760px) { .cdn-charts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cdn-card--edges { grid-column: 1 / -1; } }
    @media (min-width: 1100px) { .cdn-charts { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr); } .cdn-card--edges { grid-column: auto; } }
    .cdn-card { padding: 12px 14px 14px; display: grid; gap: 8px; align-content: start; min-width: 0; }
    .cdn-card__cv { height: 190px; }
    .cdn-card .legend { gap: 4px 14px; }
    .cdn-edges { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 10px; }
    @media (min-width: 760px) and (max-width: 1099px) { .cdn-edges { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .cdn-edge { appearance: none; width: 100%; border: 1px solid transparent; background: transparent; color: var(--text-2); cursor: pointer; min-height: 40px; padding: 4px 6px; border-radius: 3px; display: grid; grid-template-columns: 44px minmax(0, 1fr) 42px; gap: 8px; align-items: center; font-family: var(--f-mono); font-size: 12px; text-align: left; transition: background .15s var(--ease); }
    .cdn-edge:hover, .cdn-edge.is-hl { background: var(--panel-2); }
    .cdn-edge .meter i { background: var(--text-2); }
    .cdn-edge.is-warn .meter i { background: var(--amber); }
    .cdn-edge.is-bad .meter i { background: var(--red); }
    .cdn-edge__code { color: var(--text); }
    .cdn-edge__v { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }
    .cdn-edge[aria-pressed="true"] { border-color: rgba(255, 77, 61, .45); }
    .cdn-edge[aria-pressed="true"] .cdn-edge__code, .cdn-edge[aria-pressed="true"] .cdn-edge__v { color: var(--red); }
  `);

  /* ---------------- состояние ---------------- */
  let sim = null;
  const U = {};                                   // ссылки на DOM
  const V = {                                     // состояние вида
    playing: true, speed: SPD.day, failAt: -1e9, failId: null, rtt95Before: 0,
    realT: 0, domT: 0, chartT: 0, sparkT: 0, crossT: -1, cross: null,
    hover: null, dirtyA: true, dirtyB: true, curves: null, day: null,
    reduced: false, budget: 1200, fillAll: true, dragging: false, cIdx: DEF.cIdx,
  };
  const M = {                                     // геометрия карты
    st: null, w: 0, h: 0, mob: false, band: 44,
    nx: new Float32Array(NN), ny: new Float32Array(NN),   // узлы на экране (шилды и ориджин подняты)
    gx: new Float32Array(NN), gy: new Float32Array(NN),   // их точки «на земле»
    rx: new Float32Array(R), ry: new Float32Array(R), rr: new Float32Array(R),
    dot0: new Int32Array(R), dotN: new Int32Array(R),
    dx: null, dy: null, dox: null, doy: null, dph: null, dlv: null, dotR: null, nDots: 0,
    labels: [], stat: null, spr: null,
  };
  let chA = null, chB = null, spark = null;
  const SPK = new Float32Array(180);
  let spkHead = 0, spkN = 0;

  /* частицы: структура массивов, без аллокаций в кадре */
  const pF = new Int16Array(PMAX).fill(-1), pU = new Float32Array(PMAX), pV = new Float32Array(PMAX);
  const pO = new Float32Array(PMAX), pD = new Int32Array(PMAX);
  const pFree = new Int16Array(PMAX);
  let pFreeN = 0;
  for (let i = PMAX - 1; i >= 0; i--) pFree[pFreeN++] = i;
  const flows = [];                               // потоки (объекты переиспользуются)
  const fkey = new Map();
  let PCOL = [];
  const RIP = 32, rX = new Float32Array(RIP), rY = new Float32Array(RIP), rT = new Float32Array(RIP).fill(-99), rC = new Int8Array(RIP);
  let rHead = 0;
  function ripple(x, y, c) { rX[rHead] = x; rY[rHead] = y; rT[rHead] = V.realT; rC[rHead] = c; rHead = (rHead + 1) % RIP; }
  let BX = 0, BY = 0;                             // результат bez()
  /* Цвета с прозрачностью и шрифты — из кэша, чтобы кадр не создавал строк */
  const ACACHE = {};
  function rgba(hex, a) {
    let arr = ACACHE[hex];
    if (!arr) { arr = ACACHE[hex] = []; for (let i = 0; i <= 40; i++) arr.push(FJ.alpha(hex, i / 40)); }
    return arr[Math.max(0, Math.min(40, Math.round(a * 40)))];
  }
  const F12L = FJ.font.mono(12, 400), F12M = FJ.font.mono(12, 500), F12B = FJ.font.mono(12, 600);
  let RIPCOL = null;
  const rnd = cdn.rng(20260925);

  /* ---------------- форматирование ---------------- */
  const pct = x => fmt.pct(Math.max(0, x));
  const people = n => (n >= 1e6 ? fmt.num(n / 1e6, 2) + NB + 'млн' : Math.round(n / 1e3) + NB + 'тыс.');
  const ms1 = x => fmt.num(x, x < 10 ? 1 : 0);
  const p2 = n => String(n).padStart(2, '0');
  const clock = t => { const s = ((Math.floor(t) % 86400) + 86400) % 86400; return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); };
  const hhmm = hr => { const m = Math.round(hr * 60) % 1440; return p2(Math.floor(m / 60)) + ':' + p2(m % 60); };
  const mss = u => { const s = Math.max(0, Math.floor(Math.abs(u))); return Math.floor(s / 60) + ':' + p2(s % 60); };
  const gbps = g => fmt.rate(Math.max(0, g) * 1e9);
  const cPct = () => CPCT[V.cIdx];

  /* =====================================================================
     Текст главы
     ===================================================================== */
  function writeText() {
    const c = FJ.cite;
    $('#cdnText').innerHTML = `
      <p><strong>Фильм лежит в&nbsp;одном месте, а&nbsp;смотрят его по&nbsp;всей стране.</strong> Если&nbsp;бы каждый сегмент ехал из&nbsp;Москвы, магистраль пришлось&nbsp;бы строить на&nbsp;весь вечерний пик страны, а&nbsp;зритель во&nbsp;Владивостоке ждал&nbsp;бы ответа на&nbsp;каждый запрос около 96&nbsp;мс: 6400&nbsp;км по&nbsp;дуге, путь по&nbsp;оптике в&nbsp;1,5&nbsp;раза длиннее, а&nbsp;свет в&nbsp;стекле проходит 200&nbsp;км за&nbsp;миллисекунду (физический минимум&nbsp;— 64&nbsp;мс). Поэтому раздачу строят ярусами: <strong>ориджин</strong> (хранилище и&nbsp;упаковщик) → <strong>шилды</strong> (большие промежуточные кэши, «щит» ориджина) → <strong>узлы у&nbsp;провайдеров</strong>, то&nbsp;есть кэши внутри сетей операторов и&nbsp;в&nbsp;региональных точках обмена трафиком.</p>
      <p>Главная метрика&nbsp;— <strong>доля трафика, отданного узлами</strong> (хит‑рейт, offload). Каждый промах едет по&nbsp;магистрали и&nbsp;транзиту, которые строят и&nbsp;оплачивают под пик, и&nbsp;добавляет задержку до&nbsp;первого байта. А&nbsp;хит‑рейт упирается в&nbsp;длинный хвост каталога: популярность тайтлов подчиняется закону Ципфа, <code>p<sub>i</sub>&nbsp;∝&nbsp;i<sup>−α</sup></code>, для видео по&nbsp;запросу α часто около 0,8${c('fricker')}. В&nbsp;большой VOD‑системе 10&nbsp;% самых популярных объектов собирали около 60&nbsp;% обращений${c('yu2006')}, на&nbsp;YouTube 10&nbsp;% роликов&nbsp;— около 80&nbsp;% просмотров${c('cha2007')}. Сколько попаданий даст кэш LRU на&nbsp;C тайтлов, считает аппроксимация Че${c('che')}.</p>
      <p>Эталон&nbsp;— Netflix Open Connect: больше 18&nbsp;тыс. серверов в&nbsp;6&nbsp;тыс. с&nbsp;лишним точек${c('oc-site')}; ещё в&nbsp;2018&nbsp;году почти 95&nbsp;% трафика шло по&nbsp;прямым подключениям к&nbsp;провайдерам${c('oc-apnic')}. Серверы не&nbsp;ждут промахов: контент раскладывают заранее по&nbsp;прогнозу популярности${c('oc')}, по&nbsp;умолчанию&nbsp;— в&nbsp;окно заливки с&nbsp;02:00 до&nbsp;14:00 местного времени${c('oc-fill')}. Популярное кладут на&nbsp;быстрые флеш‑серверы, хвост&nbsp;— на&nbsp;большие хранилища${c('oc-pop')}, а&nbsp;один сервер отдаёт почти 800&nbsp;Гбит/с TLS‑трафика${c('oc-800')}.</p>
      <p><strong>Российский масштаб.</strong> В&nbsp;финале Лиги чемпионов 30&nbsp;мая 2026&nbsp;года Okko отдавал в&nbsp;пике 7,8&nbsp;Тбит/с с&nbsp;собственной CDN и&nbsp;больше 10&nbsp;Тбит/с вместе с&nbsp;внешними, а&nbsp;на&nbsp;старте трансляции было больше миллиона входов${c('okko-ucl')}. Для сравнения: пик MSK‑IX за&nbsp;весь 2025&nbsp;год&nbsp;— 8,54&nbsp;Тбит/с${c('mskix')}. То&nbsp;есть один сервис в&nbsp;свой пиковый момент отдавал порядка годового рекорда целой точки обмена трафиком. Это сравнение масштаба, а&nbsp;не&nbsp;маршрута: CDN старается отдавать трафик по&nbsp;прямым подключениям, в&nbsp;обход точек обмена.</p>
      <p><strong>Премьера&nbsp;— это флешмоб для VOD.</strong> Тысячи зрителей ждут на&nbsp;странице с&nbsp;обратным отсчётом и&nbsp;нажимают «Смотреть» в&nbsp;одну секунду. Если серии нет на&nbsp;узлах, каждый узел идёт за&nbsp;ней наверх, и&nbsp;без <strong>схлопывания запросов</strong> (request collapsing) туда уходит не&nbsp;один запрос, а&nbsp;все, что пришли, пока первый в&nbsp;пути: <code>1&nbsp;+&nbsp;λ·F</code>, где λ&nbsp;— частота запросов к&nbsp;объекту, F&nbsp;— время промаха. Ориджин тормозит, F растёт, дублей ещё больше. В&nbsp;nginx схлопывание (<code>proxy_cache_lock</code>) по&nbsp;умолчанию выключено, а&nbsp;его таймаут&nbsp;— 5&nbsp;с, дольше 2‑секундного сегмента${c('nginx-lock')}. Ориджин прямых эфиров Netflix кэширует даже ответ «сегмента ещё нет» до&nbsp;момента публикации, а&nbsp;под нагрузкой отвечает 503 с&nbsp;<code>max-age=5</code>, чтобы повторы не&nbsp;доходили до&nbsp;него${c('nf-origin')}.</p>
      <p>Предзаливка снимает проблему целиком: серия уже лежит на&nbsp;узлах. Требования студий к&nbsp;защите (MovieLabs ECP) допускают выкладку контента на&nbsp;CDN не&nbsp;раньше чем за&nbsp;два дня до&nbsp;релиза${c('ecp')}&nbsp;— как раз одна‑две ночи заливки. Но&nbsp;предзаливка хороша ровно настолько, насколько точен прогноз: в&nbsp;модели ниже LRU догоняет её, когда прогноз ошибается примерно втрое.</p>`;
  }

  /* =====================================================================
     DOM фигуры
     ===================================================================== */
  const ICON = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>',
  };
  function legendIcon(kind) {
    if (kind === 'edge') return '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="#bfc0c3" stroke-width="1.4"/><circle cx="6" cy="6" r="1.8" fill="#ecebe6"/></svg>';
    if (kind === 'shield') return '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="#ecebe6" stroke-width="1.4"/></svg>';
    return '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.8" y="1.8" width="8.4" height="8.4" fill="none" stroke="#ecebe6" stroke-width="1.4"/><path d="M6 3.4v5.2M3.4 6h5.2" stroke="#ecebe6" stroke-width="1.2"/></svg>';
  }
  function stat(label, extra) {
    const b = h('b', { text: '—' });
    const s = h('span', { html: label });
    const el = h('div', { class: 'stat' }, [b, s]);
    if (extra) el.append(extra);
    return { el, b, s };
  }

  function buildDom(el) {
    const root_ = h('div', { class: 'cdn' });
    el.append(root_);

    /* сводка */
    const sparkHost = h('div', { class: 'cdn-spark', 'aria-hidden': 'true' });
    U.sTot = stat('Отдача зрителям');
    U.sOff = stat('Отдано узлами у&nbsp;провайдеров (хит‑рейт)');
    U.sOrg = stat('Ориджин', sparkHost);
    U.sRtt = stat('RTT до&nbsp;узла, p50 / p95 (без последней мили)');
    U.sHot = stat('Самый загруженный узел');
    const stats = h('div', { class: 'stat-row cdn-stats' }, [U.sTot.el, U.sOff.el, U.sOrg.el, U.sRtt.el, U.sHot.el]);
    root_.append(stats);

    /* карта в «мониторе» */
    const screen = h('div', { class: 'monitor__screen cdn-screen' });
    U.screen = screen;
    U.hud = h('div', { class: 'cdn-hud' });
    U.live = h('span', { class: 'sr-only', 'aria-live': 'polite' });
    U.tip = h('div', { class: 'cdn-tip', 'aria-hidden': 'true' });
    screen.append(U.tip, U.live);
    const stage = h('div', { class: 'cdn-stage' }, [screen, U.hud]);
    const legend = h('div', { class: 'cdn-legendbar' }, [
      h('span', { html: legendIcon('edge') + 'узел у&nbsp;провайдера, кольцо&nbsp;— загрузка' }),
      h('span', { html: legendIcon('shield') + 'шилд' }),
      h('span', { html: legendIcon('origin') + 'ориджин' }),
      h('span', null, [h('i', { style: { '--c': 'var(--blue)' } }), 'отдача зрителям']),
      h('span', null, [h('i', { style: { '--c': 'var(--amber)' } }), 'промахи наверх']),
      h('span', null, [h('i', { style: { '--c': 'var(--violet)' } }), 'ночная заливка']),
      h('span', null, [h('i', { style: { '--c': 'var(--red)' } }), 'перегрузка, отказ']),
    ]);
    U.tally = h('span', { class: 'tally' });
    U.status = h('span', { class: 'cdn-status', text: 'штатно' });
    U.speed = h('span', { class: 'cdn-speed', text: '×600 · МСК' });
    U.clock = h('span', { class: 'cdn-clock', text: '21:00:00' });
    const umd = h('div', { class: 'umd' }, [U.tally, h('span', { class: 'lbl', text: 'МОДЕЛЬ СЕТИ' }), U.status, h('span', { class: 'v' }, [U.speed, U.clock])]);
    const mon = h('div', { class: 'monitor cdn-mon' }, [stage, legend, umd]);

    /* панель управления */
    const side = h('aside', { class: 'panel cdn-side', 'aria-label': 'Управление моделью CDN' });
    const cMode = h('div', { class: 'cdn-ctl' }, [h('span', { class: 'ctl-label', text: 'Кэш у' + NB + 'провайдеров' })]);
    const segHost = h('div');
    cMode.append(segHost);
    U.seg = FJ.seg(segHost, [{ v: 'lru', label: 'LRU (по запросу)' }, { v: 'prefill', label: 'Предзаливка' }], DEF.mode, v => setMode(v), { small: true });
    const cCache = h('div', { class: 'cdn-ctl' });
    U.slCache = FJ.slider(cCache, {
      id: 'cdnCache', label: 'Размер кэша узла', min: 0, max: CPCT.length - 1, step: 1, value: DEF.cIdx,
      fmt: i => CPCT[i] + NB + '% · ' + Math.round(CPCT[i] / 100 * K.N_TITLES * K.TITLE_GB / 1000) + NB + 'ТБ',
      onInput: i => { V.cIdx = i; sim.set({ cPct: CPCT[i] }); paramsChanged(); },
    });
    const cSigma = h('div', { class: 'cdn-ctl' });
    // точность прогноза: вправо — точнее; внутри модели это σ логнормальной ошибки
    const SMAX = 2.5, sig = v => Math.round((SMAX - v) * 10) / 10;
    U.slSigma = FJ.slider(cSigma, {
      id: 'cdnSigma', label: 'Точность прогноза', min: 0, max: SMAX, step: 0.1, value: SMAX - DEF.sigma,
      fmt: v => (sig(v) < 0.05 ? 'идеальная' : 'ошибка ×' + fmt.num(Math.exp(sig(v)), 1)),
      onInput: v => { sim.set({ sigma: sig(v) }); paramsChanged(); },
    });
    U.slSigma.sigmaMax = SMAX;
    U.cSigma = cSigma;
    const cAlpha = h('div', { class: 'cdn-ctl' });
    U.slAlpha = FJ.slider(cAlpha, {
      id: 'cdnAlpha', label: 'α Ципфа', min: 0.6, max: 1.2, step: 0.05, value: DEF.alpha,
      fmt: v => fmt.num(v, 2),
      onInput: v => { sim.set({ alpha: v }); paramsChanged(true); },
    });
    const cTime = h('div', { class: 'cdn-ctl' });
    const tRow = h('div', { class: 'cdn-row' });
    const tSl = h('div');
    U.slTime = FJ.slider(tSl, {
      id: 'cdnTime', label: 'Время по' + NB + 'Москве', min: 0, max: 23.75, step: 0.25, value: DEF.hour,
      fmt: v => hhmm(v),
      onInput: v => {
        const day = Math.floor(sim.t / 86400) * 86400;
        sim.t = day + v * 3600; sim.prem = null; sim.step(0);
        V.dirtyB = true;
      },
    });
    U.slTime.input.addEventListener('pointerdown', () => { V.dragging = true; });
    root.addEventListener('pointerup', () => { V.dragging = false; });
    U.play = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Пауза', html: ICON.pause, onclick: () => setPlaying(!V.playing) });
    tRow.append(tSl, U.play);
    cTime.append(tRow);
    const cCol = h('div', { class: 'cdn-ctl' });
    U.tgCol = FJ.toggle(cCol, { id: 'cdnCollapse', label: 'Схлопывание запросов', value: DEF.collapse, onChange: v => { sim.set({ collapse: v }); paintDom(); } });
    cCol.append(h('p', { class: 'cdn-hint', html: '<code>proxy_cache_lock</code>: один запрос наверх на&nbsp;объект, остальные ждут. В&nbsp;nginx по&nbsp;умолчанию выключено.' }));
    U.bPrem = h('button', { class: 'btn primary', type: 'button', text: 'Премьера в' + NB + '00:00', onclick: startPremiere });
    U.bDrop = h('button', { class: 'btn danger', type: 'button', text: 'Уронить узел', onclick: dropNext });
    U.bReset = h('button', { class: 'btn', type: 'button', text: 'Сбросить', onclick: resetAll });
    const cBtn = h('div', { class: 'cdn-ctl' }, [
      h('div', { class: 'cdn-btns' }, [U.bPrem, U.bDrop, U.bReset]),
      h('p', { class: 'cdn-hint', html: 'Узел можно уронить и&nbsp;поднять щелчком на&nbsp;карте или в&nbsp;списке узлов.' }),
    ]);
    /* телеметрия */
    U.kv = {};
    const kvRows = [
      ['view', 'Зрителей онлайн'], ['hits', 'Хит‑рейт: узлы / шилды'], ['shield', 'Шилды'],
      ['origin', 'Ориджин'], ['F', 'Время промаха F'], ['tc', 'Жизнь в&nbsp;кэше LRU, t<sub>C</sub>'], ['fill', 'Заливка (02–14 местн.)'],
      ['prem', 'Серия'], ['dup', 'Наверх на&nbsp;объект'], ['wait', 'Ждут сегмент'],
    ];
    const dl = h('dl', { class: 'kv cdn-kv' });
    for (const [k, label] of kvRows) {
      const dt = h('dt', { html: label }), dd = h('dd', { text: '—' });
      dl.append(dt, dd);
      U.kv[k] = { dt, dd };
    }
    side.append(cMode, cCache, cSigma, cAlpha, cTime, cCol, cBtn, dl);

    root_.append(h('div', { class: 'cdn-main' }, [mon, side]));

    /* графики и узлы */
    const hostA = h('div', { class: 'fig__canvas cdn-card__cv', role: 'img', 'aria-label': 'График: доля попаданий узла в зависимости от размера кэша для LRU и для предзаливки' });
    U.crossNote = h('span');
    const cardA = h('div', { class: 'panel cdn-card' }, [
      h('span', { class: 'ctl-label', text: 'Хит‑рейт узла и' + NB + 'размер кэша' }),
      hostA,
      h('div', { class: 'legend' }, [
        h('span', null, [h('i', { style: { '--c': 'var(--q1)' } }), 'LRU (Че)']),
        h('span', null, [h('i', { style: { '--c': 'var(--q3)' } }), 'предзаливка']),
        h('span', null, [h('i', { style: { '--c': 'var(--muted)' } }), 'идеальный прогноз']),
      ]),
      h('p', { class: 'caption', html: `Че: t<sub>C</sub> из&nbsp;<code>Σ(1&nbsp;−&nbsp;e<sup>−p<sub>i</sub>t<sub>C</sub></sup>)&nbsp;=&nbsp;C</code>, доля попаданий <code>Σ&nbsp;p<sub>i</sub>(1&nbsp;−&nbsp;e<sup>−p<sub>i</sub>t<sub>C</sub></sup>)</code>. Предзаливка кладёт C тайтлов с&nbsp;наибольшей <em>прогнозной</em> популярностью: прогноз&nbsp;= истина&nbsp;× e<sup>σε</sup>. ` }, [U.crossNote]),
    ]);
    const hostB = h('div', { class: 'fig__canvas cdn-card__cv', role: 'img', 'aria-label': 'График: суточная отдача, промахи к шилдам и ориджину, окно ночной заливки' });
    const cardB = h('div', { class: 'panel cdn-card' }, [
      h('span', { class: 'ctl-label', text: 'Сутки: отдача и' + NB + 'промахи' }),
      hostB,
      h('div', { class: 'legend' }, [
        h('span', null, [h('i', { style: { '--c': 'var(--text)' } }), 'отдача, Тбит/с']),
        h('span', null, [h('i', { style: { '--c': 'var(--amber)' } }), 'к шилдам']),
        h('span', null, [h('i', { style: { '--c': 'var(--red)' } }), 'к ориджину']),
        h('span', null, [h('i', { style: { '--c': 'var(--violet)' } }), 'заливка']),
      ]),
      h('p', { class: 'caption', html: `Иллюстративно: ${fmt.int(K.PEAK_VIEWERS)} потоков в&nbsp;21:00 по&nbsp;5&nbsp;Мбит/с (Netflix советует 5&nbsp;Мбит/с для&nbsp;1080p${FJ.cite('nf-speed')}). Рекордные 26,99&nbsp;Тбит/с на&nbsp;DE‑CIX пришлись на&nbsp;20:11 CET, в&nbsp;игровой день Лиги чемпионов${FJ.cite('decix')}. Каждый город живёт по&nbsp;своим часам: у&nbsp;Владивостока пик в&nbsp;14:00 по&nbsp;Москве, а&nbsp;окно заливки открывается в&nbsp;19:00&nbsp;— на&nbsp;московский вечерний пик. Нижняя шкала логарифмическая.` }),
    ]);
    U.edges = [];
    const list = h('ul', { class: 'cdn-edges' });
    cdn.EDGES.forEach((e, i) => {
      const code = h('span', { class: 'cdn-edge__code', text: e.code });
      const mi = h('i', { style: { '--v': '0' } });
      const val = h('span', { class: 'cdn-edge__v', text: '—' });
      const b = h('button', { class: 'cdn-edge', type: 'button', 'aria-pressed': 'false', title: e.city + ': уронить или поднять узел' }, [
        code, h('span', { class: 'sr-only', text: ' — ' + e.city + ', загрузка узла ' }), h('span', { class: 'meter', 'aria-hidden': 'true' }, [mi]), val,
      ]);
      b.addEventListener('click', () => toggleNode(i));
      b.addEventListener('mouseenter', () => { V.hover = { kind: 'node', i, list: true }; });
      b.addEventListener('mouseleave', () => { if (V.hover && V.hover.list) V.hover = null; });
      b.addEventListener('focus', () => { V.hover = { kind: 'node', i, list: true }; });
      b.addEventListener('blur', () => { if (V.hover && V.hover.list) V.hover = null; });
      list.append(h('li', null, [b]));
      U.edges.push({ b, mi, val, cls: '' });
    });
    const cardE = h('div', { class: 'panel cdn-card cdn-card--edges' }, [
      h('span', { class: 'ctl-label', text: 'Узлы у' + NB + 'провайдеров · загрузка' }),
      list,
      h('p', { class: 'caption', html: 'Серверы по&nbsp;200&nbsp;Гбит/с, узел рассчитан на&nbsp;пик своего региона с&nbsp;запасом ×1,3 (иллюстративно). Выше 95&nbsp;% направление переливает зрителей на&nbsp;следующий узел.' }),
    ]);
    root_.append(h('div', { class: 'cdn-charts' }, [cardA, cardB, cardE]));

    const rES = (e, sh) => fmt.num(sim.rttES[cdn.EDGES.findIndex(x => x.id === e) * S + sh], 1);
    root_.append(h('p', { class: 'caption', html: `<strong>Модель, не&nbsp;замер.</strong> Часы&nbsp;— московские, а&nbsp;вечерний пик и&nbsp;окно заливки у&nbsp;каждого города&nbsp;— по&nbsp;местному времени; зрители премьеры в&nbsp;00:00 распределены по&nbsp;тому, кто в&nbsp;этот час не&nbsp;спит. Второй шилд&nbsp;— в&nbsp;Новосибирске: Уралу он так&nbsp;же близок, как Москва (от&nbsp;Екатеринбурга ${rES('ekb', 1)} и&nbsp;${rES('ekb', 0)}&nbsp;мс), а&nbsp;промах из&nbsp;Владивостока доходит до&nbsp;шилда за&nbsp;${rES('vvo', 1)}&nbsp;мс вместо ${rES('vvo', 0)}; шилды&nbsp;— ${K.SHIELD_SERVERS.map(n => fmt.num(n * K.SERVER_GBPS / 1000, 1)).join(' и&nbsp;')}&nbsp;Тбит/с. Каталог ${fmt.int(K.N_TITLES)} тайтлов, запросы независимы (IRM), популярность по&nbsp;Ципфу; тайтл со&nbsp;всеми качествами ≈&nbsp;${K.TITLE_GB}&nbsp;ГБ; шилд&nbsp;— LRU на&nbsp;${K.SHIELD_PCT}&nbsp;% каталога, его вход (промахи узлов) считаем тоже независимым&nbsp;— это приближение. Веса городов пропорциональны примерному населению (иллюстративно). RTT&nbsp;= 2&nbsp;× дуга&nbsp;× 1,5&nbsp;/ 200&nbsp;км/мс + 0,5&nbsp;мс, без последней мили; промах&nbsp;— 2&nbsp;RTT на&nbsp;ярус и&nbsp;0,12&nbsp;с на&nbsp;ориджине (${K.ORIGIN_GBPS}&nbsp;Гбит/с) плюс очередь. Премьера: ${fmt.int(K.PREM_BURST)} стартов в&nbsp;первые секунды и&nbsp;ещё ${fmt.int(K.PREM_WAVE)} за&nbsp;час, серия 45&nbsp;мин, ${K.VARIANTS} варианта сегмента. Перенесённая после отказа аудитория сначала попадает в&nbsp;кэш на&nbsp;20&nbsp;% хуже (у&nbsp;регионов немного разные вкусы) и&nbsp;прогревает LRU за&nbsp;время порядка t<sub>C</sub>. Все нагрузки иллюстративные.` }));

    /* холсты */
    M.st = FJ.canvas(screen, { maxDpr: 2, onResize: s => layoutMap(s) });
    const cv = M.st.cv;
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', 'Карта сети раздачи без границ: ориджин в Москве, шилды в Москве и Новосибирске, 14 узлов у провайдеров в крупных городах, облака зрителей вокруг городов и потоки трафика. Состояние узлов продублировано в списке ниже.');
    chA = FJ.canvas(hostA, { maxDpr: 2, onResize: () => { V.dirtyA = true; } });
    chB = FJ.canvas(hostB, { maxDpr: 2, onResize: () => { V.dirtyB = true; } });
    spark = FJ.canvas(sparkHost, { maxDpr: 2 });
    cv.addEventListener('pointermove', onPointer);
    cv.addEventListener('pointerleave', () => { if (V.hover && !V.hover.list) V.hover = null; U.tip.classList.remove('is-on'); U.screen.classList.remove('is-hot'); });
    cv.addEventListener('click', onClick);
  }

  /* =====================================================================
     Управление
     ===================================================================== */
  function setMode(v) {
    sim.set({ mode: v });
    U.cSigma.classList.toggle('cdn-dim', v !== 'prefill');
    paramsChanged();
  }
  function paramsChanged(alphaToo) {
    V.dirtyA = true; V.dirtyB = true; V.crossT = V.realT + 0.25;
    if (alphaToo) V.curves = null;
    sim.step(0);
    paintDom();
  }
  function setPlaying(on) {
    V.playing = on;
    U.play.innerHTML = on ? ICON.pause : ICON.play;
    U.play.setAttribute('aria-label', on ? 'Пауза' : 'Пуск');
  }
  function startPremiere() {
    sim.premiere(6);
    setPlaying(true);
    V.speed = SPD.prem;
    sim.step(0);
    V.dirtyB = true;
    paintDom();
  }
  function toggleNode(n) {
    if (n === OR) return;
    const id = sim.nodes[n].id;
    const wasAlive = sim.isAlive(id);
    const before = sim.m.rtt95;
    sim.fail(id, wasAlive);
    ripple(M.nx[n], M.ny[n], wasAlive ? 2 : 3);
    if (wasAlive) { V.failAt = V.realT; V.failId = id; V.rtt95Before = before; setPlaying(true); }
    else if (V.failId === id) V.failId = null;
    sim.step(0);
    paintDom();
  }
  function dropNext() {
    const id = DROP.find(x => sim.isAlive(x));
    if (!id) return;
    toggleNode(sim.nodeIndex(id));
  }
  function resetAll() {
    V.cIdx = DEF.cIdx;
    sim.set({ mode: DEF.mode, cPct: CPCT[DEF.cIdx], alpha: DEF.alpha, sigma: DEF.sigma, collapse: DEF.collapse });
    sim.reset(Math.floor(sim.t / 86400) * 86400 + DEF.hour * 3600);
    U.seg.set(DEF.mode); U.slCache.set(DEF.cIdx); U.slSigma.set(U.slSigma.sigmaMax - DEF.sigma); U.slAlpha.set(DEF.alpha);
    U.slTime.set(DEF.hour); U.tgCol.set(DEF.collapse);
    U.cSigma.classList.add('cdn-dim');
    V.failId = null; V.failAt = -1e9; V.speed = SPD.day;
    setPlaying(true);
    clearParticles();
    spkN = 0; spkHead = 0;
    paramsChanged(true);
  }

  /* Скорость модельных часов: сутки — ×600; премьера — замедленно;
     после отказа узла — ×40, чтобы был виден прогрев кэша */
  function targetSpeed() {
    if (!V.playing) return 0;
    const pr = sim.prem;
    if (pr) {
      const u = sim.t - pr.t0;
      if (u < 45) return SPD.prem;
      if (u < 200) return SPD.premMid;
    }
    if (V.realT - V.failAt < 22) return SPD.fail;
    return SPD.day;
  }

  /* =====================================================================
     Карта: раскладка
     ===================================================================== */
  function sprite(color, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d'), r = size / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, FJ.alpha(color, 0.9));
    gr.addColorStop(0.22, FJ.alpha(color, 0.32));
    gr.addColorStop(1, FJ.alpha(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function layoutMap(s) {
    M.st = s;
    const W = s.w, H = s.h;
    M.w = W; M.h = H;
    if (W < 40 || H < 40) return;
    const C = FJ.colors;
    if (!M.spr) {
      M.spr = { w: sprite(C.text, 64), b: sprite(C.blue, 64), a: sprite(C.amber, 64), r: sprite(C.red, 64) };
      PCOL = [FJ.alpha(C.blue, 0.85), FJ.alpha(C.amber, 0.5), FJ.alpha(C.red, 0.95), FJ.alpha(C.violet, 0.9), FJ.alpha(C.amber, 0.95)];
    }
    const mob = W < 620;
    M.mob = mob;
    M.band = mob ? 6 : 42;
    const elevS = mob ? 22 : 34, elevO = mob ? 46 : 80;
    const pad = { l: mob ? 22 : 44, r: mob ? 22 : 48, t: M.band + (mob ? 22 : 30), b: mob ? 22 : 36 };
    // проекция всех городов
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const pts = cdn.REGIONS.concat(cdn.EDGES).map(c => cdn.project(c.lat, c.lon));
    for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
    const aw = W - pad.l - pad.r, ah = H - pad.t - pad.b;
    let SX = aw / (maxX - minX), SY = ah / (maxY - minY);
    if (SY < SX) SX = SY;                          // низкий широкий холст — единый масштаб
    else SY = Math.min(SY, SX * (mob ? 2.8 : 1.8)); // иначе умеренно растягиваем по высоте
    const ox = pad.l + (aw - (maxX - minX) * SX) / 2;
    let oy = pad.t + (ah - (maxY - minY) * SY) / 2;
    const P = (lat, lon) => { const q = cdn.project(lat, lon); BX = ox + (q.x - minX) * SX; BY = oy + (q.y - minY) * SY; };
    const dirX = 0.27, dirY = -0.963;
    const place = () => {
      cdn.EDGES.forEach((e, i) => {
        P(e.lat, e.lon);
        let x = BX;
        if (e.id === 'msk1') x -= mob ? 5 : 7;
        if (e.id === 'msk2') x += mob ? 5 : 7;
        M.gx[i] = M.nx[i] = x; M.gy[i] = M.ny[i] = BY;
      });
      cdn.SHIELDS.forEach((sh, k) => {
        P(sh.lat, sh.lon);
        const n = E + k;
        M.gx[n] = BX; M.gy[n] = BY; M.nx[n] = BX + dirX * elevS; M.ny[n] = BY + dirY * elevS;
      });
      P(cdn.ORIGIN.lat, cdn.ORIGIN.lon);
      M.gx[OR] = BX; M.gy[OR] = BY; M.nx[OR] = BX + dirX * elevO; M.ny[OR] = BY + dirY * elevO;
    };
    place();
    // ориджин не должен залезать под полосу подписей
    const topNeed = M.band + 16 - Math.min(M.ny[OR], M.ny[E], M.ny[E + 1]);
    if (topNeed > 0) { oy += topNeed; place(); }
    // облака зрителей
    const ki = { 'msk-w': 0, 'msk-e': 1 };
    let nd = 0;
    const sc = mob ? 0.72 : 1;
    const nOf = r => Math.round((mob ? 0.62 : 1) * (5 + 24 * Math.sqrt(cdn.REGIONS[r].pop / 6575)));
    for (let r = 0; r < R; r++) nd += nOf(r);
    M.dx = new Float32Array(nd); M.dy = new Float32Array(nd); M.dox = new Float32Array(nd); M.doy = new Float32Array(nd);
    M.dph = new Float32Array(nd); M.dlv = new Int8Array(nd); M.dotR = new Int16Array(nd); M.nDots = nd;
    let k = 0;
    cdn.REGIONS.forEach((g, r) => {
      if (g.id in ki) { const e = ki[g.id]; M.rx[r] = M.nx[e] + (e ? 5 : -5); M.ry[r] = M.ny[e] + 3; }
      else { P(g.lat, g.lon); M.rx[r] = BX; M.ry[r] = BY; }
      const rad = sc * (4 + 15 * Math.sqrt(g.pop / 6575));
      M.rr[r] = rad;
      const n = nOf(r);
      M.dot0[r] = k; M.dotN[r] = n;
      for (let j = 0; j < n; j++, k++) {
        const rr = rad * Math.sqrt((j + 0.5) / n), a = j * 2.39996323 + r;
        const ox_ = Math.cos(a) * rr, oy_ = Math.sin(a) * rr * 0.62;
        M.dox[k] = ox_; M.doy[k] = oy_; M.dx[k] = M.rx[r] + ox_; M.dy[k] = M.ry[r] + oy_;
        M.dph[k] = rnd() * 6.283; M.dotR[k] = r;
      }
    });
    // статичный слой: сетка параллелей и меридианов, отметки «на земле»
    const st = M.stat || document.createElement('canvas');
    st.width = Math.round(W * s.dpr); st.height = Math.round(H * s.dpr);
    const g = st.getContext('2d');
    g.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const vg = g.createRadialGradient(W * 0.5, H * 0.55, Math.min(W, H) * 0.2, W * 0.5, H * 0.55, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(255,255,255,0.018)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.055)'; g.lineWidth = 1;
    g.setLineDash([1, 4]);
    for (let lon = 30; lon <= 140; lon += 10) {
      g.beginPath();
      for (let j = 0; j <= 24; j++) { P(40 + j * (70 - 40) / 24, lon); j ? g.lineTo(BX, BY) : g.moveTo(BX, BY); }
      g.stroke();
    }
    for (let lat = 45; lat <= 65; lat += 5) {
      g.beginPath();
      for (let j = 0; j <= 48; j++) { P(lat, 25 + j * (145 - 25) / 48); j ? g.lineTo(BX, BY) : g.moveTo(BX, BY); }
      g.stroke();
    }
    g.setLineDash(NODASH);
    // подписи параллелей — у левого края
    g.font = FJ.font.mono(12); g.fillStyle = 'rgba(255,255,255,0.16)'; g.textBaseline = 'middle'; g.textAlign = 'left';
    if (!mob) for (const lat of [45, 50, 60]) { P(lat, 25); if (BX > 2 && BY > M.band + 10 && BY < H - 8) g.fillText(lat + '°', Math.max(4, BX + 2), BY); }
    // мачты шилдов и ориджина
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.setLineDash([2, 3]);
    for (let n = E; n < NN; n++) { g.beginPath(); g.moveTo(M.gx[n], M.gy[n]); g.lineTo(M.nx[n], M.ny[n]); g.stroke(); }
    g.setLineDash(NODASH);
    M.stat = st;
    // бюджет частиц — по площади
    V.reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    V.budget = Math.round(Math.max(600, Math.min(2400, W * H / 230)) * (V.reduced ? 0.4 : 1));
    // частицы ссылаются на точки облаков — после раскладки начинаем заново
    clearParticles();
    placeLabels(s.ctx);
  }

  /* Подписи: жадная раскладка без наложений (справа, слева, сверху, снизу) */
  function placeLabels(ctx) {
    const W = M.w, H = M.h, boxes = [], out = [];
    ctx.font = FJ.font.mono(12, 500);
    const obst = [];
    for (let n = 0; n < NN; n++) obst.push([M.nx[n], M.ny[n], n < E ? 8 : n < OR ? 11 : 14]);
    const hitsNode = (x0, y0, x1, y1, self) => {
      for (let n = 0; n < obst.length; n++) {
        if (n === self) continue;
        const [cx, cy, r] = obst[n];
        const qx = Math.max(x0, Math.min(cx, x1)), qy = Math.max(y0, Math.min(cy, y1));
        if ((qx - cx) ** 2 + (qy - cy) ** 2 < r * r) return true;
      }
      return false;
    };
    const free = (b, self) => {
      if (b[0] < 3 || b[2] > W - 3 || b[1] < M.band + 2 || b[3] > H - 3) return false;
      for (const q of boxes) if (b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]) return false;
      return !hitsNode(b[0], b[1], b[2], b[3], self);
    };
    const add = (text, x, y, r, kind, idx, self, must) => {
      const w = ctx.measureText(text).width;
      const cand = [
        [x + r + 5, y + 4, 'left', [x + r + 3, y - 8, x + r + 7 + w, y + 7]],
        [x - r - 5, y + 4, 'right', [x - r - 7 - w, y - 8, x - r - 3, y + 7]],
        [x, y - r - 6, 'center', [x - w / 2 - 2, y - r - 18, x + w / 2 + 2, y - r - 3]],
        [x, y + r + 15, 'center', [x - w / 2 - 2, y + r + 3, x + w / 2 + 2, y + r + 18]],
      ];
      let pick = cand.find(c => free(c[3], self));
      if (!pick && must) pick = cand[0];
      if (!pick) return;
      boxes.push(pick[3]);
      out.push({ text, x: pick[0], y: pick[1], al: pick[2], kind, idx });
    };
    add(cdn.ORIGIN.code, M.nx[OR], M.ny[OR], 14, 'origin', OR, OR, true);
    cdn.SHIELDS.forEach((sh, k) => add(M.mob ? 'ШИЛД' : sh.code, M.nx[E + k], M.ny[E + k], 11, 'shield', E + k, E + k, true));
    const byPop = cdn.EDGES.map((e, i) => i).sort((a, b) => popOfEdge(b) - popOfEdge(a));
    for (const i of byPop) add(cdn.EDGES[i].code, M.nx[i], M.ny[i], 9, 'edge', i, i, false);
    if (!M.mob) {
      const edgeCity = new Set(cdn.EDGES.map(e => e.city));
      cdn.REGIONS.forEach((g, r) => {
        if (g.city === 'msk' || edgeCity.has(g.name)) return;
        add(g.name, M.rx[r], M.ry[r], Math.max(4, M.rr[r] * 0.6), 'city', r, -1, false);
      });
    }
    M.labels = out;
  }
  function popOfEdge(i) {
    let p = 0;
    for (let r = 0; r < R; r++) if (sim.home[r] === i) p += cdn.REGIONS[r].pop;
    return p;
  }

  /* =====================================================================
     Потоки и частицы
     ===================================================================== */
  function geom(f) {
    let x0, y0, x1, y1;
    if (f.kind === 0) { x0 = M.nx[f.a]; y0 = M.ny[f.a]; x1 = M.rx[f.b]; y1 = M.ry[f.b]; }
    else if (f.kind === 1) { x0 = M.nx[f.a]; y0 = M.ny[f.a]; x1 = M.nx[f.b]; y1 = M.ny[f.b]; }
    else if (f.kind === 2) { x0 = M.nx[f.a]; y0 = M.ny[f.a]; x1 = M.nx[OR]; y1 = M.ny[OR]; }
    else if (f.kind === 3) { x0 = M.nx[f.b]; y0 = M.ny[f.b]; x1 = M.nx[f.a]; y1 = M.ny[f.a]; }
    else { x0 = M.nx[OR]; y0 = M.ny[OR]; x1 = M.nx[f.a]; y1 = M.ny[f.a]; }
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1;
    f.local = f.kind === 0 && d < 30;
    const lift = f.local ? 0 : f.kind === 0 ? 0.14 : 0.2;
    f.x0 = x0; f.y0 = y0; f.x1 = x1; f.y1 = y1;
    f.cx = (x0 + x1) / 2; f.cy = (y0 + y1) / 2 - lift * d;
    f.nx = -dy / d; f.ny = dx / d;
    let L = 0, px = x0, py = y0;
    for (let j = 1; j <= 10; j++) { bez(f, x1, y1, j / 10); L += Math.hypot(BX - px, BY - py); px = BX; py = BY; }
    f.len = Math.max(6, L + (f.kind === 0 ? M.rr[f.b] * 0.5 : 0));
  }
  function bez(f, x1, y1, u) {
    const m = 1 - u;
    BX = m * m * f.x0 + 2 * m * u * f.cx + u * u * x1;
    BY = m * m * f.y0 + 2 * m * u * f.cy + u * u * y1;
  }
  function flowAt(key, kind, a, b) {
    let i = fkey.get(key);
    if (i == null) {
      i = -1;
      for (let j = 0; j < flows.length; j++) if (flows[j].dead && flows[j].count === 0) { i = j; break; }
      if (i < 0) { i = flows.length; flows.push({}); }
      const f = flows[i];
      f.key = key; f.kind = kind; f.a = a; f.b = b; f.rate = 0; f.target = 0; f.count = 0; f.dead = false;
      f.col = 0; f.storm = 0; f.wt = 0;
      geom(f);
      fkey.set(key, i);
    }
    return flows[i];
  }
  function updateFlows(m) {
    for (const f of flows) if (!f.dead) { f.rate = 0; f.storm = 0; }
    const A = sim.A, over = m.originUtil > 1 || m.queueS > 0.05;
    for (let r = 0; r < R; r++) for (let n = 0; n < NN; n++) {
      const a = A[r * NN + n];
      if (a <= 0) continue;
      const f = flowAt(n * 1000 + r, 0, n, r);
      f.rate = a; f.col = n < E ? 0 : n < OR ? 1 : 2;
    }
    for (let e = 0; e < E; e++) {
      const em = m.edges[e];
      if (!em.alive) continue;
      const st = em.storm * K.SEG_BITS / 1e9;
      const rate = em.up + st;
      if (rate > 0) {
        const f = flowAt(1e6 + e * 1000 + em.shield, 1, e, em.shield);
        f.rate = rate; f.storm = st / rate; f.col = em.shield === OR && over ? 2 : f.storm > 0.25 ? 4 : 1;
      }
      if (em.fill > 0) {
        const f = flowAt(3e6 + e * 1000 + em.shield, 3, e, em.shield);
        f.rate = em.fill; f.col = 3;
      }
    }
    for (let k = 0; k < S; k++) {
      const sm = m.shields[k];
      if (!sm.alive) continue;
      const st = sm.storm * K.SEG_BITS / 1e9;
      const rate = sm.up + st;
      if (rate > 0) { const f = flowAt(2e6 + k, 2, E + k, OR); f.rate = rate; f.storm = st / rate; f.col = over ? 2 : f.storm > 0.25 ? 4 : 1; }
      if (sm.fill > 0) { const f = flowAt(4e6 + k, 4, E + k, OR); f.rate = sm.fill; f.col = 3; }
    }
  }
  function clearParticles() {
    pF.fill(-1); pFreeN = 0;
    for (let i = PMAX - 1; i >= 0; i--) pFree[pFreeN++] = i;
    for (const f of flows) { f.count = 0; f.dead = true; }
    fkey.clear();
    V.fillAll = true;
  }
  function spawn(fi, f, spread) {
    if (pFreeN <= 0) return false;
    const i = pFree[--pFreeN];
    pF[i] = fi; f.count++;
    pU[i] = spread ? rnd() : rnd() * 0.06;
    const px = f.kind === 0 ? (f.local ? 18 + rnd() * 26 : 55 + rnd() * 45) : f.kind >= 3 ? 40 + rnd() * 30 : 85 + rnd() * 55;
    pV[i] = px * (V.reduced ? 0.6 : 1) / f.len;
    pO[i] = (rnd() * 2 - 1) * (f.kind === 0 ? 1.2 : 2.2);
    pD[i] = f.kind === 0 ? M.dot0[f.b] + Math.floor(rnd() * M.dotN[f.b]) : 0;
    return true;
  }
  function stepParticles(dt) {
    let Wt = 0;
    for (const f of flows) { if (f.dead) continue; f.wt = f.rate > 0 ? Math.pow(f.rate, 0.62) : 0; Wt += f.wt; }
    const m = sim.m, peakG = K.PEAK_VIEWERS * K.BITRATE / 1e9;
    const busy = (m.totalG + 20 * (m.stormEdgeRps + m.stormRps) * K.SEG_BITS / 1e9) / peakG;
    const P = V.budget * Math.max(0.22, Math.min(1.25, Math.sqrt(busy)));
    for (const f of flows) { if (f.dead) continue; f.target = f.wt > 0 ? Math.max(1, Math.round(P * f.wt / Wt)) : 0; }
    for (let i = 0; i < PMAX; i++) {
      const fi = pF[i];
      if (fi < 0) continue;
      const f = flows[fi];
      let u = pU[i] + pV[i] * dt;
      if (u >= 1) {
        if (f.count > f.target || f.dead) { pF[i] = -1; f.count--; pFree[pFreeN++] = i; continue; }
        u = (u - 1) % 1;
        pO[i] = (rnd() * 2 - 1) * (f.kind === 0 ? 1.2 : 2.2);
        if (f.kind === 0) pD[i] = M.dot0[f.b] + Math.floor(rnd() * M.dotN[f.b]);
      }
      pU[i] = u;
    }
    const all = V.fillAll;
    for (let j = 0; j < flows.length; j++) {
      const f = flows[j];
      if (f.dead) continue;
      let need = f.target - f.count;
      let lim = all ? need : Math.max(1, Math.ceil(f.target * dt * 2.5));
      while (need > 0 && lim > 0 && spawn(j, f, all)) { need--; lim--; }
      if (f.rate <= 0 && f.target === 0) { f.dead = true; fkey.delete(f.key); }
    }
    V.fillAll = false;
  }
  function drawParticles(ctx) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let c = 0; c < PCOL.length; c++) {
      ctx.strokeStyle = PCOL[c];
      ctx.lineWidth = c === 0 ? 1.25 : c === 1 ? 1.2 : 1.7;
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < PMAX; i++) {
        const fi = pF[i];
        if (fi < 0) continue;
        const f = flows[fi];
        if (f.col !== c) continue;
        any = true;
        let x1 = f.x1, y1 = f.y1;
        if (f.kind === 0) { const d = pD[i]; x1 += M.dox[d]; y1 += M.doy[d]; }
        const u = pU[i], tail = Math.max(0, u - (f.kind === 0 ? 3.5 : 7) / f.len);
        const o = pO[i] * Math.sin(Math.PI * u);
        bez(f, x1, y1, u);
        const ax = BX + o * f.nx, ay = BY + o * f.ny;
        bez(f, x1, y1, tail);
        ctx.moveTo(BX + o * f.nx, BY + o * f.ny);
        ctx.lineTo(ax + 0.01, ay);
      }
      if (any) ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* =====================================================================
     Карта: кадр
     ===================================================================== */
  function drawMap(dt, t) {
    const s = M.st;
    if (!s || M.w < 40 || !M.dx) return;
    const ctx = s.ctx, C = FJ.colors, m = sim.m;
    s.clear(BG);
    if (M.stat) ctx.drawImage(M.stat, 0, 0, M.w, M.h);
    updateFlows(m);
    drawLinks(ctx, m);
    drawClouds(ctx, m, t);
    stepParticles(dt);
    drawParticles(ctx);
    drawRipples(ctx, C);
    drawNodes(ctx, m, t, C);
    drawLabels(ctx, m, C);
  }
  /* Круги от узлов: выход серии, отказ, подъём */
  function drawRipples(ctx, C) {
    const cols = RIPCOL || (RIPCOL = [C.blue, C.amber, C.red, C.text]);
    for (let i = 0; i < RIP; i++) {
      const a = (V.realT - rT[i]) / 1.4;
      if (a < 0 || a > 1) continue;
      ctx.strokeStyle = rgba(cols[rC[i]], 0.7 * (1 - a) * (1 - a));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(rX[i], rY[i], 9 + 34 * FJ.math.ease.out(a), 0, 6.2832); ctx.stroke();
    }
  }

  function drawLinks(ctx, m) {
    const C = FJ.colors;
    ctx.lineCap = 'round';
    for (const f of flows) {
      if (f.dead || f.rate <= 0) continue;
      if (f.kind === 1 || f.kind === 2) {
        const k = Math.min(1, Math.sqrt(f.rate / 400));
        ctx.strokeStyle = f.col === 2 ? rgba(C.red, 0.2 + 0.45 * k) : f.col === 4 ? rgba(C.amber, 0.2 + 0.45 * k) : rgba(C['text-2'], 0.06 + 0.16 * k);
        ctx.lineWidth = 0.7 + (f.col === 1 ? 1.6 : 2.6) * k;
        ctx.setLineDash(NODASH);
      } else if (f.kind === 0 && !f.local) {
        const moved = f.a < E && sim.home[f.b] !== f.a;
        ctx.strokeStyle = moved ? rgba(C.amber, 0.5) : f.a >= E ? rgba(C.amber, 0.35) : rgba(C.blue, 0.16);
        ctx.lineWidth = moved ? 1.2 : 0.8;
        ctx.setLineDash(moved ? DASH : NODASH);
      } else continue;
      ctx.beginPath(); ctx.moveTo(f.x0, f.y0); ctx.quadraticCurveTo(f.cx, f.cy, f.x1, f.y1); ctx.stroke();
    }
    ctx.setLineDash(NODASH);
  }

  const CLOUD = [];
  function drawClouds(ctx, m, t) {
    const C = FJ.colors;
    if (!CLOUD.length) for (const col of [C.text, C.amber]) for (const a of [0.22, 0.42, 0.7]) CLOUD.push(rgba(col, a));
    const tw = V.reduced ? 0 : 1, DOT = M.mob ? 1.6 : 1.9;
    const A = sim.A;
    // уровень и цвет каждой точки; яркость облака — по местному времени города
    for (let r = 0; r < R; r++) {
      const lit = 0.28 + 0.72 * cdn.dayShape(m.hour + cdn.REGIONS[r].tz);
      let tot = 0;
      for (let n = 0; n < NN; n++) tot += A[r * NN + n];
      const home = sim.home[r];
      const moved = tot > 0 ? 1 - A[r * NN + home] / tot : 0;
      const n0 = M.dot0[r], n = M.dotN[r];
      const nLit = Math.max(2, Math.round(n * lit)), nMoved = Math.round(nLit * moved);
      for (let j = 0; j < n; j++) {
        const k = n0 + j;
        if (j >= nLit) { M.dlv[k] = -1; continue; }
        const v = 0.5 + 0.5 * Math.sin(t * 1.7 * tw + M.dph[k]);
        M.dlv[k] = (j < nMoved ? 3 : 0) + (v < 0.33 ? 0 : v < 0.75 ? 1 : 2);
      }
    }
    for (let c = 0; c < 6; c++) {
      ctx.fillStyle = CLOUD[c];
      ctx.beginPath();
      let any = false;
      for (let k = 0; k < M.nDots; k++) {
        if (M.dlv[k] !== c) continue;
        any = true;
        ctx.rect(M.dx[k] - DOT / 2, M.dy[k] - DOT / 2, DOT, DOT);
      }
      if (any) ctx.fill();
    }
  }

  function ring(ctx, x, y, r, frac, color, lw) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
    if (frac > 0.002) {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, -1.5708, -1.5708 + 6.2832 * Math.min(1, frac)); ctx.stroke();
    }
  }
  const utilCol = (u, C) => (u > 0.97 ? C.red : u > 0.85 ? C.amber : C['text-2']);

  function drawNodes(ctx, m, t, C) {
    const hv = V.hover && V.hover.kind === 'node' ? V.hover.i : -1;
    // отметки на земле под шилдами и ориджином
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let n = E; n < NN; n++) { const x = M.gx[n], y = M.gy[n]; ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); }
    ctx.stroke();
    // узлы у провайдеров
    for (let e = 0; e < E; e++) {
      const x = M.nx[e], y = M.ny[e], em = m.edges[e];
      if (!em.alive) {
        ctx.setLineDash(DASH2); ctx.strokeStyle = rgba(C.red, 0.8); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.2832); ctx.stroke(); ctx.setLineDash(NODASH);
        ctx.strokeStyle = C.red; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
        continue;
      }
      const u = em.util;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.9, 0.22 + 0.55 * u);
      ctx.drawImage(u > 0.97 ? M.spr.r : u > 0.85 ? M.spr.a : M.spr.w, x - 15, y - 15, 30, 30);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ring(ctx, x, y, 8, u, utilCol(u, C), 2);
      ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.2832); ctx.fill();
      if (e === hv) { ctx.strokeStyle = rgba(C.text, 0.7); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 12.5, 0, 6.2832); ctx.stroke(); }
    }
    // шилды
    for (let k = 0; k < S; k++) {
      const n = E + k, x = M.nx[n], y = M.ny[n], sm = m.shields[k];
      if (!sm.alive) {
        ctx.strokeStyle = C.red; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
        ctx.setLineDash(DASH2); ctx.strokeStyle = rgba(C.red, 0.8); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, 6.2832); ctx.stroke(); ctx.setLineDash(NODASH);
        continue;
      }
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 + 0.4 * Math.min(1, sm.util);
      ctx.drawImage(sm.util > 0.97 ? M.spr.r : M.spr.a, x - 18, y - 18, 36, 36);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ring(ctx, x, y, 11, sm.util, utilCol(sm.util, C), 2);
      ctx.fillStyle = BG; ctx.strokeStyle = C.text; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x, y - 5.5); ctx.lineTo(x + 5.5, y); ctx.lineTo(x, y + 5.5); ctx.lineTo(x - 5.5, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (n === hv) { ctx.strokeStyle = rgba(C.text, 0.7); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 15.5, 0, 6.2832); ctx.stroke(); }
    }
    // ориджин
    const x = M.nx[OR], y = M.ny[OR], ou = m.originUtil, over = ou > 1 || m.queueS > 0.05;
    if (over) {
      const ph = (t * 0.9) % 1;
      ctx.strokeStyle = rgba(C.red, 0.55 * (1 - ph)); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 16 + ph * 22, 0, 6.2832); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = over ? 0.9 : 0.45;
    ctx.drawImage(over ? M.spr.r : M.spr.w, x - 22, y - 22, 44, 44);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ring(ctx, x, y, 14, ou, over ? C.red : utilCol(ou, C), 2.2);
    ctx.fillStyle = BG; ctx.strokeStyle = over ? C.red : C.text; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.rect(x - 5.5, y - 5.5, 11, 11); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.stroke();
    if (OR === hv) { ctx.strokeStyle = rgba(C.text, 0.7); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 19, 0, 6.2832); ctx.stroke(); }
  }

  function drawLabels(ctx, m, C) {
    ctx.textBaseline = 'alphabetic';
    for (const L of M.labels) {
      let col = C['text-2'], w = 500;
      if (L.kind === 'origin') { col = m.originUtil > 1 || m.queueS > 0.05 ? C.red : C.text; w = 600; }
      else if (L.kind === 'shield') col = m.shields[L.idx - E].alive ? C.text : C.red;
      else if (L.kind === 'edge') col = m.edges[L.idx].alive ? (m.edges[L.idx].util > 0.97 ? C.red : C['text-2']) : C.red;
      else { col = C.muted; w = 400; }
      ctx.font = w === 400 ? F12L : w === 600 ? F12B : F12M;
      ctx.fillStyle = col; ctx.textAlign = L.al;
      ctx.fillText(L.text, L.x, L.y);
    }
  }

  /* =====================================================================
     Наведение и щелчок
     ===================================================================== */
  function pick(x, y) {
    let best = -1, bd = 15 * 15;
    for (let n = 0; n < NN; n++) {
      const d = (x - M.nx[n]) ** 2 + (y - M.ny[n]) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    if (best >= 0) return { kind: 'node', i: best };
    for (let r = 0; r < R; r++) {
      const d = ((x - M.rx[r]) / (M.rr[r] + 4)) ** 2 + ((y - M.ry[r]) / (M.rr[r] * 0.62 + 4)) ** 2;
      if (d < 1) return { kind: 'region', i: r };
    }
    return null;
  }
  function localXY(ev) {
    const r = M.st.cv.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  function onPointer(ev) {
    const [x, y] = localXY(ev);
    const p = pick(x, y);
    V.hover = p;
    U.screen.classList.toggle('is-hot', !!p && p.kind === 'node' && p.i !== OR);
    paintTip(x, y);
  }
  function onClick(ev) {
    const [x, y] = localXY(ev);
    const p = pick(x, y);
    if (p && p.kind === 'node' && p.i !== OR) { toggleNode(p.i); V.hover = p; paintTip(x, y); }
  }
  function paintTip(x, y) {
    const p = V.hover;
    if (!p || p.list) { U.tip.classList.remove('is-on'); return; }
    U.tip.innerHTML = tipHtml(p);
    if (x != null) {
      const tw = U.tip.offsetWidth || 220, th = U.tip.offsetHeight || 80;
      let lx = x + 16, ly = y - 12;
      if (lx + tw > M.w - 6) lx = x - tw - 16;
      if (ly + th > M.h - 6) ly = M.h - th - 6;
      U.tip.style.transform = `translate(${Math.max(4, Math.round(lx))}px, ${Math.max(4, Math.round(ly))}px)`;
    }
    U.tip.classList.add('is-on');
  }
  function servedBy(r) {
    const A = sim.A;
    let best = -1, ba = 0, tot = 0;
    for (let n = 0; n < NN; n++) { const a = A[r * NN + n]; tot += a; if (a > ba) { ba = a; best = n; } }
    return { n: best, share: tot > 0 ? ba / tot : 0 };
  }
  function tipHtml(p) {
    const m = sim.m;
    if (p.kind === 'region') {
      const g = cdn.REGIONS[p.i], sb = servedBy(p.i);
      const node = sb.n >= 0 ? sim.nodes[sb.n] : null;
      const rtt = sb.n >= 0 ? sim.rttRN[p.i * NN + sb.n] : 0;
      return `<b>${g.name}</b><br>≈${NB}${people(g.pop * 1000)} жителей · вес ${pct(sim.w[p.i])}<br>` +
        (node ? `обслуживает ${node.code}${sb.share < 0.98 ? ' (' + pct(sb.share) + ')' : ''} · RTT ${ms1(rtt)}${NB}мс` : 'не обслуживается');
    }
    const n = p.i;
    if (n < E) {
      const e = cdn.EDGES[n], em = m.edges[n], up = sim.nodes[em.shield];
      const rUp = em.shield === OR ? sim.rttEO[n] : sim.rttES[n * S + (em.shield - E)];
      if (!em.alive) return `<b>${e.code} · ${e.city}</b><br><span class="red">узел лежит</span>: зрители ушли на${NB}соседей<br>нажмите, чтобы поднять`;
      return `<b>${e.code} · ${e.city}</b><br>${em.servers}${NB}×${NB}200${NB}Гбит/с · загрузка ${pct(em.util)}<br>отдаёт ${gbps(em.load)} · хит‑рейт ${pct(em.hit)}<br>промахи → ${up.code} (+${ms1(rUp)}${NB}мс)<br>нажмите, чтобы уронить`;
    }
    if (n < OR) {
      const sh = cdn.SHIELDS[n - E], sm = m.shields[n - E];
      if (!sm.alive) return `<b>${sh.code}</b><br><span class="red">шилд лежит</span>: узлы ходят за${NB}промахами дальше<br>нажмите, чтобы поднять`;
      return `<b>${sh.code} · ${sh.city}</b><br>${K.SHIELD_SERVERS[n - E]}${NB}×${NB}200${NB}Гбит/с · загрузка ${pct(sm.util)}<br>кэш ${K.SHIELD_PCT}${NB}% каталога · хит‑рейт ${pct(m.hitShield)}<br>к${NB}ориджину: ${gbps(sm.up + sm.storm * K.SEG_BITS / 1e9)}<br>нажмите, чтобы уронить`;
    }
    return `<b>ОРИДЖИН · Москва</b><br>ёмкость ${K.ORIGIN_GBPS}${NB}Гбит/с · спрос ${pct(m.originUtil)}<br>${fmt.int(m.originRps)}${NB}запр/с${m.queueS > 0.05 ? ' · очередь ' + fmt.sec(m.queueS, 1) : ''}<br>хранилище и${NB}упаковщик: его не${NB}роняем`;
  }

  /* =====================================================================
     Графики
     ===================================================================== */
  function ensureCurves() {
    const p = sim.p;
    if (V.curves && V.curves.alpha === p.alpha && V.curves.sigma === p.sigma) return V.curves;
    const c = cdn.curves(p.alpha, K.N_TITLES, p.sigma, 150);
    const keep = pts => pts.filter(q => q[0] >= 0.0045);
    V.curves = { alpha: p.alpha, sigma: p.sigma, lru: keep(c.lru), pre: keep(c.prefill), ideal: keep(c.ideal) };
    return V.curves;
  }
  function drawChartA() {
    const st = chA;
    if (!st || st.w < 60) return;
    const { ctx, w, h: H } = st, C = FJ.colors;
    st.clear();
    const cv = ensureCurves();
    const p = new FJ.Plot(ctx, { l: 46, t: 14, w: w - 46 - 24, h: H - 14 - 26 }, { min: 0.005, max: 1, log: true }, { min: 0, max: 1 });
    p.gridX([0.02, 0.03, 0.05, 0.2, 0.3, 0.5], 'rgba(255,255,255,0.035)');
    p.gridX([0.01, 0.1, 1]);
    p.gridY([0.25, 0.5, 0.75, 1]);
    p.labelsY([0, 0.5, 1], v => Math.round(v * 100) + NB + '%', { size: 12 });
    p.labelsX([0.01, 0.1, 1], v => Math.round(v * 100) + NB + '%', { size: 12 });
    p.frame();
    const c = cPct() / 100, hL = sim.tr.hLRU, hP = sim.tr.hPrefill;
    p.clip(() => {
      p.line(cv.ideal, FJ.alpha(C.muted, 0.9), 1.2, [3, 3]);
      p.line(cv.lru, C.q1, 1.8);
      p.line(cv.pre, C.q3, 1.8);
      ctx.setLineDash([2, 3]); ctx.strokeStyle = FJ.alpha(C.text, 0.5); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(p.sx(c)) + 0.5, p.r.t); ctx.lineTo(Math.round(p.sx(c)) + 0.5, p.r.t + p.r.h); ctx.stroke(); ctx.setLineDash(NODASH);
      p.dot(c, hL, sim.p.mode === 'lru' ? 4.5 : 3, C.q1, sim.p.mode === 'lru' ? BG : null);
      p.dot(c, hP, sim.p.mode === 'prefill' ? 4.5 : 3, C.q3, sim.p.mode === 'prefill' ? BG : null);
    });
    // подписи значений у точек: не налезают друг на друга и не выходят за поле
    const right = p.sx(c) > p.r.l + p.r.w * 0.62;
    const tx = p.sx(c) + (right ? -9 : 9);
    let yL = p.sy(hL), yP = p.sy(hP);
    if (Math.abs(yL - yP) < 15) { const mid = (yL + yP) / 2; if (hP >= hL) { yP = mid - 8; yL = mid + 8; } else { yL = mid - 8; yP = mid + 8; } }
    const lim = y => Math.max(p.r.t + 8, Math.min(p.r.t + p.r.h - 8, y));
    ctx.font = FJ.font.mono(12, 600); ctx.textAlign = right ? 'right' : 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.q1; ctx.fillText('LRU ' + pct(hL), tx, lim(yL));
    ctx.fillStyle = C.q3; ctx.fillText('пред. ' + pct(hP), tx, lim(yP));
    p.text(p.r.l + 4, p.r.t + 2, 'хит‑рейт узла', { px: true, size: 12, color: C.muted, base: 'top' });
    p.text(p.r.l + p.r.w, p.r.t + p.r.h - 6, 'кэш, % каталога', { px: true, size: 12, color: C.muted, align: 'right' });
    V.dirtyA = false;
  }
  function crossover() {
    // при какой ошибке прогноза LRU догоняет предзаливку для текущих C и α
    const cat = cdn.catalog(sim.p.alpha, K.N_TITLES), C = sim.C;
    const lru = cdn.lruStats(cat, C).hit;
    const f = s => cdn.prefillStats(cat, C, s).hit - lru;
    if (f(4) > 0) return { s: Infinity };
    if (f(0) <= 0) return { s: 0 };
    let lo = 0, hi = 4;
    for (let i = 0; i < 11; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
    return { s: (lo + hi) / 2 };
  }
  function paintCross() {
    const x = V.cross;
    if (!x) { U.crossNote.textContent = ''; return; }
    U.crossNote.innerHTML = x.s === Infinity ? 'При этом размере кэша предзаливка выигрывает даже при очень плохом прогнозе.'
      : x.s === 0 ? 'При этом размере кэша LRU не&nbsp;хуже даже идеальной предзаливки.'
        : `При кэше ${cPct()}&nbsp;% LRU догоняет предзаливку, когда прогноз ошибается в&nbsp;${fmt.num(Math.exp(x.s), 1)}&nbsp;раза (σ&nbsp;=&nbsp;${fmt.num(x.s, 2)}).`;
  }

  function dayData() {
    const p = sim.p, key = p.mode + p.alpha + ':' + sim.C + ':' + p.sigma;
    if (V.day && V.day.key === key) return V.day;
    const tot = [], miss = [], org = [], fill = [];
    for (let i = 0; i <= 240; i++) {
      const hr = i / 10, s = sim.steady(hr);
      tot.push([hr, s.totalG / 1000]);
      miss.push([hr, Math.max(0.1, s.missG)]);
      org.push([hr, Math.max(0.1, s.originG)]);
      if (s.fillG > 0) fill.push([hr, Math.max(0.1, s.fillG)]);
    }
    V.day = { key, tot, miss, org, fill };
    return V.day;
  }
  function drawChartB() {
    const st = chB;
    if (!st || st.w < 60) return;
    const { ctx, w, h: H } = st, C = FJ.colors, m = sim.m;
    st.clear();
    const d = dayData();
    const L = 44, Rt = 10, top = Math.round((H - 26) * 0.56);
    let capT = 0;
    for (let e = 0; e < E; e++) if (m.edges[e].alive) capT += m.edges[e].cap * K.STEER_LIMIT;
    capT /= 1000;
    const peakT = K.PEAK_VIEWERS * K.BITRATE / 1e12;
    const yMax = Math.max(peakT * 1.1, capT * 1.06, m.totalG / 1000 * 1.05);
    const yt = FJ.ticks(0, yMax, 3);
    const p = new FJ.Plot(ctx, { l: L, t: 14, w: w - L - Rt, h: top - 14 }, { min: 0, max: 24 }, { min: 0, max: yMax });
    const q = new FJ.Plot(ctx, { l: L, t: top + 12, w: w - L - Rt, h: H - top - 12 - 24 }, { min: 0, max: 24 }, { min: 0.1, max: 3000, log: true });
    // окно заливки
    const x0 = p.sx(K.FILL[0]), x1 = p.sx(K.FILL[1]);
    ctx.fillStyle = FJ.alpha(C.violet, 0.09);
    ctx.fillRect(x0, p.r.t, x1 - x0, q.r.t + q.r.h - p.r.t);
    ctx.font = FJ.font.mono(12); ctx.fillStyle = FJ.alpha(C.violet, 0.95); ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('заливка 02–14 МСК', x1 - 4, p.r.t + 2);
    p.gridY(yt.filter(v => v > 0));
    p.labelsY(yt, v => fmt.num(v, v < 10 && v % 1 ? 1 : 0), { size: 12 });
    q.gridY([1, 10, 100, 1000]);
    q.labelsY([0.1, 10, 1000], v => fmt.num(v, v < 1 ? 1 : 0), { size: 12 });
    q.labelsX([0, 6, 12, 18, 24], v => p2(v % 24 === 0 && v ? 24 : v), { size: 12 });
    p.frame(); q.frame();
    p.clip(() => {
      p.area(d.tot, FJ.alpha(C.text, 0.12), 0);
      p.line(d.tot, C.text, 1.5);
      p.line([[0, capT], [24, capT]], FJ.alpha(C['text-2'], 0.55), 1, [4, 4]);
    });
    ctx.font = FJ.font.mono(12); ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('ёмкость узлов', p.r.l + p.r.w - 2, p.sy(capT) - 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Тбит/с', p.r.l + 4, p.r.t + 2);
    q.clip(() => {
      q.line([[0, K.ORIGIN_GBPS], [24, K.ORIGIN_GBPS]], FJ.alpha(C.red, 0.5), 1, [4, 4]);
      q.line(d.miss, C.amber, 1.5);
      q.line(d.org, C.red, 1.5);
      if (d.fill.length) q.line(d.fill, C.violet, 1.8);
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = C.muted;
    ctx.fillText('Гбит/с', q.r.l + 4, q.r.t + 2);
    // текущее время
    const hr = m.hour, X = Math.round(p.sx(hr)) + 0.5;
    ctx.strokeStyle = C.red; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X, p.r.t); ctx.lineTo(X, q.r.t + q.r.h); ctx.stroke();
    p.dot(hr, m.totalG / 1000, 3.5, C.text, BG);
    q.dot(hr, Math.max(0.1, Math.min(3000, m.edgeG - m.edgeHitG)), 3, C.amber);
    q.dot(hr, Math.max(0.1, Math.min(3000, m.originOfferedG)), 3, C.red);
    V.dirtyB = false;
  }
  function drawSpark() {
    const st = spark;
    if (!st || st.w < 20) return;
    const { ctx, w, h: H } = st, C = FJ.colors;
    st.clear();
    if (spkN < 2) return;
    const mu = K.ORIGIN_GBPS * 1e9 / K.SEG_BITS;
    let mx = mu * 1.25;
    for (let i = 0; i < spkN; i++) mx = Math.max(mx, SPK[i]);
    const n = SPK.length, X = i => w * i / (n - 1), Y = v => H - 1 - (H - 3) * Math.min(1, v / mx);
    const yMu = Math.round(Y(mu)) + 0.5;
    ctx.strokeStyle = FJ.alpha(C.red, 0.5); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yMu); ctx.lineTo(w, yMu); ctx.stroke(); ctx.setLineDash(NODASH);
    const start = n - spkN;
    const path = () => {
      ctx.beginPath();
      for (let j = 0; j < spkN; j++) {
        const v = SPK[(spkHead - spkN + j + n) % n];
        const x = X(start + j), y = Y(v);
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
    };
    path(); ctx.strokeStyle = C.amber; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, yMu); ctx.clip();
    path(); ctx.strokeStyle = C.red; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.restore();
  }

  /* =====================================================================
     DOM: сводка, телеметрия, HUD (8 раз в секунду)
     ===================================================================== */
  function setCls(el, bad, warn) {
    el.classList.toggle('is-bad', !!bad);
    el.classList.toggle('is-warn', !bad && !!warn);
  }
  function paintDom() {
    const m = sim.m, p = sim.p;
    // сводка
    U.sTot.b.textContent = gbps(m.totalG);
    U.sTot.s.textContent = people(m.viewers) + ' потоков × 5' + NB + 'Мбит/с';
    U.sOff.b.textContent = pct(m.offload);
    setCls(U.sOff.el, m.offload < 0.5, m.offload < 0.7);
    U.sOrg.b.textContent = gbps(m.originOfferedG);
    U.sOrg.s.textContent = fmt.int(m.originRps) + NB + 'запр/с · ' + pct(m.originUtil) + ' ёмкости';
    setCls(U.sOrg.el, m.originUtil > 1 || m.queueS > 0.05, m.originUtil > 0.8);
    U.sRtt.b.innerHTML = ms1(m.rtt50) + ' / ' + ms1(m.rtt95) + '<small>мс</small>';
    setCls(U.sRtt.el, m.rtt95 > 30, m.rtt95 > 12);
    if (m.hot >= 0) U.sHot.b.innerHTML = pct(m.hotUtil) + '<small>' + cdn.EDGES[m.hot].code + '</small>';
    setCls(U.sHot.el, m.hotUtil > 0.97, m.hotUtil > 0.85);
    // телеметрия
    const kv = U.kv;
    kv.view.dd.textContent = people(m.viewers) + (m.premViewers > 500 ? ' · серия ' + people(m.premViewers) : '');
    kv.hits.dd.textContent = pct(m.hitEdge) + ' / ' + pct(m.hitShield);
    kv.shield.dd.textContent = gbps(m.shieldG) + ' из' + NB + gbps(m.shieldCapG);
    kv.origin.dd.textContent = gbps(m.originG) + ' из' + NB + K.ORIGIN_GBPS + NB + 'Гбит/с' + (m.queueS > 0.05 ? ' · очередь ' + fmt.sec(m.queueS, 1) : '');
    setCls(kv.origin.dd, m.originUtil > 1 || m.queueS > 0.05, m.originUtil > 0.8);
    kv.F.dd.textContent = fmt.sec(m.F, m.F < 1 ? 2 : 1);
    setCls(kv.F.dd, m.F > K.SEG_DUR, m.F > 0.5);
    kv.tc.dd.textContent = p.mode === 'prefill' ? 'набор до' + NB + 'следующей заливки'
      : isFinite(m.tcMin) ? Math.round(m.tcMin) + '–' + Math.round(m.tcMax) + NB + 'мин' : sim.tr.tC === Infinity ? 'всё помещается' : '—';
    let nFill = 0;
    for (let e = 0; e < E; e++) if (m.edges[e].alive && m.edges[e].fill > 0) nFill++;
    kv.fill.dd.textContent = p.mode !== 'prefill' ? 'нет: кэш наполняют промахи' : nFill ? gbps(m.fillG) + ' · ' + nFill + NB + 'из' + NB + E : 'вне окна';
    const pr = m.prem;
    const showPrem = !!pr;
    for (const k of ['prem', 'dup', 'wait']) { kv[k].dt.hidden = !showPrem; kv[k].dd.hidden = !showPrem; }
    if (pr) {
      kv.prem.dd.textContent = pr.prefilled ? 'на' + NB + 'узлах, залита заранее' : 'нет на' + NB + 'узлах';
      setCls(kv.prem.dd, false, !pr.prefilled);
      kv.dup.dd.textContent = pr.prefilled ? '0' + NB + '— промахов нет' : pr.storm ? (p.collapse ? fmt.num(pr.dup, pr.dup < 10 ? 1 : 0) + ' (схлопнуто)' : '1 + λ·F ≈ ' + fmt.int(pr.dup)) : '—';
      setCls(kv.dup.dd, pr.storm && pr.dup > 50, pr.storm && pr.dup > 2);
      kv.wait.dd.textContent = pr.storm && pr.stall > 0.02 ? people(pr.waiting) + ' · стоят ' + pct(pr.stall) + ' времени' : '—';
      setCls(kv.wait.dd, pr.storm && pr.stall > 0.02, false);
    }
    // список узлов
    for (let e = 0; e < E; e++) {
      const em = m.edges[e], ui = U.edges[e];
      const dead = !em.alive;
      ui.b.setAttribute('aria-pressed', String(dead));
      ui.mi.style.setProperty('--v', dead ? '0' : Math.min(1, em.util).toFixed(3));
      ui.val.textContent = dead ? 'лежит' : pct(em.util);
      const cls = dead ? '' : em.util > 0.97 ? 'is-bad' : em.util > 0.85 ? 'is-warn' : '';
      if (cls !== ui.cls) { ui.b.classList.remove('is-bad', 'is-warn'); if (cls) ui.b.classList.add(cls); ui.cls = cls; }
      ui.b.classList.toggle('is-hl', !!(V.hover && V.hover.kind === 'node' && V.hover.i === e && !V.hover.list));
    }
    U.bDrop.textContent = DROP.every(x => sim.isAlive(x)) ? 'Уронить узел' : 'Уронить ещё';
    U.bDrop.disabled = !DROP.some(x => sim.isAlive(x));
    // HUD и строка монитора
    paintHud(m);
    if (!V.dragging) U.slTime.set(Math.round(m.hour * 4) / 4 % 24);
    U.clock.textContent = clock(sim.t);
    U.speed.textContent = (V.speed < 0.5 ? 'пауза' : '×' + Math.round(V.speed)) + ' · МСК';
    if (V.hover && !V.hover.list) paintTip();
  }

  function tag(cls, head, tail) {
    return `<span class="cdn-tag ${cls}"><b>${head}</b>${tail ? '<span>' + tail + '</span>' : ''}</span>`;
  }
  function paintHud(m) {
    const out = [];
    let level = 0, status = 'штатно';
    const pr = m.prem, p = sim.p;
    if (pr) {
      if (pr.u < 0) {
        out.push(tag('is-warn', 'ПРЕМЬЕРА ЧЕРЕЗ ' + mss(pr.u), '00:00 по' + NB + 'Москве · ' + (pr.prefilled ? 'серия уже на' + NB + 'узлах' : 'серии на' + NB + 'узлах нет')));
        level = Math.max(level, 1); status = 'обратный отсчёт';
      } else if (pr.prefilled) {
        out.push(tag('is-ok', 'ПРЕМЬЕРА +' + mss(pr.u), 'серия залита на' + NB + 'узлы ночью' + NB + '— ориджин не' + NB + 'нужен'));
        status = 'премьера с' + NB + 'узлов';
      } else if (pr.storm && !p.collapse && pr.dup > 3) {
        const nd = Math.round(pr.dup);
        out.push(tag('is-bad', 'ПРЕМЬЕРА +' + mss(pr.u), 'лавина промахов: ' + fmt.int(nd) + NB + fmt.plural(nd, 'запрос', 'запроса', 'запросов') + ' наверх на' + NB + 'объект · F' + NB + '=' + NB + fmt.sec(pr.F, 1) + ' · включите схлопывание'));
        level = 2; status = 'лавина промахов';
      } else if (pr.storm) {
        out.push(tag(pr.F > K.LOCK_TIMEOUT ? 'is-bad' : 'is-warn', 'ПРЕМЬЕРА +' + mss(pr.u), pr.F > K.LOCK_TIMEOUT ? 'F' + NB + '>' + NB + '5' + NB + 'с: ждавшие дольше таймаута замка идут наверх сами' : 'схлопывание: один запрос наверх на' + NB + 'объект'));
        level = Math.max(level, pr.F > K.LOCK_TIMEOUT ? 2 : 1); status = 'премьера, промахи схлопнуты';
      }
    }
    const dead = [];
    for (let e = 0; e < E; e++) if (!m.edges[e].alive) dead.push(e);
    for (let k = 0; k < S; k++) if (!m.shields[k].alive) dead.push(E + k);
    if (dead.length) {
      const id = V.failId && !sim.isAlive(V.failId) ? sim.nodeIndex(V.failId) : dead[dead.length - 1];
      let tail = '';
      if (id < E) {
        const to = new Set();
        for (let r = 0; r < R; r++) if (sim.home[r] === id) for (let n = 0; n < NN; n++) if (sim.A[r * NN + n] > 0.5) to.add(sim.nodes[n].code);
        const b = V.rtt95Before || m.rtt95;
        tail = (to.size ? 'зрители → ' + Array.from(to).slice(0, 3).join(', ') + ' · ' : '') + 'p95 RTT ' + (Math.abs(b - m.rtt95) > 0.2 ? ms1(b) + ' → ' : '') + ms1(m.rtt95) + NB + 'мс';
      } else tail = 'узлы ходят за' + NB + 'промахами дальше';
      out.push(tag('is-bad', 'ОТКАЗ ' + sim.nodes[id].code + (dead.length > 1 ? ' +' + (dead.length - 1) : ''), tail));
      level = 2; status = 'отказ узла';
    }
    if (!pr && (m.originUtil > 1 || m.queueS > 0.05)) {
      out.push(tag('is-bad', 'ОРИДЖИН ПЕРЕГРУЖЕН', 'спрос ' + pct(m.originUtil) + ' ёмкости: кэшам не' + NB + 'хватает места'));
      level = 2; status = 'перегрузка ориджина';
    } else if (m.hotUtil > 0.97) {
      level = Math.max(level, 1);
    }
    if (!out.length && p.mode === 'prefill' && m.fillG > 0) {
      let nF = 0;
      for (let e = 0; e < E; e++) if (m.edges[e].fill > 0) nF++;
      out.push(tag('', 'ОКНО ЗАЛИВКИ', nF + NB + fmt.plural(nF, 'узел докачивает', 'узла докачивают', 'узлов докачивают') + ' прогноз на' + NB + 'завтра: ' + gbps(m.fillG)));
    }
    const html = out.join('');
    if (html !== U.hud._html) { U.hud.innerHTML = html; U.hud._html = html; }
    U.tally.className = 'tally' + (level === 2 ? ' on' : level === 1 ? ' warn' : '');
    if (U.status.textContent !== status) { U.status.textContent = status; U.live.textContent = 'Модель сети: ' + status; }
  }

  /* =====================================================================
     Фигура
     ===================================================================== */
  function mount(el) {
    writeText();
    sim = new cdn.Sim({ mode: DEF.mode, cPct: CPCT[DEF.cIdx], alpha: DEF.alpha, sigma: DEF.sigma, collapse: DEF.collapse, t: DEF.hour * 3600 });
    buildDom(el);
    U.cSigma.classList.add('cdn-dim');
    V.crossT = 0.4;                                // посчитать после первых кадров
    sim.step(0);
    paintDom();
    if (root.document && document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (M.st) layoutMap(M.st); V.dirtyA = V.dirtyB = true; });
  }

  function frame(dt) {
    if (!sim) return;
    V.realT += dt;
    // скорость часов плавно идёт к нужной
    const want = targetSpeed();
    if (want === 0) V.speed = 0;
    else {
      const cur = Math.max(1, V.speed);
      V.speed = Math.exp(Math.log(cur) + (Math.log(want) - Math.log(cur)) * (1 - Math.exp(-dt / 0.45)));
      if (Math.abs(V.speed - want) < 0.02 * want) V.speed = want;
    }
    const step = dt * V.speed;
    const u0 = sim.prem ? sim.t - sim.prem.t0 : 1;
    sim.step(step);
    if (sim.prem && u0 < 0 && sim.t - sim.prem.t0 >= 0) {          // серия вышла
      const c = sim.prem.prefilled ? 0 : 1;
      for (let e = 0; e < E; e++) if (sim.alive[e]) ripple(M.nx[e], M.ny[e], c);
      if (!sim.prem.prefilled) ripple(M.nx[OR], M.ny[OR], 1);
    }
    drawMap(dt, V.realT);
    // искра ориджина — 12 раз в секунду
    V.sparkT += dt;
    if (V.sparkT > 1 / 12) {
      V.sparkT = 0;
      SPK[spkHead] = sim.m.originRps; spkHead = (spkHead + 1) % SPK.length; spkN = Math.min(SPK.length, spkN + 1);
      drawSpark();
    }
    V.domT += dt;
    if (V.domT > 0.125) { V.domT = 0; paintDom(); }
    V.chartT += dt;
    if (V.dirtyA) drawChartA();
    if (V.dirtyB || V.chartT > 0.25) { V.chartT = 0; drawChartB(); }
    if (V.crossT > 0 && V.realT > V.crossT) { V.crossT = -1; V.cross = crossover(); paintCross(); }
  }

  FJ.figure({
    id: 'cdn', el: $('#fig-cdn'),
    mount,
    start() { V.fillAll = true; V.dirtyA = V.dirtyB = true; },
    stop() { },
    frame,
  });
})(window);

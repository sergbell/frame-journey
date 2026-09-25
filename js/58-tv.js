/* =====================================================================
   58-tv — глава «Смарт-ТВ»: интерфейс «с дивана» и предзагрузка по фокусу,
   зоопарк платформ (движки Tizen и webOS по годам) и пиксели на градус.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const film = FJ.film, asset = FJ.asset, net = FJ.net;

  /* ---------- данные о платформах (документация Samsung и LG) ---------- */
  const CH = { 38: 2014.8, 47: 2015.9, 53: 2016.6, 56: 2017.1, 63: 2017.9, 68: 2018.5, 69: 2018.7, 76: 2019.6, 79: 2019.95, 85: 2020.6, 87: 2020.9, 94: 2021.7, 108: 2022.9, 120: 2023.95, 130: 2024.8, 132: 2025.05 };
  const SAMSUNG = [
    [2015, 'Tizen 2.3', 'WebKit', 2013.5, ['черновик MSE']], [2016, 'Tizen 2.4', 'WebKit', 2013.5, []], [2017, 'Tizen 3.0', 47], [2018, 'Tizen 4.0', 56],
    [2019, 'Tizen 5.0', 63, null, ['MSE/EME W3C', 'cbcs']], [2020, 'Tizen 5.5', 69, null, ['CMAF', 'AV1 (UHD)']], [2021, 'Tizen 6.0', 76, null, ['AV1']], [2022, 'Tizen 6.5', 85],
    [2023, 'Tizen 7.0', 94], [2024, 'Tizen 8.0', 108], [2025, 'Tizen 9.0', 120], [2026, 'Tizen 10', 130],
  ];
  const LG = [
    [2014, 'webOS 1', 'WebKit', 2013.5, ['без MSE']], [2015, 'webOS 2', 'WebKit', 2013.5, []], [2016, 'webOS 3.0', 38], [2017, 'webOS 3.5', 38],
    [2018, 'webOS 4.0', 53], [2019, 'webOS 4.5', 53], [2020, 'webOS 5', 68, null, ['MSE/EME W3C', 'AV1']], [2021, 'webOS 6', 79],
    [2022, 'webOS 22', 87], [2023, 'webOS 23', 94], [2024, 'webOS 24', 108], [2025, 'webOS 25', 120], [2026, 'webOS 26', 132],
  ];

  /* ---------- каталог «с дивана» ---------- */
  const TITLES = [
    ['Восемь планов', 1200], ['Ночной город', 540], ['Рассвет', 250], ['Колобок и ветер', 400], ['Поезд на север', 720],
    ['Чай при свечах', 900], ['Маяк', 1060], ['У костра', 1250], ['Титры', 1400], ['Отсчёт', 80],
  ];
  const TV = { cv: null, ctx: null, posters: [], focus: 0, focusAt: 0, mode: 'browse', player: null, pressAt: 0, pre: null, runs: [], t: 0 };
  let devId = 'oldtv', prefetch = true, wfCv = null, fragCv = null, ppdCv = null, ppd = { diag: 55, dist: 2.5, res: 1080 }, ppdOut = null, ttffOut = null;

  function devTrace() { return net.makeTrace(FJ.devices[devId].trace, 21); }

  /* Хронология старта: подготовка плеера → манифест → плейлист → init → лицензия ∥ первый сегмент → кадр */
  function timeline(t0, trace, dev, segBytes) {
    const steps = []; let t = t0;
    steps.push({ label: 'подготовка плеера', t0: t, t1: t + dev.appStart, kind: 'local' }); t += dev.appStart;
    for (const [label, b] of [['master.m3u8', 2800], ['плейлист качества', 3400], ['init.mp4', 820]]) { const e = net.downloadEnd(trace, t, b); steps.push({ label, t0: t, t1: e, kind: 'net' }); t = e; }
    const lic = net.downloadEnd(trace, t, 1600) + 0.08, seg = net.downloadEnd(trace, t, segBytes);
    steps.push({ label: 'лицензия DRM', t0: t, t1: lic, kind: 'drm' }, { label: 'первый сегмент', t0: t, t1: seg, kind: 'seg' });
    const first = Math.max(lic, seg) + 0.06;
    steps.push({ label: 'первый кадр', t0: first, t1: first, kind: 'frame' });
    return { steps, done: first };
  }
  function firstSegBytes() {
    const r = 3; // стартовая ступень при оценке 500 кбит/с — 270p
    const s = asset.segs[r][3];
    return s && s.ready ? s.bytes : 100000;
  }

  function mount(el) {
    FJ.addStyle(`
      .tv-wrap { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
      @media (min-width: 1100px) { .tv-wrap { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); align-items: start; } }
      .tv-set { background: #0a0a0b; border: 1px solid #2b2d31; border-radius: 10px; padding: 12px 12px 10px; display: grid; gap: 8px; }
      .tv-set .monitor__screen { border-radius: 3px; outline: none; }
      .tv-set .monitor__screen:focus-visible { box-shadow: 0 0 0 2px var(--amber); }
      .tv-brand { display: flex; justify-content: space-between; align-items: center; font: 500 11.5px var(--f-mono); color: var(--muted); letter-spacing: .12em; }
      .tv-pad { display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); gap: 4px; }
      .tv-pad button { appearance: none; border: 1px solid var(--line-2); background: var(--panel); color: var(--text); border-radius: 50%; cursor: pointer; display: grid; place-items: center; }
      .tv-pad button:hover { background: var(--panel-2); }
      .tv-pad .ok { border-radius: 50%; background: var(--text); color: #121315; font: 700 12px var(--f-text); }
      .tv-pad svg { width: 14px; height: 14px; }
      .tv-wf { height: 340px; }
      .tv-frag { height: 300px; }
      .tv-ppd { height: 300px; }
    `);
    FJ.sources['nf-help-hdcp'] = ['Netflix Help Center. Как смотреть в 4K / HDR: HDCP 2.2', 'https://help.netflix.com/en/node/13444'];
    FJ.sources['okko-2014'] = ['«Ведомости». Умное Okko (05.09.2014)', 'https://www.vedomosti.ru/business/articles/2014/09/05/umnoe-okko'];
    FJ.sources['premier-2024'] = ['Kinometro. Premier: итоги 2024 года (29.01.2025)', 'https://www.kinometro.ru/news/show/name/premier_itogi24_29012025'];
    FJ.sources['mvideo-2025'] = ['М.Видео-Эльдорадо. Продажи телевизоров по ОС, январь–сентябрь 2025 (21.10.2025)', 'https://www.mvideoeldorado.ru/ru/press-centr/press-relizy/detail/3954'];
    FJ.sources['okko-habr-2020'] = ['Хабр / RUVDS. Интервью с CTO Okko об устройстве сервиса (20.06.2020)', 'https://habr.com/ru/companies/ruvds/articles/507364/'];
    FJ.sources['okko-habr-2026'] = ['Хабр, блог Okko. Как мы пересобрали платформу (13.08.2026)', 'https://habr.com/ru/companies/okko/articles/1069762/'];
    FJ.sources['okko-vt2023'] = ['VideoTech 2023. Ускорение первого кадра в сценарии вьюпорта (Okko)', 'https://vtconf.com/en/archive/2023/talks/20003064-acceleration-of-the-first-frame-in-a-viewport-scenario-technical-and-visual-on-the-product-side/'];
    FJ.sources['samsung-avplay'] = ['Samsung Smart TV FAQ: мультимедиа и стриминг (буфер AVPlay)', 'https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html'];
    FJ.sources['bitmovin-tv'] = ['Bitmovin. Smart TVs: configuration and best practices', 'https://developer.bitmovin.com/playback/docs/smart-tvs-configuration-and-best-practices'];
    FJ.sources['itu-bt2022'] = ['ITU-R BT.2022. General viewing conditions for subjective assessment of quality of SDTV and HDTV (08.2012)', 'https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2022-0-201208-W!!PDF-E.pdf'];
    FJ.sources['vmaf-faq'] = ['Netflix VMAF: FAQ — модель по умолчанию, 1080p на расстоянии 3H', 'https://github.com/Netflix/vmaf/blob/master/resource/doc/faq.md'];
    FJ.sources['cambridge'] = ['University of Cambridge. Is your Ultra-HD TV worth it? (27.10.2025)', 'https://www.cam.ac.uk/research/news/is-your-ultra-hd-tv-worth-it-scientists-measure-the-resolution-limit-of-the-human-eye'];

    $('#tvText').innerHTML = `
      <p>Для российского онлайн‑кинотеатра телевизор&nbsp;— главный экран. Ещё в&nbsp;2014 году Okko получал больше 90&nbsp;% выручки со&nbsp;Smart TV${FJ.cite('okko-2014')}, у&nbsp;Premier в&nbsp;2024 году на&nbsp;Smart TV пришлось больше 60&nbsp;% времени просмотра${FJ.cite('premier-2024')}. И&nbsp;это самый трудный экран. Телевизоры продают на&nbsp;Android TV, YaOS, VIDAA, «Салют ТВ», Tizen и&nbsp;webOS${FJ.cite('mvideo-2025')}. Samsung и&nbsp;LG в&nbsp;2022 году остановили официальные поставки, но&nbsp;их телевизоры остались в&nbsp;квартирах. Приложение на&nbsp;них&nbsp;— веб‑страница на&nbsp;том движке, с&nbsp;которым телевизор вышел с&nbsp;завода. Обновлять его никто не&nbsp;будет.</p>
      <p>Поэтому один манифест всем не&nbsp;подходит. В&nbsp;2020 году Okko отдавал DASH с&nbsp;CENC браузерам и&nbsp;новым Samsung/LG, Smooth Streaming с&nbsp;PlayReady старым телевизорам, HLS с&nbsp;FairPlay&nbsp;— Safari. Для совсем старых платформ свой модуль nginx переписывал манифесты на&nbsp;лету${FJ.cite('okko-habr-2020')}. В&nbsp;2026 году плеер разделили на&nbsp;SDK под каждую платформу, и&nbsp;телевизоры в&nbsp;разборе названы самым сложным направлением${FJ.cite('okko-habr-2026')}. Мелочи тоже бьют по&nbsp;качеству. Буфер AVPlay у&nbsp;Samsung по&nbsp;умолчанию&nbsp;— 10&nbsp;секунд или 15&nbsp;МБ${FJ.cite('samsung-avplay')}. Tizen 2016 года ломается, если baseMediaDecodeTime больше 2³²${FJ.cite('bitmovin-tv')}.</p>
      <p><strong>Старт.</strong> Телевизоры стартуют медленнее всех: в&nbsp;замере Conviva 2022 года видео на&nbsp;LG TV запускалось за&nbsp;7,33&nbsp;с против 2,89&nbsp;с на&nbsp;Apple TV${FJ.cite('conviva')}. Зрители начинают уходить после двух секунд ожидания${FJ.cite('krishnan')}. Главный приём&nbsp;— начать загрузку, пока зритель ещё выбирает: фокус задержался на&nbsp;постере, и&nbsp;плеер уже тянет манифест, лицензию, init и&nbsp;первый сегмент. Инженеры Okko рассказывали об&nbsp;этом на&nbsp;VideoTech 2023${FJ.cite('okko-vt2023')}. Попробуйте ниже стрелками или пультом.</p>`;

    // --- телевизор и пульт ---
    const screen = h('div', { class: 'monitor__screen', tabindex: '0', role: 'application', 'aria-label': 'Интерфейс телевизора: стрелки двигают фокус, Enter запускает просмотр, Escape возвращает в каталог' });
    const cv = h('canvas', { width: 1280, height: 720 });
    screen.append(cv);
    TV.cv = cv; TV.ctx = cv.getContext('2d');
    const devSeg = h('div'); const preTg = h('div');
    const set = h('div', { class: 'tv-set' }, [screen, h('div', { class: 'tv-brand' }, [h('span', { text: 'ТЕЛЕВИЗОР · ГОСТИНАЯ' }), h('span', { class: 'tally on' })])]);
    const pad = h('div', { class: 'tv-pad', role: 'group', 'aria-label': 'Пульт' });
    const arrow = d => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${{ u: 'M3 11l5-6 5 6', d: 'M3 5l5 6 5-6', l: 'M11 3l-6 5 6 5', r: 'M5 3l6 5-6 5' }[d]}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
    const mkBtn = (html, cls, act, label) => { const b = h('button', { type: 'button', class: cls || '', html, 'aria-label': label }); b.addEventListener('click', () => { act(); screen.focus({ preventScroll: true }); }); return b; };
    pad.append(h('span'), mkBtn(arrow('u'), '', () => key('ArrowUp'), 'Вверх'), h('span'),
      mkBtn(arrow('l'), '', () => key('ArrowLeft'), 'Влево'), mkBtn('OK', 'ok', () => key('Enter'), 'OK'), mkBtn(arrow('r'), '', () => key('ArrowRight'), 'Вправо'),
      mkBtn('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h10" fill="none" stroke="currentColor" stroke-width="2"/></svg>', '', () => key('Escape'), 'Назад'), mkBtn(arrow('d'), '', () => key('ArrowDown'), 'Вниз'), h('span'));
    screen.addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Backspace'].includes(e.key)) { e.preventDefault(); key(e.key); } });

    ttffOut = h('div', { class: 'stat-row' });
    const side = h('div', { class: 'stack' }, [
      h('div', { class: 'row gap-l', style: { alignItems: 'flex-start' } }, [pad, h('div', { class: 'stack', style: { gap: '10px', flex: '1', minWidth: '200px' } }, [h('span', { class: 'ctl-label', text: 'Телевизор' }), devSeg, preTg])]),
      ttffOut,
      h('div', { class: 'panel', style: { padding: '12px' } }, [h('span', { class: 'ctl-label', text: 'Старт после нажатия OK: без предзагрузки и с ней' }), wfHost()]),
    ]);
    el.append(h('div', { class: 'tv-wrap' }, [set, side]));
    FJ.seg(devSeg, [{ v: 'oldtv', label: 'ТВ 2016 года' }, { v: 'tv', label: 'ТВ 4K, 2024' }], devId, v => { devId = v; TV.pre = null; TV.focusAt = TV.t; paintWf(); }, { small: true });
    FJ.toggle(preTg, { id: 'tvPre', label: 'Предзагрузка по фокусу', value: prefetch, onChange: v => { prefetch = v; TV.pre = null; TV.focusAt = TV.t; } });
    el.append(h('p', { class: 'caption', html: 'Модель: время запросов считает та&nbsp;же модель сети, что и&nbsp;в&nbsp;гонке, по&nbsp;типичной сети телевизора (Wi‑Fi); «подготовка плеера»&nbsp;— условная задержка слабого процессора (иллюстративно). Видео после OK&nbsp;— настоящее, из&nbsp;нашей фермы. Предзагрузка стартует, если фокус задержался на&nbsp;постере дольше 0,6&nbsp;с.' }));

    // --- платформы ---
    el.append(h('h3', { text: 'Телевизор 2016 года — это браузер 2014-го', style: { marginTop: '24px' } }));
    const fragHost = h('div', { class: 'fig__canvas tv-frag', role: 'img', 'aria-label': 'Движки веб-приложений телевизоров Samsung и LG по годам выпуска и их возраст в 2026 году' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [fragHost,
      h('div', { class: 'legend', style: { marginTop: '8px' } }, [h('span', null, [h('i', { class: 'box', style: { '--c': '#ff4d3d' } }), 'движку 8+ лет']), h('span', null, [h('i', { class: 'box', style: { '--c': '#ffb02e' } }), '4–7 лет']), h('span', null, [h('i', { class: 'box', style: { '--c': '#5bcb5e' } }), 'до 3 лет'])])]));
    el.append(h('p', { class: 'caption', html: `По&nbsp;спецификациям Samsung и&nbsp;LG${FJ.cite('tizen-spec')}${FJ.cite('webos-spec')}. Возраст&nbsp;— сколько лет в&nbsp;2026 году исполнилось версии Chromium или WebKit, на&nbsp;которой работает приложение. Полноценные MSE и&nbsp;EME по&nbsp;стандарту W3C появились у&nbsp;Samsung в&nbsp;2019 году, у&nbsp;LG&nbsp;— в&nbsp;2020‑м. Всё, что старше, требует обходных путей.` }));
    fragCv = FJ.canvas(fragHost, { onResize: () => paintFrag() });

    // --- пиксели на градус ---
    el.append(h('h3', { text: 'Когда 4K заметен с дивана', style: { marginTop: '24px' } }));
    const ppdHost = h('div', { class: 'fig__canvas tv-ppd', role: 'img', 'aria-label': 'Карта: при какой диагонали и дистанции разница между 1080p и 4K видна глазу' });
    const ctl = h('div', { class: 'row gap-l' });
    const sd = h('div'), sdist = h('div'), sres = h('div');
    ctl.append(sd, sdist, h('div', { class: 'stack', style: { gap: '6px' } }, [h('span', { class: 'ctl-label', text: 'Разрешение' }), sres]));
    FJ.slider(sd, { id: 'tvDiag', label: 'Диагональ', min: 24, max: 100, step: 1, value: ppd.diag, fmt: v => v + '″', onInput: v => { ppd.diag = v; paintPpd(); } });
    FJ.slider(sdist, { id: 'tvDist', label: 'До дивана', min: 1, max: 5, step: 0.1, value: ppd.dist, fmt: v => fmt.num(v, 1) + ' м', onInput: v => { ppd.dist = v; paintPpd(); } });
    FJ.seg(sres, [{ v: 720, label: '720p' }, { v: 1080, label: '1080p' }, { v: 2160, label: '4K' }, { v: 4320, label: '8K' }], ppd.res, v => { ppd.res = v; paintPpd(); }, { small: true });
    ppdOut = h('div', { class: 'stat-row' });
    el.append(h('div', { class: 'tv-wrap' }, [
      h('div', { class: 'panel', style: { padding: '12px' } }, [ppdHost]),
      h('div', { class: 'stack' }, [ctl, ppdOut, h('p', { class: 'caption', html: `Острота зрения 1,0 (20/20)&nbsp;— это 60 пикселей на&nbsp;градус; на&nbsp;это рассчитана модель VMAF по&nbsp;умолчанию (1080p на&nbsp;расстоянии трёх высот экрана)${FJ.cite('vmaf-faq')}. ITU-R BT.2022 ставит зрителя 1080p на&nbsp;3,2 высоты экрана, 4K&nbsp;— на&nbsp;1,6${FJ.cite('itu-bt2022')}. Предел глаза, измеренный в&nbsp;Кембридже в&nbsp;2025 году,&nbsp;— около 94 пикселей на&nbsp;градус${FJ.cite('cambridge')}. Для кинотеатра вывод простой: верх лесенки нужен прежде всего телевизорам, телефону столько не&nbsp;разглядеть.` })]),
    ]));
    ppdCv = FJ.canvas(ppdHost, { onResize: () => paintPpd() });

    // постеры
    film.init().then(() => {
      TV.posters = TITLES.map(([name, fi]) => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 300;
        const x = c.getContext('2d');
        x.drawImage(film.render(fi), 640 - 240, 0, 480, 720, 0, 0, 200, 300);
        const g = x.createLinearGradient(0, 150, 0, 300); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.85)');
        x.fillStyle = g; x.fillRect(0, 150, 200, 150);
        x.fillStyle = '#f4f3ee'; x.font = '800 30px "Sofia Sans Extra Condensed", "Arial Narrow", sans-serif'; x.textBaseline = 'alphabetic';
        wrap(x, name.toUpperCase(), 12, 262, 176, 28);
        return c;
      });
      paintFrag(); paintPpd(); paintWf();
    });
  }
  function wfHost() { const d = h('div', { class: 'fig__canvas tv-wf', role: 'img', 'aria-label': 'Водопад запросов при старте воспроизведения' }); setTimeout(() => { wfCv = FJ.canvas(d, { onResize: () => paintWf() }); paintWf(); }, 0); return d; }
  function wrap(x, text, X, Y, W, lh) {
    const words = text.split(' '); let line = '', lines = [];
    for (const w of words) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > W && line) { lines.push(line); line = w; } else line = t; }
    lines.push(line);
    lines.forEach((l, i) => x.fillText(l, X, Y - (lines.length - 1 - i) * lh));
  }

  /* ---------- пульт ---------- */
  function key(k) {
    if (TV.mode === 'playing') {
      if (k === 'Escape' || k === 'Backspace') { stopPlay(); }
      return;
    }
    const cols = 5, n = TITLES.length;
    let f = TV.focus;
    if (k === 'ArrowRight') f = Math.min(n - 1, f + 1);
    if (k === 'ArrowLeft') f = Math.max(0, f - 1);
    if (k === 'ArrowDown') f = Math.min(n - 1, f + cols);
    if (k === 'ArrowUp') f = Math.max(0, f - cols);
    if (f !== TV.focus) { TV.focus = f; TV.focusAt = TV.t; TV.pre = null; }
    if (k === 'Enter') startPlay();
  }
  function startPlay() {
    const dev = FJ.devices[devId], sb = firstSegBytes();
    const now = TV.t;
    // Та же трасса и то же начало отсчёта, что у плеера: числа на экране и в водопаде совпадают
    const cold = timeline(0, devTrace(), dev, sb);
    let warm = null;
    if (prefetch && TV.pre) warm = TV.pre;
    const warmLeft = warm ? Math.max(0, warm.doneAbs - now) : null;
    TV.runs = [{ label: 'без предзагрузки', tl: cold, press: 0 }];
    if (warm) TV.runs.push({ label: 'с предзагрузкой', tl: warm.tl, press: now - warm.startAbs });
    TV.lastTtff = { cold: cold.done, warm: warm ? warmLeft + 0.06 : null };
    if (TV.player) TV.player.destroy();
    TV.player = null;
    TV.mode = 'playing'; TV.pressAt = now; TV.firstAt = null;
    // с предзагрузкой плеер получит первый сегмент, когда она закончится; без неё — стартует с нуля
    TV.launchAt = warm ? now + warmLeft : now;
    TV.launchPreload = !!warm;
    paintWf(); paintTtff();
  }
  function launch() {
    const dev = FJ.devices[devId];
    const vc = TV.video || (TV.video = document.createElement('canvas'));
    vc.width = 1280; vc.height = 720;
    TV.player = new FJ.Player({ asset, canvas: vc, device: dev, trace: devTrace(), algoId: 'bola', startAt: 6, preload: TV.launchPreload, startup: !TV.launchPreload });
    TV.launchAt = null;
  }
  function stopPlay() {
    if (TV.player) { TV.player.destroy(); TV.player = null; }
    TV.mode = 'browse'; TV.focusAt = TV.t; TV.pre = null; TV.launchAt = null;
  }

  /* ---------- рисование экрана ТВ ---------- */
  function paintTV() {
    const x = TV.ctx, W = 1280, H = 720;
    if (TV.mode === 'playing') {
      const p = TV.player;
      if (p) p.render(TV.video.getContext('2d'));
      x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
      if (p && p.stats.ttff != null) x.drawImage(TV.video, 0, 0, W, H);
      else {
        const t = (TV.t % 1);
        x.strokeStyle = 'rgba(255,255,255,.2)'; x.lineWidth = 8; x.beginPath(); x.arc(W / 2, H / 2, 40, 0, Math.PI * 2); x.stroke();
        x.strokeStyle = '#ffb02e'; x.beginPath(); x.arc(W / 2, H / 2, 40, t * Math.PI * 2, t * Math.PI * 2 + 1.4); x.stroke();
      }
      x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(40, 36, 520, 60);
      x.fillStyle = '#fff'; x.font = '500 26px "JetBrains Mono", monospace'; x.textBaseline = 'middle';
      x.fillText(TV.firstAt != null ? `первый кадр через ${fmt.sec(TV.firstAt - TV.pressAt, 2)}` : `ждём… ${fmt.sec(TV.t - TV.pressAt, 1)}`, 60, 66);
      x.font = '500 20px "Golos Text", sans-serif'; x.fillStyle = 'rgba(255,255,255,.75)'; x.textAlign = 'right';
      x.fillText('«Назад» — в каталог', W - 44, 66); x.textAlign = 'left';
      return;
    }
    // каталог
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#15161a'); g.addColorStop(1, '#0b0b0d');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = '#f4f3ee'; x.font = '800 44px "Sofia Sans Extra Condensed", "Arial Narrow", sans-serif'; x.textBaseline = 'alphabetic';
    x.fillText('КИНОТЕАТР', 60, 76);
    x.font = '500 22px "Golos Text", sans-serif'; x.fillStyle = 'rgba(244,243,238,.6)';
    x.fillText('Продолжить просмотр', 60, 136); x.fillText('Новинки', 60, 436);
    const pw = 200, ph = 270, gap = 36, x0 = 60;
    TITLES.forEach((t, i) => {
      const row = Math.floor(i / 5), col = i % 5;
      const px = x0 + col * (pw + gap), py = 156 + row * 300;
      const foc = i === TV.focus;
      const s = foc ? 1.08 : 1;
      x.save();
      x.translate(px + pw / 2, py + ph / 2); x.scale(s, s); x.translate(-pw / 2, -ph / 2);
      if (TV.posters[i]) x.drawImage(TV.posters[i], 0, 0, pw, ph);
      else { x.fillStyle = '#222'; x.fillRect(0, 0, pw, ph); }
      if (foc) {
        x.strokeStyle = '#f4f3ee'; x.lineWidth = 5; x.strokeRect(-3, -3, pw + 6, ph + 6);
        // индикатор предзагрузки
        if (prefetch) {
          const pre = TV.pre;
          let prog = 0, label = 'фокус';
          if (pre) { prog = FJ.math.clamp((TV.t - pre.startAbs) / (pre.doneAbs - pre.startAbs), 0, 1); label = prog >= 1 ? 'готов к старту' : 'предзагрузка'; }
          x.fillStyle = 'rgba(0,0,0,.72)'; x.fillRect(8, 8, pw - 16, 30);
          x.fillStyle = prog >= 1 ? '#5bcb5e' : '#ffb02e'; x.fillRect(8, 34, (pw - 16) * prog, 4);
          x.fillStyle = '#fff'; x.font = '500 16px "JetBrains Mono", monospace'; x.textBaseline = 'middle';
          x.fillText(label, 16, 22);
        }
      }
      x.restore();
    });
  }

  /* ---------- водопад старта ---------- */
  function paintWf() {
    if (!wfCv) return;
    const { ctx, w, h: H } = wfCv;
    wfCv.clear();
    const runs = TV.runs.length ? TV.runs : [{ label: 'без предзагрузки', tl: timeline(0, devTrace(), FJ.devices[devId], firstSegBytes()), press: 0 }];
    const minT = Math.min(0, ...runs.map(r => r.tl.steps[0].t0 - r.press));
    const maxT = Math.max(1, ...runs.map(r => r.tl.done - r.press)) * 1.08;
    const rows = [];
    runs.forEach((r, i) => { if (i) rows.push(null); rows.push({ head: r.label }); r.tl.steps.forEach(st => rows.push({ r, s: st })); });
    const p = new FJ.Plot(ctx, { l: 132, t: 4, w: w - 142, h: H - 26 }, { min: minT, max: maxT }, { min: 0, max: 1 });
    const xt = FJ.ticks(minT, maxT, 6);
    p.gridX(xt); p.labelsX(xt, v => fmt.num(v, 1) + ' с', { size: 10 });
    const colors = { local: '#8f9197', net: '#6fb3ff', drm: '#a58bff', seg: '#ffb02e', frame: '#5bcb5e' };
    const rh = p.r.h / rows.length;
    rows.forEach((x, i) => {
      if (!x) return;
      const y = p.r.t + i * rh;
      if (x.head) {
        ctx.fillStyle = FJ.colors.text; ctx.font = FJ.font.mono(10.5, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(x.head.toUpperCase(), 0, y + rh / 2);
        return;
      }
      const a = x.s.t0 - x.r.press, b = x.s.t1 - x.r.press;
      ctx.fillStyle = colors[x.s.kind];
      if (x.s.kind === 'frame') { ctx.beginPath(); ctx.arc(p.sx(a), y + rh / 2, 4.5, 0, 7); ctx.fill(); }
      else ctx.fillRect(p.sx(a), y + rh * 0.22, Math.max(2, p.sx(b) - p.sx(a)), rh * 0.56);
      ctx.fillStyle = FJ.colors['text-2']; ctx.font = FJ.font.text(11.5); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(x.s.label, p.r.l - 8, y + rh / 2);
    });
    ctx.strokeStyle = FJ.colors.red; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.sx(0), p.r.t); ctx.lineTo(p.sx(0), p.r.t + p.r.h); ctx.stroke();
    ctx.font = FJ.font.mono(10, 600); ctx.fillStyle = FJ.colors.red; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('OK', p.sx(0) + 4, p.r.t + 2);
  }
  function paintTtff() {
    const t = TV.lastTtff; if (!t) return;
    ttffOut.innerHTML = `<div class="stat"><b>${fmt.sec(t.cold, 2)}</b><span>до первого кадра без предзагрузки</span></div>` +
      (t.warm != null ? `<div class="stat"><b>${fmt.sec(t.warm, 2)}</b><span>с предзагрузкой по фокусу</span></div>` : '<div class="stat"><b>—</b><span>предзагрузка выключена</span></div>');
  }

  /* ---------- платформы ---------- */
  function paintFrag() {
    if (!fragCv) return;
    const { ctx, w, h: H } = fragCv;
    fragCv.clear();
    const p = new FJ.Plot(ctx, { l: 84, t: 26, w: w - 96, h: H - 52 }, { min: 2013.5, max: 2026.5 }, { min: 0, max: 2 });
    const years = []; for (let y = 2014; y <= 2026; y++) years.push(y);
    p.gridX(years.map(y => y - 0.5));
    p.labelsX(years.filter(y => w > 700 || y % 2 === 0), v => String(v), { size: 10 });
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('год модели →', p.r.l + p.r.w, 14);
    const lane = (arr, row, name) => {
      const y0 = p.r.t + row * p.r.h / 2, lh = p.r.h / 2;
      ctx.fillStyle = FJ.colors.text; ctx.font = FJ.font.display(20, 800); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(name, p.r.l - 12, y0 + lh / 2);
      for (const [year, os, eng, engYear, feats] of arr) {
        const ey = typeof eng === 'number' ? CH[eng] : engYear;
        const age = 2026 - Math.floor(ey);
        const col = age >= 8 ? '#ff4d3d' : age >= 4 ? '#ffb02e' : '#5bcb5e';
        const x0 = p.sx(year - 0.46), x1 = p.sx(year + 0.46);
        const bw = x1 - x0;
        ctx.fillStyle = FJ.alpha(col, 0.16); ctx.fillRect(x0, y0 + 6, bw, lh - 12);
        ctx.fillStyle = col; ctx.fillRect(x0, y0 + 6, 3, lh - 12);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        if (bw > 44) {
          ctx.fillStyle = FJ.colors.text; ctx.font = FJ.font.mono(10, 500);
          ctx.fillText(typeof eng === 'number' ? 'Ch ' + eng : eng, x0 + 7, y0 + 12);
          ctx.fillStyle = FJ.colors.muted; ctx.font = FJ.font.mono(9.5);
          ctx.fillText(os.replace('webOS ', 'w').replace('Tizen ', 'T'), x0 + 7, y0 + 26);
          ctx.fillStyle = col; ctx.font = FJ.font.mono(10, 600);
          ctx.fillText(age + ' ' + fmt.plural(age, 'год', 'года', 'лет'), x0 + 7, y0 + 40);
          (feats || []).forEach((f, k) => { ctx.fillStyle = FJ.colors['text-2']; ctx.font = FJ.font.text(10); ctx.fillText(f, x0 + 7, y0 + 58 + k * 13); });
        } else {
          ctx.fillStyle = FJ.colors.text; ctx.font = FJ.font.mono(9);
          ctx.save(); ctx.translate(x0 + bw / 2 + 3, y0 + lh - 12); ctx.rotate(-Math.PI / 2);
          ctx.fillText((typeof eng === 'number' ? 'Ch ' + eng : eng) + ' · ' + age, 0, 0); ctx.restore();
        }
      }
    };
    lane(SAMSUNG, 0, 'Samsung');
    lane(LG, 1, 'LG');
  }

  /* ---------- пиксели на градус ---------- */
  function ppdOf(diag, dist, lines) {
    const W = diag * 0.0254 * 16 / Math.hypot(16, 9);
    const px = W / (lines * 16 / 9);
    return 1 / (Math.atan(px / dist) * 180 / Math.PI);
  }
  function paintPpd() {
    if (!ppdCv) return;
    const { ctx, w, h: H } = ppdCv;
    ppdCv.clear();
    const p = new FJ.Plot(ctx, { l: 42, t: 12, w: w - 52, h: H - 42 }, { min: 1, max: 5 }, { min: 24, max: 100 });
    // карта для 1080p: где глаз различает пиксели 1080p (значит, 4K даст прибавку)
    const cols = Math.max(40, Math.floor(p.r.w / 4)), rows = Math.max(30, Math.floor(p.r.h / 4));
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const d = 1 + (i + 0.5) / cols * 4, D = 24 + (j + 0.5) / rows * 76;
      const v = ppdOf(D, d, 1080);
      ctx.fillStyle = v < 60 ? 'rgba(91,203,94,.30)' : v < 94 ? 'rgba(255,176,46,.20)' : 'rgba(143,145,151,.10)';
      ctx.fillRect(p.r.l + i / cols * p.r.w, p.r.t + (1 - (j + 1) / rows) * p.r.h, p.r.w / cols + 0.5, p.r.h / rows + 0.5);
    }
    p.gridX([1, 2, 3, 4, 5]); p.gridY([32, 43, 55, 65, 75, 85, 100]);
    p.labelsX([1, 2, 3, 4, 5], v => v + ' м', { size: 10 }); p.labelsY([32, 43, 55, 65, 75, 85, 100], v => v + '″');
    // линии проектных дистанций ITU-R BT.2022: 1080p — 3,2H, 4K — 1,6H
    const lineFor = kH => { const pts = []; for (let D = 24; D <= 100; D += 2) { const Hm = D * 0.0254 * 9 / Math.hypot(16, 9); pts.push([kH * Hm, D]); } return pts.filter(q => q[0] >= 1 && q[0] <= 5); };
    p.clip(() => { p.line(lineFor(3.2), '#e6e5e0', 1.2, [5, 4]); p.line(lineFor(1.6), '#6fb3ff', 1.2, [5, 4]); });
    ctx.font = FJ.font.mono(10); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const l32 = lineFor(3.2), l16 = lineFor(1.6);
    if (l32.length) { const q = l32[l32.length - 1]; ctx.fillStyle = '#e6e5e0'; ctx.textAlign = 'right'; ctx.fillText('1080p · 3,2H', p.sx(q[0]) - 6, p.sy(q[1]) + 14); ctx.textAlign = 'left'; }
    if (l16.length) { const q = l16[l16.length - 1]; ctx.fillStyle = '#6fb3ff'; ctx.fillText('4K · 1,6H', p.sx(q[0]) + 6, p.sy(q[1]) + 14); }
    // точка зрителя
    p.dot(ppd.dist, ppd.diag, 6, '#ff4d3d', '#000');
    ctx.fillStyle = FJ.colors.text; ctx.font = FJ.font.mono(11, 600);
    ctx.fillText('вы', p.sx(ppd.dist) + 9, p.sy(ppd.diag) + 4);
    // легенда внутри
    ctx.font = FJ.font.text(11);
    const L = [['rgba(91,203,94,.6)', '1080p виден по пикселям — 4K заметен'], ['rgba(255,176,46,.55)', '4K заметен только при отличном зрении'], ['rgba(143,145,151,.45)', 'разницы 1080p и 4K глаз не видит']];
    const lw = Math.max(...L.map(q => ctx.measureText(q[1]).width)) + 34;
    const lx = p.r.l + p.r.w - lw - 8, ly = p.r.t + p.r.h - 60;
    ctx.fillStyle = 'rgba(14,15,16,.88)'; ctx.fillRect(lx, ly, lw, 54);
    L.forEach(([c, t], k) => { ctx.fillStyle = c; ctx.fillRect(lx + 8, ly + 8 + k * 16, 10, 10); ctx.fillStyle = FJ.colors.text; ctx.textBaseline = 'middle'; ctx.fillText(t, lx + 24, ly + 13 + k * 16); });
    // числа
    const v = ppdOf(ppd.diag, ppd.dist, ppd.res);
    const Wm = ppd.diag * 0.0254 * 16 / Math.hypot(16, 9);
    const ang = 2 * Math.atan(Wm / 2 / ppd.dist) * 180 / Math.PI;
    const name = { 720: '720p', 1080: '1080p', 2160: '4K', 4320: '8K' }[ppd.res];
    const verdict = v < 60 ? 'глаз различает отдельные пиксели' : v < 94 ? 'на границе остроты зрения' : 'пиксели неразличимы';
    ppdOut.innerHTML = `<div class="stat"><b>${fmt.int(v)}</b><span>пикселей на градус у ${name}: ${verdict}</span></div><div class="stat"><b>${fmt.int(ang)}°</b><span>экран по горизонтали (THX советует около 40°)</span></div>`;
  }

  FJ.figure({
    id: 'tv', el: $('#fig-tv'),
    mount,
    start() { paintFrag(); paintPpd(); },
    stop() { if (TV.player) stopPlay(); },
    frame(dt) {
      TV.t += dt;
      // предзагрузка по фокусу
      if (TV.mode === 'browse' && prefetch && !TV.pre && TV.t - TV.focusAt > 0.6) {
        const tl = timeline(0, devTrace(), FJ.devices[devId], firstSegBytes());
        TV.pre = { tl, startAbs: TV.t, doneAbs: TV.t + tl.done };
      }
      if (TV.mode === 'playing' && !TV.player && TV.launchAt != null && TV.t >= TV.launchAt) launch();
      if (TV.player) {
        TV.player.update(dt);
        if (TV.player.stats.ttff != null && TV.firstAt == null) TV.firstAt = TV.t;
      }
      paintTV();
    },
  });
})(window);

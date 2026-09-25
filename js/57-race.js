/* =====================================================================
   57-race — глава «Плеер»: гонка четырёх ABR-алгоритмов.
   Четыре настоящих плеера смотрят один фильм через одинаковые (но
   независимые) сети. У каждого своё видео, буфер, остановки и панель
   «мыслей». Трассу можно нарисовать мышью.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const asset = FJ.asset;

  const ALG = ['tput', 'bba', 'bola', 'mpc'];
  const ACOL = { tput: '#6fb3ff', bba: '#ffb02e', bola: '#a58bff', mpc: '#ff7eb6' };
  const NETS = [['steps', 'Ступени'], ['wifi', 'Wi‑Fi'], ['lte', '4G'], ['hsdpa', '3G в электричке'], ['tunnel', 'Метро'], ['evening', 'Вечерний пик'], ['draw', 'Нарисовать']];
  const DEVS = ['tv', 'oldtv', 'stb', 'phone', 'laptop'];

  let netId = 'steps', devId = 'tv', trace = null, custom = null;
  let racers = [], chart = null, drawCv = null, drawing = false, board = null, running = true;
  let tBoard = 0, tBrain = 0;

  FJ.addStyle(`
    .race-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 1180px) { .race-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 560px) { .race-grid { grid-template-columns: minmax(0, 1fr); } }
    .racer { display: grid; gap: 8px; min-width: 0; }
    .racer .monitor__screen .buf { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 4px; background: rgba(0,0,0,.55); border-radius: 1px; overflow: hidden; }
    .racer .monitor__screen .buf i { position: absolute; inset: 0; transform-origin: left; background: var(--c); transform: scaleX(var(--v, 0)); }
    .racer__brain { height: 128px; }
    .racer__name { font-family: var(--f-display); font-weight: 800; font-size: 22px; letter-spacing: .02em; text-transform: uppercase; color: var(--c); line-height: 1; }
    .racer__desc { font-size: 12.5px; color: var(--muted); line-height: 1.45; min-height: 3.1em; margin: 0; }
    .race-bar { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
    @media (min-width: 1100px) { .race-bar { grid-template-columns: auto auto 1fr; align-items: end; } }
    .race-chart { height: 300px; }
    .race-draw { height: 170px; cursor: crosshair; touch-action: none; }
    .race-score td.is-lead { color: var(--text); font-weight: 600; }
    .race-score .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--c); margin-right: 8px; vertical-align: 1px; }
  `);

  function makeTrace() {
    if (netId === 'draw') return custom || FJ.net.customTrace(defaultDrawn());
    return FJ.net.makeTrace(netId, 3);
  }
  function defaultDrawn() {
    const base = FJ.net.makeTrace('steps', 3).bps;
    return Array.from(base, v => v);
  }

  function restart() {
    trace = makeTrace();
    const dev = FJ.devices[devId];
    racers.forEach(rc => {
      if (rc.player) rc.player.destroy();
      rc.player = new FJ.Player({ asset, canvas: rc.cv, name: rc.id, device: dev, trace, algoId: rc.id, startAt: 6 });
    });
    board = null;
  }

  function mount(el) {
    $('#playerText').innerHTML = `
      <p>Плеер ничего не знает о сети наперёд. Перед каждым сегментом он решает, какое качество просить, и&nbsp;ошибается в&nbsp;обе стороны: взял высоко&nbsp;— буфер кончился и&nbsp;картинка встала, взял низко&nbsp;— зритель смотрит мыло на&nbsp;большом экране. Это решение называют ABR, adaptive bitrate.</p>
      <p>Школ три. <strong>По пропускной способности</strong>: измерить, как быстро пришли прошлые сегменты, и&nbsp;взять ступень с&nbsp;запасом. Так делает hls.js: минимум двух скользящих средних с&nbsp;полураспадом 3 и&nbsp;9&nbsp;с, запас 0,95 вниз и&nbsp;0,7 вверх${FJ.cite('hlsjs')}. <strong>По буферу</strong>: смотреть только на&nbsp;запас видео. Такой BBA в&nbsp;Netflix на&nbsp;полумиллионе зрителей дал на&nbsp;10–20&nbsp;% меньше ребуферизаций при том&nbsp;же битрейте${FJ.cite('bba')}. BOLA выводит то&nbsp;же из&nbsp;оптимизации по&nbsp;Ляпунову и&nbsp;стоит в&nbsp;dash.js${FJ.cite('bola')}${FJ.cite('dashjs')}. <strong>По модели</strong>: MPC перебирает планы на&nbsp;пять сегментов вперёд по&nbsp;осторожному прогнозу сети${FJ.cite('mpc')}.</p>
      <p>Какая школа лучше, решает не&nbsp;статья, а&nbsp;живые зрители. В&nbsp;рандомизированном эксперименте Puffer (63&nbsp;508 пользователей, 38,6 года видео) простой BBA оказался наравне со&nbsp;сложными схемами, а&nbsp;обученная на&nbsp;эмуляторе нейросеть проиграла на&nbsp;реальных сетях${FJ.cite('puffer')}. Цена ошибки измерена: каждая лишняя секунда старта после двух&nbsp;— плюс 5,8&nbsp;% ушедших зрителей${FJ.cite('krishnan')}, а&nbsp;+1&nbsp;% времени буферизации отнимает больше трёх минут просмотра 90‑минутного эфира${FJ.cite('dobrian')}.</p>
      <p>Ниже&nbsp;— четыре настоящих плеера. Сети у&nbsp;них одинаковые, но&nbsp;независимые, а&nbsp;видео каждый декодирует своё. Выберите трассу или нарисуйте свою.</p>`;

    FJ.sources['shaka'] = ['Shaka Player: player_configuration.js и ewma_bandwidth_estimator.js (коммит a8cded8)', 'https://github.com/shaka-project/shaka-player/blob/a8cded8db74ff5bcddbac20087f6ca184d825bfe/lib/util/player_configuration.js'];
    FJ.sources['media3'] = ['AndroidX Media3: AdaptiveTrackSelection и DefaultBandwidthMeter (1.11.1)', 'https://github.com/androidx/media/blob/8c6678b657ede1e7883fc164ef73ed483c7796c3/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/trackselection/AdaptiveTrackSelection.java'];
    $('#playerAside').innerHTML = `
      <h3>Что стоит по умолчанию</h3>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Плеер</th><th>Оценка сети</th><th class="r">Запас</th><th>Особенность</th></tr></thead>
        <tbody>
          <tr><td>hls.js 1.7</td><td>min(EWMA 3&nbsp;с, 9&nbsp;с)<br><span class="muted">старт 500&nbsp;кбит/с</span></td><td class="r mono">0,95 / 0,7</td><td>успеет&nbsp;ли сегмент<br>до конца буфера</td></tr>
          <tr><td>dash.js 5</td><td>min(EWMA ≈2&nbsp;с, ≈5,3&nbsp;с)</td><td class="r mono">0,9</td><td>до 12&nbsp;с буфера&nbsp;— по сети,<br>дальше BOLA, назад ниже 6&nbsp;с</td></tr>
          <tr><td>Shaka Player</td><td>min(EWMA 2&nbsp;с, 5&nbsp;с)<br><span class="muted">старт 1&nbsp;Мбит/с</span></td><td class="r mono">0,95</td><td>не&nbsp;чаще раза в&nbsp;8&nbsp;с</td></tr>
          <tr><td>Media3 / ExoPlayer</td><td>медиана с&nbsp;весом √байт</td><td class="r mono">0,7</td><td>вверх при буфере ≥&nbsp;10&nbsp;с,<br>вниз не&nbsp;при ≥&nbsp;25&nbsp;с</td></tr>
        </tbody></table></div>
      <p class="caption">Сверено по&nbsp;исходникам: hls.js${FJ.cite('hlsjs')}, dash.js${FJ.cite('dashjs')}, Shaka${FJ.cite('shaka')}, Media3${FJ.cite('media3')}. «Запас»&nbsp;— какую долю оценки плеер готов потратить на&nbsp;битрейт; у&nbsp;hls.js вниз и&nbsp;вверх он разный.</p>`;

    // панель управления
    const bar = h('div', { class: 'race-bar' });
    const netBox = h('div', { class: 'stack', style: { gap: '8px' } }, [h('span', { class: 'ctl-label', text: 'Сеть' })]);
    const netSeg = h('div'); netBox.append(netSeg);
    const devBox = h('div', { class: 'stack', style: { gap: '8px' } }, [h('span', { class: 'ctl-label', text: 'Устройство' })]);
    const devSeg = h('div'); devBox.append(devSeg);
    const btns = h('div', { class: 'row', style: { justifyContent: 'flex-end' } });
    const bRe = h('button', { class: 'btn', type: 'button' }, [svgIcon('restart'), 'Заново']);
    const bPause = h('button', { class: 'btn', type: 'button' }, [svgIcon('pause'), 'Пауза']);
    btns.append(bRe, bPause);
    bar.append(netBox, devBox, btns);
    el.append(bar);

    const netDesc = h('p', { class: 'caption', id: 'raceNetDesc' });
    el.append(netDesc);

    FJ.seg(netSeg, NETS.map(([v, label]) => ({ v, label })), netId, v => {
      netId = v;
      drawWrap.hidden = v !== 'draw';
      restart(); paintNetDesc();
    }, { small: true });
    FJ.seg(devSeg, DEVS.map(v => ({ v, label: FJ.devices[v].short })), devId, v => { devId = v; restart(); paintNetDesc(); }, { small: true });
    bRe.addEventListener('click', restart);
    bPause.addEventListener('click', () => {
      running = !running;
      bPause.replaceChildren(svgIcon(running ? 'pause' : 'play'), running ? 'Пауза' : 'Дальше');
    });

    // поле для рисования трассы
    const drawWrap = h('div', { class: 'panel', style: { padding: '12px' } });
    drawWrap.hidden = true;
    drawWrap.append(h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '8px' } }, [
      h('span', { class: 'ctl-label', text: 'Нарисуйте пропускную способность на 120 с · 0–6 Мбит/с' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { custom = FJ.net.customTrace(drawnVals); restart(); } }, ['Запустить с этой трассой']),
    ]));
    const drawHost = h('div', { class: 'fig__canvas race-draw', role: 'img', 'aria-label': 'Поле для рисования трассы сети' });
    drawWrap.append(drawHost);
    el.append(drawWrap);
    drawCv = FJ.canvas(drawHost, { onResize: () => paintDraw() });
    setupDrawing(drawHost);

    // четыре плеера
    const grid = h('div', { class: 'race-grid' });
    racers = ALG.map(id => {
      const a = FJ.abr.ALGOS[id];
      const cv = h('canvas', { width: 640, height: 360, 'aria-label': 'Плеер ' + a.name });
      const bufI = h('i');
      const stall = h('div', { class: 'stall' }, [h('div', { class: 'stall__ring' })]);
      const rungTag = h('span', { class: 'tag', text: '—' });
      const stateTag = h('span', { class: 'tag', text: 'СТАРТ' });
      const umdTxt = h('span', { text: 'ждём сегмент' });
      const umdV = h('span', { class: 'v', text: '0,0 с' });
      const tally = h('span', { class: 'tally warn' });
      const screen = h('div', { class: 'monitor__screen' }, [cv,
        h('div', { class: 'hud' }, [h('div', { class: 'hud__tl' }, [stateTag]), h('div', { class: 'hud__tr' }, [rungTag])]),
        h('div', { class: 'buf', style: { '--c': ACOL[id] } }, [bufI]), stall]);
      const mon = h('div', { class: 'monitor' }, [screen, h('div', { class: 'umd' }, [tally, h('span', { class: 'lbl', text: a.short }), umdTxt, umdV])]);
      const brainHost = h('div', { class: 'fig__canvas racer__brain', role: 'img', 'aria-label': 'Как думает ' + a.name });
      const card = h('div', { class: 'racer', style: { '--c': ACOL[id] } }, [
        h('div', { class: 'racer__name', text: a.name }),
        h('p', { class: 'racer__desc', text: a.desc }),
        mon, h('div', { class: 'panel', style: { padding: '8px' } }, [brainHost]),
      ]);
      grid.append(card);
      const rc = { id, cv, bufI, stall, rungTag, stateTag, umdTxt, umdV, tally, brain: null, brainHost };
      return rc;
    });
    el.append(grid);
    racers.forEach(rc => { rc.brain = FJ.canvas(rc.brainHost); });

    // общий график
    const chartHost = h('div', { class: 'fig__canvas race-chart', role: 'img', 'aria-label': 'Сеть, выбранные битрейты и буферы четырёх плееров' });
    el.append(h('div', { class: 'panel', style: { padding: '12px 12px 8px' } }, [chartHost,
      h('div', { class: 'legend', style: { marginTop: '8px' } }, [
        legendItem('#bfc0c3', 'ёмкость сети', 'box'),
        ...ALG.map(id => legendItem(ACOL[id], FJ.abr.ALGOS[id].name)),
        legendItem('#ff4d3d', 'остановка', 'dot'),
      ])]));
    chart = FJ.canvas(chartHost);

    // табло
    const tbl = h('table', { class: 'tbl race-score' });
    tbl.innerHTML = `<thead><tr><th>Алгоритм</th><th class="r">Средний битрейт</th><th class="r">Остановки</th><th class="r">Переключения</th><th class="r">Старт</th><th class="r">Скачано</th><th class="r" title="QoE_lin: средний битрейт − колебания − μ·остановки, на сегмент">QoE на сегмент</th></tr></thead><tbody></tbody>`;
    el.append(h('div', { class: 'tbl-wrap' }, [tbl]));
    board = null;
    el.__tbody = tbl.querySelector('tbody');
    el.append(h('p', { class: 'caption', html: `QoE считается как в&nbsp;MPC и&nbsp;Pensieve: сумма битрейтов (Мбит/с) минус сумма скачков между соседними сегментами минус μ&nbsp;× секунды остановок, где μ&nbsp;— верхний битрейт лесенки${FJ.cite('pensieve')}. С&nbsp;таким μ секунда остановки стоит ровно один сегмент верхнего качества, поэтому RobustMPC иногда выигрывает, даже останавливаясь: он честно максимизирует формулу. Какой вес дать остановкам&nbsp;— решение продукта, а&nbsp;не&nbsp;алгоритма. Трассы синтетические, 3G&nbsp;— по&nbsp;мотивам HSDPA-трасс из&nbsp;Осло${FJ.cite('riiser')}. Стартовая оценка сети у&nbsp;всех одна&nbsp;— 500&nbsp;кбит/с, как в&nbsp;hls.js. MPC знает размеры будущих сегментов, как в&nbsp;оригинальной постановке.` }));

    restart();
    paintNetDesc();
    asset.on('done', () => racers.forEach(rc => rc.player && rc.player.refreshLadder()));
  }

  function paintNetDesc() {
    const d = FJ.devices[devId];
    const tr = trace || makeTrace();
    $('#raceNetDesc').innerHTML = `<strong>${tr.name}:</strong> ${tr.desc}. RTT ${fmt.ms(tr.rtt)}. <strong>${d.name}:</strong> буфер до&nbsp;${d.maxBuffer}&nbsp;с${d.topRung ? ', верх — ' + asset.ladder[d.topRung].name : ''}. ${d.note}.`;
  }

  function legendItem(c, label, kind) {
    return h('span', null, [h('i', { class: kind || '', style: { '--c': c } }), label]);
  }
  function svgIcon(kind) {
    const paths = {
      restart: '<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2v3.5h3.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
      pause: '<path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2"/>',
      play: '<path d="M5 3l8 5-8 5z" fill="currentColor"/>',
    };
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = paths[kind];
    return s;
  }

  /* ---------- рисование трассы ---------- */
  let drawnVals = defaultDrawn();
  function setupDrawing(host) {
    const MAXB = 6e6;
    let last = null;
    const put = e => {
      const r = host.getBoundingClientRect();
      const x = FJ.math.clamp((e.clientX - r.left) / r.width, 0, 0.9999);
      const y = FJ.math.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      const i = Math.floor(x * drawnVals.length);
      const v = Math.max(0.02e6, y * MAXB);
      if (last != null) { const a = Math.min(last, i), b = Math.max(last, i); for (let k = a; k <= b; k++) drawnVals[k] = v; }
      drawnVals[i] = v; last = i;
      paintDraw();
    };
    host.addEventListener('pointerdown', e => { drawing = true; last = null; host.setPointerCapture(e.pointerId); put(e); });
    host.addEventListener('pointermove', e => { if (drawing) put(e); });
    host.addEventListener('pointerup', () => { drawing = false; last = null; });
    host.addEventListener('pointercancel', () => { drawing = false; last = null; });
  }
  function paintDraw() {
    if (!drawCv) return;
    const { ctx, w, h: H } = drawCv;
    drawCv.clear();
    const p = new FJ.Plot(ctx, { l: 34, t: 6, w: w - 40, h: H - 26 }, { min: 0, max: 120 }, { min: 0, max: 6 });
    p.gridY([1, 2, 3, 4, 5, 6]); p.labelsY([0, 2, 4, 6], v => v + '');
    p.labelsX([0, 30, 60, 90, 120], v => v + ' с');
    asset.ladder.forEach((rg, r) => { ctx.strokeStyle = FJ.alpha(FJ.colors.q[r], 0.5); ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(rg.kbps / 1000)); ctx.lineTo(p.r.l + p.r.w, p.sy(rg.kbps / 1000)); ctx.stroke(); ctx.setLineDash([]); });
    const pts = Array.from(drawnVals, (v, i) => [i * 0.5, v / 1e6]);
    p.area(pts.concat([[120, pts[pts.length - 1][1]]]), FJ.alpha('#bfc0c3', 0.25), 0);
    p.step(pts, '#e6e5e0', 1.5, 120);
  }

  /* ---------- «мысли» алгоритмов ---------- */
  function paintBrain(rc) {
    const { ctx, w, h: H } = rc.brain;
    rc.brain.clear();
    const pl = rc.player, b = pl.algo.brain;
    const col = ACOL[rc.id];
    ctx.font = FJ.font.mono(11); ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    if (!b) { ctx.fillStyle = FJ.colors.muted; ctx.fillText('ждёт первого решения', 6, 6); return; }
    const N = pl.rungs.length;
    const kb = q => asset.ladder[pl.rOf(q)].kbps;
    if (rc.id === 'tput') {
      // бюджеты против битрейтов ступеней
      const maxK = Math.max(kb(N - 1) * 1.6, (b.bw || 0) / 1000 * 1.05);
      const p = new FJ.Plot(ctx, { l: 6, t: 18, w: w - 12, h: H - 26 }, { min: 0, max: N }, { min: 0, max: maxK });
      for (let q = 0; q < N; q++) {
        const c = b.cand[q]; const r = pl.rOf(q);
        const x0 = p.sx(q + 0.12), x1 = p.sx(q + 0.88);
        const br = c ? c.br / 1000 : kb(q);
        ctx.fillStyle = FJ.alpha(FJ.colors.q[r], q === b.pick ? 0.95 : 0.35);
        ctx.fillRect(x0, p.sy(br), x1 - x0, p.sy(0) - p.sy(br));
      }
      const bw = b.bw / 1000;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(bw)); ctx.lineTo(p.r.l + p.r.w, p.sy(bw)); ctx.stroke();
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(bw * 0.95)); ctx.lineTo(p.r.l + p.r.w, p.sy(bw * 0.95)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(bw * 0.7)); ctx.lineTo(p.r.l + p.r.w, p.sy(bw * 0.7)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = FJ.colors['text-2'];
      ctx.fillText(`оценка ${fmt.rate(b.bw)} · ×0,95 вниз · ×0,7 вверх`, 6, 2);
    } else if (rc.id === 'bba') {
      const p = new FJ.Plot(ctx, { l: 30, t: 18, w: w - 36, h: H - 34 }, { min: 0, max: pl.maxBuffer }, { min: 0, max: kb(N - 1) * 1.1 });
      ctx.fillStyle = FJ.alpha(FJ.colors.red, 0.12); ctx.fillRect(p.sx(0), p.r.t, p.sx(Math.min(b.r, pl.maxBuffer)) - p.sx(0), p.r.h);
      for (let q = 0; q < N; q++) { ctx.strokeStyle = FJ.alpha(FJ.colors.q[pl.rOf(q)], 0.45); ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(kb(q))); ctx.lineTo(p.r.l + p.r.w, p.sy(kb(q))); ctx.stroke(); }
      const pts = []; for (let B = 0; B <= pl.maxBuffer; B += 0.25) pts.push([B, pl.algo.map(B)]);
      p.line(pts, col, 2);
      p.dot(Math.min(b.B, pl.maxBuffer), kb(b.q), 4, FJ.colors.q[pl.rOf(b.q)], '#000');
      p.labelsX([0, b.r, Math.min(b.r + b.c, pl.maxBuffer)].filter((v, i, a) => a.indexOf(v) === i), v => v + ' с', { size: 10 });
      ctx.fillStyle = FJ.colors['text-2']; ctx.font = FJ.font.mono(11); ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillText(`буфер ${fmt.sec(b.B, 1)} → f(B) = ${fmt.int(b.f)} кбит/с · ${b.why}`, 6, 2);
    } else if (rc.id === 'bola') {
      const s = b.scores; const mx = Math.max(...s.map(Math.abs), 1e-9);
      const p = new FJ.Plot(ctx, { l: 6, t: 18, w: w - 12, h: H - 26 }, { min: 0, max: N }, { min: -mx, max: mx });
      ctx.strokeStyle = FJ.colors['line-2']; ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(0)); ctx.lineTo(p.r.l + p.r.w, p.sy(0)); ctx.stroke();
      for (let q = 0; q < N; q++) {
        const x0 = p.sx(q + 0.15), x1 = p.sx(q + 0.85), y0 = p.sy(0), y1 = p.sy(s[q]);
        ctx.fillStyle = FJ.alpha(FJ.colors.q[pl.rOf(q)], q === b.q ? 0.95 : 0.35);
        ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
      }
      ctx.fillStyle = FJ.colors['text-2']; ctx.fillText(`(V·(u−1+γ) − B)/битрейт · B = ${fmt.sec(b.B, 1)} · ${b.mode}`, 6, 2);
    } else if (rc.id === 'mpc') {
      const H2 = pl.algo.H;
      const p = new FJ.Plot(ctx, { l: 8, t: 20, w: w - 16, h: H - 30 }, { min: -0.5, max: H2 - 0.5 }, { min: -0.5, max: N - 0.5 });
      for (let j = 0; j < H2; j++) for (let q = 0; q < N; q++) { ctx.fillStyle = FJ.alpha(FJ.colors.q[pl.rOf(q)], 0.18); ctx.beginPath(); ctx.arc(p.sx(j), p.sy(q), 3, 0, 7); ctx.fill(); }
      if (b.plan) {
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
        b.plan.forEach((q, j) => { const X = p.sx(j), Y = p.sy(q); j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke();
        b.plan.forEach((q, j) => { ctx.fillStyle = FJ.colors.q[pl.rOf(q)]; ctx.beginPath(); ctx.arc(p.sx(j), p.sy(q), 4.5, 0, 7); ctx.fill(); });
      }
      ctx.fillStyle = FJ.colors['text-2'];
      ctx.fillText(`прогноз ${fmt.rate(b.pred)} ÷ (1 + ${fmt.pct(b.maxErr)}) = ${fmt.rate(b.robust)}`, 6, 2);
    }
  }

  /* ---------- общий график ---------- */
  function paintChart() {
    const { ctx, w, h: H } = chart;
    chart.clear();
    const p0 = racers[0].player;
    if (!p0) return;
    const t1 = p0.simT, t0 = t1 - 90;
    const topH = Math.round(H * 0.6);
    const yMax = 4;
    const p = new FJ.Plot(ctx, { l: 34, t: 18, w: w - 40, h: topH - 18 }, { min: t0, max: t1 }, { min: 0, max: yMax });
    p.gridY([1, 2, 3, 4]); p.labelsY([0, 1, 2, 3, 4], v => v + '');
    ctx.font = FJ.font.mono(11); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Мбит/с: ёмкость сети и выбор каждого алгоритма', 34, 12);
    p.clip(c => {
      // ёмкость сети — силуэт
      const cap = [];
      for (let t = Math.max(0, t0); t <= t1; t += 0.5) cap.push([t, Math.min(yMax * 1.5, FJ.net.capacityAt(trace, t) / 1e6)]);
      if (cap.length) { p.area(cap.concat([[t1, cap[cap.length - 1][1]]]), FJ.alpha('#bfc0c3', 0.14), 0); p.step(cap, FJ.alpha('#bfc0c3', 0.7), 1, t1); }
      // выбранные битрейты
      racers.forEach((rc, j) => {
        const pl = rc.player; c.strokeStyle = ACOL[rc.id]; c.lineWidth = 2;
        const off = (j - 1.5) * 1.6;
        c.beginPath(); let first = true;
        for (const s of pl.segLog) {
          if (s.t1 < t0) continue;
          const y = p.sy(asset.ladder[s.r].kbps / 1000) + off;
          if (first) { c.moveTo(p.sx(Math.max(t0, s.t0)), y); first = false; } else c.lineTo(p.sx(s.t0), y);
          c.lineTo(p.sx(s.t1), y);
        }
        c.stroke();
      });
    });
    // буферы
    const maxB = Math.max(...racers.map(rc => rc.player.maxBuffer));
    const q = new FJ.Plot(ctx, { l: 34, t: topH + 22, w: w - 40, h: H - topH - 40 }, p.x, { min: 0, max: maxB });
    q.gridY([0, maxB / 2, maxB]); q.labelsY([0, maxB], v => v + ' с');
    ctx.font = FJ.font.mono(11); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('буфер, с', 34, topH + 16);
    q.clip(c => {
      racers.forEach(rc => {
        const hs = rc.player.hist.filter(x => x.t >= t0 - 1).map(x => [x.t, x.buf]);
        q.line(hs, ACOL[rc.id], 1.6);
        for (const x of rc.player.hist) if (x.st === 'stalled' && x.t >= t0) { c.fillStyle = FJ.colors.red; c.fillRect(q.sx(x.t), q.sy(0) - 5, Math.max(1.5, q.sx(x.t + 0.25) - q.sx(x.t)), 5); }
      });
    });
    q.labelsX(FJ.ticks(Math.max(0, t0), t1, 6).filter(v => v >= t0), v => fmt.clock(v), { size: 10 });
  }

  /* ---------- табло ---------- */
  function paintBoard(tbody) {
    const rows = racers.map(rc => ({ rc, p: rc.player, qoe: rc.player.qoe })).sort((a, b) => b.qoe - a.qoe);
    tbody.innerHTML = rows.map((r, i) => {
      const s = r.p.stats, a = FJ.abr.ALGOS[r.rc.id];
      return `<tr><td class="${i === 0 ? 'is-lead' : ''}"><span class="dot" style="--c:${ACOL[r.rc.id]}"></span>${a.name}</td>
        <td class="r mono">${fmt.kbps(r.p.avgKbps * 1000)}</td>
        <td class="r mono">${s.stalls} · ${fmt.sec(s.stallTime, 1)}</td>
        <td class="r mono">${s.switches}</td>
        <td class="r mono">${s.ttff != null ? fmt.sec(s.ttff, 2) : '—'}</td>
        <td class="r mono">${fmt.bytes(s.bytes)}</td>
        <td class="r mono ${i === 0 ? 'is-lead' : ''}">${fmt.num(r.qoe, 2)}</td></tr>`;
    }).join('');
  }

  function paintHud(rc) {
    const pl = rc.player, r = pl.rShown;
    const st = { handshake: 'СТАРТ', buffering: 'БУФЕРИЗАЦИЯ', playing: 'ПРОСМОТР', stalled: 'ОСТАНОВКА' }[pl.state];
    rc.stateTag.textContent = st;
    rc.stall.classList.toggle('is-on', pl.state === 'stalled' || (pl.state !== 'playing' && pl.stats.ttff == null));
    rc.tally.className = 'tally ' + (pl.state === 'playing' ? 'on' : 'warn');
    if (r >= 0) rc.rungTag.innerHTML = `<span class="chip" style="--c:var(--q${r + 1})"></span>${asset.ladder[r].name}`;
    rc.bufI.style.setProperty('--v', Math.min(1, pl.buffer / pl.maxBuffer).toFixed(3));
    rc.umdTxt.textContent = pl.stats.stalls ? `${pl.stats.stalls} ${fmt.plural(pl.stats.stalls, 'остановка', 'остановки', 'остановок')}` : 'без остановок';
    rc.umdV.textContent = 'буфер ' + fmt.sec(pl.buffer, 1);
  }

  const figEl = $('#fig-race');
  FJ.figure({
    id: 'race', el: figEl,
    mount,
    start() { },
    stop() { racers.forEach(rc => rc.player && rc.player.suspend()); },
    frame(dt) {
      if (!racers.length || !racers[0].player) return;
      if (running) for (const rc of racers) rc.player.update(dt);
      for (const rc of racers) rc.player.render();
      paintChart();
      tBrain += dt; tBoard += dt;
      if (tBrain > 0.1) { tBrain = 0; racers.forEach(rc => { paintBrain(rc); paintHud(rc); }); }
      if (tBoard > 0.5) { tBoard = 0; paintBoard(figEl.__tbody); }
    },
  });
})(window);

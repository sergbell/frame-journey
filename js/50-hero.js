/* =====================================================================
   50-hero — «Сеанс»: плеер, телеметрия, график сети и буфера,
   мультивьюер из пяти контрольных мониторов.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { fmt, $ } = FJ;
  const asset = FJ.asset;

  let player = null, views = [], mvCanvases = [], chart = null, scrub = null;
  let domT = 0, netId = 'wifi', algoId = 'bola';
  const NETS = [['fiber', 'Оптика'], ['wifi', 'Wi‑Fi'], ['lte', '4G'], ['hsdpa', '3G'], ['tunnel', 'Метро']];

  function makePlayer() {
    if (player) player.destroy();
    player = new FJ.Player({
      asset, canvas: $('#heroCanvas'), name: 'Сеанс',
      device: FJ.devices.tv, trace: FJ.net.makeTrace(netId, 11), algoId, startAt: 6, startBw: 3e6,
    });
    FJ.heroPlayer = player;
  }

  function mount() {
    FJ.seg($('#heroNet'), NETS.map(([v, label]) => ({ v, label })), netId, v => {
      netId = v; player.setTrace(FJ.net.makeTrace(v, 11));
    }, { small: true });
    FJ.seg($('#heroAlgo'), Object.entries(FJ.abr.ALGOS).map(([v, a]) => ({ v, label: a.name })), algoId, v => {
      algoId = v; player.swapAlgo(v);
    }, { small: true });

    // мультивьюер
    const mv = $('#heroMv');
    asset.ladder.forEach((rg, r) => {
      const cv = FJ.h('canvas', { width: Math.min(rg.w, 480), height: Math.min(rg.h, 270), 'aria-label': 'Качество ' + rg.name });
      const tally = FJ.h('span', { class: 'tally' });
      const val = FJ.h('span', { class: 'v', text: FJ.fmt.kbps(rg.kbps * 1000) });
      const mon = FJ.h('div', { class: 'monitor' }, [
        FJ.h('div', { class: 'monitor__screen' }, [cv]),
        FJ.h('div', { class: 'umd' }, [tally, FJ.h('span', { class: 'chip', style: { '--c': `var(--q${r + 1})` } }), FJ.h('span', { class: 'lbl', text: rg.name }), val]),
      ]);
      mv.append(mon);
      mvCanvases.push({ cv, ctx: cv.getContext('2d'), tally, val });
      views.push(new FJ.RungView(asset, r));
    });

    chart = FJ.canvas($('#heroChart'));
    scrub = FJ.canvas($('#heroScrub canvas'));
    makePlayer();
    asset.on('done', () => {
      player.refreshLadder();
      mvCanvases.forEach((m, r) => { m.val.textContent = fmt.kbps(asset.avgKbps(r) * 1000); });
    });
  }

  /* ---------- графики ---------- */
  function drawChart() {
    const { ctx, w, h } = chart;
    chart.clear();
    const hist = player.hist;
    if (hist.length < 2) return;
    const t1 = player.simT, t0 = t1 - 60;
    const topH = Math.round(h * 0.62), gap = 18;
    const yMax = 4;
    const p = new FJ.Plot(ctx, { l: 30, t: 14, w: w - 34, h: topH - 14 }, { min: t0, max: t1 }, { min: 0, max: yMax });
    p.gridY([1, 2, 3, 4]);
    p.labelsY([2, 4], v => v + '');
    ctx.save(); ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('Мбит/с · последние 60 с', 30, 9); ctx.restore();
    p.clip(c => {
      // ёмкость сети
      const cap = hist.filter(x => x.t >= t0 - 1).map(x => [x.t, Math.min(yMax * 1.2, x.cap / 1e6)]);
      p.step(cap, FJ.colors.blue, 1.5);
      // оценка
      const est = hist.filter(x => x.t >= t0 - 1 && x.est).map(x => [x.t, Math.min(yMax * 1.2, x.est / 1e6)]);
      p.line(est, FJ.alpha(FJ.colors.violet, 0.9), 1.2, [3, 3]);
      // качество по сегментам (цвет ступени)
      for (const s of player.segLog) {
        if (s.t1 < t0) continue;
        const k = asset.ladder[s.r].kbps / 1000;
        c.strokeStyle = FJ.colors.q[s.r]; c.lineWidth = 3;
        c.beginPath(); c.moveTo(p.sx(Math.max(t0, s.t0)), p.sy(k)); c.lineTo(p.sx(s.t1), p.sy(k)); c.stroke();
      }
      // остановки
      for (const x of hist) if (x.st === 'stalled' && x.t >= t0) { c.fillStyle = FJ.alpha(FJ.colors.red, 0.28); c.fillRect(p.sx(x.t), p.r.t, Math.max(1, p.sx(x.t + 0.25) - p.sx(x.t)), p.r.h); }
    });
    // буфер
    const bMax = player.maxBuffer;
    const q = new FJ.Plot(ctx, { l: 30, t: topH + gap, w: w - 34, h: h - topH - gap - 2 }, p.x, { min: 0, max: bMax });
    q.gridY([bMax]);
    q.labelsY([0, bMax], v => v + ' с');
    q.clip(() => q.area(hist.filter(x => x.t >= t0 - 1).map(x => [x.t, x.buf]), FJ.alpha(FJ.colors.amber, 0.55), 0));
  }

  function drawScrub() {
    const { ctx, w, h } = scrub;
    scrub.clear();
    const film = FJ.film, D = film.DUR;
    const y = 8, bh = h - 14;
    // планы
    film.shots.forEach((s, k) => {
      const x0 = s.from / D * w, x1 = s.to / D * w;
      ctx.fillStyle = s.service ? '#1d1e21' : (k % 2 ? '#26272b' : '#2c2d31');
      ctx.fillRect(x0, y, x1 - x0 - 1, bh);
    });
    // загруженные сегменты текущего круга: цвет ступени
    const loopStart = Math.floor(player.playhead / D) * D;
    for (const [K, r] of player.loadedR) {
      const t0 = K * asset.segDur - loopStart;
      if (t0 < 0 || t0 >= D) continue;
      ctx.fillStyle = FJ.alpha(FJ.colors.q[r], 0.85);
      ctx.fillRect(t0 / D * w, y + bh - 4, asset.segDur / D * w - 1, 4);
    }
    // буфер
    const ph = player.playhead - loopStart;
    ctx.fillStyle = FJ.alpha(FJ.colors.amber, 0.25);
    ctx.fillRect(ph / D * w, y, Math.min(player.buffer, D - ph) / D * w, bh - 5);
    // плейхед
    ctx.fillStyle = FJ.colors.red;
    ctx.fillRect(ph / D * w - 1, 0, 2, h);
    // метка плана
    const i = Math.floor(ph * film.FPS) % film.FRAMES;
    const shot = film.shotAt(i);
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('0:00', 2, h - 10 < y + bh ? y + bh + 1 : h - 10);
    void shot;
  }

  /* ---------- DOM-телеметрия (8 раз в секунду) ---------- */
  function paintDom() {
    const p = player, st = p.stats;
    const r = p.rShown;
    const film = FJ.film;
    const I = Math.floor(p.playhead * film.FPS);
    const i = ((I % film.FRAMES) + film.FRAMES) % film.FRAMES;
    const shot = film.shotAt(i);
    $('#heroTc').textContent = fmt.tc(i, film.FPS);
    $('#heroShot').textContent = shot.service ? shot.name : shot.name;
    const stateTxt = { handshake: 'СТАРТ', buffering: 'БУФЕРИЗАЦИЯ', playing: 'ПРОСМОТР', stalled: 'ОСТАНОВКА' }[p.state] || p.state;
    $('#heroState').textContent = asset.mode === 'pending' ? 'КОДИРУЕМ' : stateTxt;
    $('#heroTally').className = 'tally ' + (p.state === 'playing' ? 'on' : 'warn');
    $('#heroStall').classList.toggle('is-on', p.state === 'stalled' || (p.state !== 'playing' && p.stats.ttff == null));
    if (r >= 0) {
      const rg = asset.ladder[r];
      $('#heroRung').innerHTML = `<span class="chip" style="--c:var(--q${r + 1})"></span>${rg.name} · ${fmt.kbps(rg.kbps * 1000)}`;
      $('#kvRung').textContent = `${rg.name} · ${rg.w}×${rg.h}`;
      const K = Math.floor(p.playhead / asset.segDur);
      const k = ((K % asset.segCount) + asset.segCount) % asset.segCount;
      const seg = asset.segs[r][k];
      $('#kvBitrate').textContent = seg && seg.ready ? fmt.kbps(seg.bytes * 8 / asset.segDur) : '—';
      $('#heroUmd').textContent = `${FJ.abr.ALGOS[p.algoId].name} · сегмент ${k + 1}/${asset.segCount}`;
    }
    const est = p.algo.est ? p.algo.est.estimate() : (p.algo.brain && p.algo.brain.robust);
    $('#kvEst').textContent = est ? fmt.rate(est) : '—';
    $('#kvCap').textContent = fmt.rate(FJ.net.capacityAt(p.trace, p.simT));
    $('#kvBuf').textContent = fmt.sec(p.buffer, 1) + ' из ' + p.maxBuffer;
    $('#kvBufMeter').style.setProperty('--v', Math.min(1, p.buffer / p.maxBuffer).toFixed(3));
    $('#kvTtff').textContent = st.ttff != null ? fmt.sec(st.ttff, 2) : '—';
    $('#kvStalls').textContent = st.stalls + ' · ' + fmt.sec(st.stallTime, 1);
    $('#kvBytes').textContent = fmt.bytes(st.bytes);
    $('#kvCodec').textContent = asset.mode === 'model' ? 'модель' : (asset.codec || '—');
    mvCanvases.forEach((m, rr) => { m.tally.className = 'tally' + (rr === r ? ' on' : ''); });
  }

  const fig = FJ.figure({
    id: 'hero', el: $('#fig-hero'),
    mount,
    start() { },
    stop() { if (player) player.suspend(); views.forEach(v => v.suspend()); },
    frame(dt) {
      if (!player) return;
      player.update(dt);
      player.render();
      const I = Math.floor(player.playhead * FJ.film.FPS);
      if (player.stats.ttff != null) views.forEach((v, r) => { const m = mvCanvases[r]; v.draw(m.ctx, m.cv.width, m.cv.height, I); });
      drawChart();
      drawScrub();
      domT += dt;
      if (domT > 0.12) { domT = 0; paintDom(); }
    },
  });
  void fig;
})(window);

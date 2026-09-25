/* =====================================================================
   52-shots — глава «Планы и ферма»: детектор склеек на живом сигнале,
   тепловая карта фермы кодирования и стоимость каждого плана.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const film = FJ.film, asset = FJ.asset;

  let diffCv, heatCv, costCv, stats, verdict, replayT = null, hover = -1;

  /* Детектор: пик разности выше порога и локальный максимум */
  function detect() {
    const d = asset.diff, N = film.FRAMES, cuts = [];
    for (let i = 1; i < N - 1; i++) {
      const lo = Math.max(1, i - 12), hi = Math.min(N - 1, i + 12);
      const win = [];
      for (let k = lo; k <= hi; k++) if (k !== i) win.push(d[k]);
      win.sort((a, b) => a - b);
      const med = win[win.length >> 1] || 0;
      if (d[i] > 0.06 && d[i] > 5 * med + 0.01 && d[i] >= d[i - 1] && d[i] >= d[i + 1]) cuts.push(i);
    }
    return cuts;
  }
  function truth() { return film.shots.slice(1).map(s => s.f0); }

  function mount(el) {
    FJ.addStyle(`
      .sh-diff { height: 230px; } .sh-heat { height: 210px; } .sh-cost { height: 220px; }
    `);
    $('#shotsText').innerHTML = `
      <p>Мастер никто не&nbsp;кодирует целиком одним процессом. Его режут на&nbsp;куски и&nbsp;раздают ферме: так быстрее и&nbsp;так можно подобрать настройки под каждый кусок. В&nbsp;2015 году Netflix писал, что параллельное кодирование сократило обработку тайтла с&nbsp;дней до&nbsp;нескольких часов${FJ.cite('nf-scale')}. В&nbsp;платформе Cosmos одно кодирование режется на&nbsp;31 кусок, их кодируют 31 параллельная функция, и&nbsp;всё занимает 8 минут${FJ.cite('nf-cosmos')}.</p>
      <p>Режут по&nbsp;склейкам. Внутри плана соседние кадры похожи, на&nbsp;склейке картинка меняется целиком. Серия «Очень странных дел» распадается примерно на&nbsp;900 планов, в&nbsp;среднем по&nbsp;4 секунды${FJ.cite('nf-shots')}. Простейший детектор сравнивает яркость соседних кадров и&nbsp;ловит всплески.</p>
      <p>Справа он работает на&nbsp;нашем фильме: график&nbsp;— средняя разница яркости соседних кадров, посчитанная фермой при кодировании. Затемнение в&nbsp;конце он не&nbsp;видит: фейд меняет кадр понемногу, и&nbsp;всплеска нет. Настоящие детекторы учитывают и&nbsp;это.</p>
      <p>Ниже&nbsp;— сама ферма: пять кодировщиков WebCodecs работали параллельно, по&nbsp;одному на&nbsp;качество. Каждая клетка&nbsp;— 2‑секундный сегмент, яркость клетки&nbsp;— его вес. Видно, что одна и&nbsp;та&nbsp;же лесенка тратит на&nbsp;разные планы в&nbsp;десятки раз разные деньги.</p>`;

    const diffHost = h('div', { class: 'fig__canvas sh-diff', role: 'img', 'aria-label': 'Разница соседних кадров по всему фильму, найденные и настоящие склейки' });
    verdict = h('p', { class: 'caption' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, [h('span', { class: 'ctl-label', text: 'Детектор склеек' }),
        h('div', { class: 'legend' }, [h('span', null, [h('i', { style: { '--c': '#bfc0c3' } }), '|ΔY| соседних кадров']), h('span', null, [h('i', { class: 'dot', style: { '--c': '#ffb02e' } }), 'найдено']), h('span', null, [h('i', { class: 'box', style: { '--c': '#6fb3ff' } }), 'настоящая склейка'])])]),
      diffHost, verdict]));
    diffCv = FJ.canvas(diffHost, { onResize: () => paintDiff() });
    diffHost.addEventListener('pointermove', e => { const r = diffHost.getBoundingClientRect(); hover = Math.floor((e.clientX - r.left - 36) / (r.width - 44) * film.FRAMES); paintDiff(); });
    diffHost.addEventListener('pointerleave', () => { hover = -1; paintDiff(); });

    const heatHost = h('div', { class: 'fig__canvas sh-heat', role: 'img', 'aria-label': 'Тепловая карта фермы: качество × сегмент' });
    stats = h('div', { class: 'stat-row' });
    const replay = h('button', { class: 'btn', type: 'button', onclick: () => { replayT = 0; } }, ['Повторить прогон']);
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, [h('span', { class: 'ctl-label', text: 'Ферма: 5 качеств × 32 сегмента' }), replay]),
      heatHost]), stats);
    heatCv = FJ.canvas(heatHost, { onResize: () => paintHeat() });

    const costHost = h('div', { class: 'fig__canvas sh-cost', role: 'img', 'aria-label': 'Средний битрейт каждого плана в качестве 540p' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [h('span', { class: 'ctl-label', text: 'Сколько стоит план в 540p при целевых 1400 кбит/с (VBR)' }), costHost]));
    costCv = FJ.canvas(costHost, { onResize: () => paintCost() });

    asset.on('progress', () => { if (fig.active) { paintHeat(); } });
    asset.on('done', () => { paintAll(); });
  }

  function paintAll() { paintDiff(); paintHeat(); paintCost(); paintStats(); }

  function paintDiff() {
    if (!diffCv) return;
    const { ctx, w, h: H } = diffCv;
    diffCv.clear();
    const N = film.FRAMES;
    const p = new FJ.Plot(ctx, { l: 36, t: 34, w: w - 44, h: H - 60 }, { min: 0, max: N }, { min: 0, max: 0.5 });
    p.gridY([0.1, 0.2, 0.3, 0.4, 0.5]); p.labelsY([0, 0.25, 0.5], v => fmt.num(v, 2));
    p.labelsX([0, 24 * 16, 24 * 32, 24 * 48], v => fmt.clock(v / 24), { size: 10 });
    // планы подложкой
    film.shots.forEach((s, k) => {
      ctx.fillStyle = k % 2 ? 'rgba(255,255,255,.025)' : 'rgba(255,255,255,0)';
      ctx.fillRect(p.sx(s.f0), p.r.t, p.sx(s.f1) - p.sx(s.f0), p.r.h);
    });
    const d = asset.diff;
    const pts = [];
    for (let i = 1; i < N; i++) pts.push([i, Math.min(0.5, d[i])]);
    p.area(pts, FJ.alpha('#bfc0c3', 0.35), 0);
    p.line(pts, '#d8d7d2', 1);
    // настоящие склейки и подписи
    ctx.font = FJ.font.mono(10); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (const s of film.shots) {
      if (s.f0 > 0) { ctx.fillStyle = '#6fb3ff'; ctx.fillRect(p.sx(s.f0) - 1, p.r.t - 8, 2, 8); }
    }
    let lastX = -99;
    film.shots.forEach(s => {
      const x = p.sx(s.f0) + 2;
      const lab = s.name.split(' ')[0].split(',')[0];
      if (x - lastX < 46 || x + ctx.measureText(lab).width > w - 2) return;
      ctx.fillStyle = FJ.colors.muted; ctx.fillText(lab, x, p.r.t - 12);
      lastX = x;
    });
    if (asset.allReady || asset.mode === 'model') {
      const cuts = detect(), tr = truth();
      for (const c of cuts) p.dot(c, Math.min(0.5, d[c]), 4, '#ffb02e', '#000');
      const hit = tr.filter(t => cuts.some(c => Math.abs(c - t) <= 1));
      const fp = cuts.filter(c => !tr.some(t => Math.abs(c - t) <= 1));
      const missed = tr.filter(t => !cuts.some(c => Math.abs(c - t) <= 1)).map(t => film.shotAt(t).name);
      verdict.innerHTML = `Найдено ${hit.length} из&nbsp;${tr.length} границ, ложных срабатываний: ${fp.length}. Пропущены: ${missed.length ? missed.map(m => '«' + m + '»').join(', ') : 'нет'}. Порог: всплеск выше 0,06 и&nbsp;в&nbsp;5 раз выше медианы соседних 24 кадров.`;
    } else verdict.textContent = 'Сигнал появится по мере кодирования.';
    if (hover >= 0 && hover < N) {
      ctx.strokeStyle = FJ.alpha(FJ.colors.text, 0.5); ctx.beginPath(); ctx.moveTo(p.sx(hover) + 0.5, p.r.t); ctx.lineTo(p.sx(hover) + 0.5, p.r.t + p.r.h); ctx.stroke();
      const txt = `${fmt.tc(hover, 24)} · ${film.shotAt(hover).name} · |ΔY| ${fmt.num(d[hover] || 0, 3)}`;
      ctx.font = FJ.font.mono(11); const tw = ctx.measureText(txt).width + 12;
      const x = Math.min(p.sx(hover) + 8, w - tw - 4);
      ctx.fillStyle = 'rgba(12,13,14,.92)'; ctx.fillRect(x, p.r.t + 6, tw, 20);
      ctx.fillStyle = FJ.colors.text; ctx.fillText(txt, x + 6, p.r.t + 20);
    }
  }

  function paintHeat() {
    if (!heatCv) return;
    const { ctx, w, h: H } = heatCv;
    heatCv.clear();
    const R = asset.ladder.length, K = asset.segCount;
    const l = 52, t = 22, cw = (w - l - 6) / K, ch = (H - t - 26) / R;
    const rowMax = [];
    for (let r = 0; r < R; r++) { let m = 1; for (let k = 0; k < K; k++) m = Math.max(m, asset.segs[r][k].bytes); rowMax.push(m); }
    const tNow = replayT;
    ctx.font = FJ.font.mono(10); ctx.textBaseline = 'middle';
    for (let r = 0; r < R; r++) {
      ctx.fillStyle = FJ.colors.q[r]; ctx.textAlign = 'right';
      ctx.fillText(asset.ladder[r].name, l - 8, t + (r + 0.5) * ch);
      for (let k = 0; k < K; k++) {
        const s = asset.segs[r][k];
        let on = s.ready;
        if (tNow != null && s.doneAt != null) on = s.doneAt <= tNow;
        const x = l + k * cw, y = t + r * ch;
        ctx.fillStyle = '#101113'; ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        if (on) {
          const v = s.bytes / rowMax[r];
          ctx.fillStyle = FJ.alpha(FJ.colors.q[r], 0.08 + 0.92 * Math.pow(v, 0.75));
          ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        }
      }
    }
    // шкала времени и границы планов
    ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let k = 0; k < K; k += 4) ctx.fillText(fmt.clock(k * 2), l + k * cw, t + R * ch + 6);
    film.shots.forEach(s => { if (!s.f0) return; const x = l + s.from / 2 * cw; ctx.fillStyle = FJ.alpha('#6fb3ff', 0.8); ctx.fillRect(x - 0.5, t - 8, 1, 6); });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = FJ.colors.muted;
    ctx.fillText('яркость клетки — размер сегмента относительно самого тяжёлого в строке', l, 12);
  }

  function paintStats() {
    if (!stats || !asset.finishedAt) return;
    const secs = (asset.finishedAt - asset.startedAt) / 1000;
    let bytes = 0; for (let r = 0; r < asset.ladder.length; r++) for (const s of asset.segs[r]) bytes += s.bytes;
    stats.innerHTML = `
      <div class="stat"><b>${fmt.sec(secs, 1)}</b><span>ушло на&nbsp;весь фильм в&nbsp;пяти качествах</span></div>
      <div class="stat"><b>${fmt.int(asset.farmFps)}</b><span>кадров фильма в&nbsp;секунду, ×${fmt.num(asset.farmFps / 24, 1)} реального времени</span></div>
      <div class="stat"><b>${fmt.int(film.FRAMES * asset.ladder.length)}</b><span>кадров закодировано${asset.mode === 'model' ? ' (модель)' : ''}</span></div>
      <div class="stat"><b>${fmt.bytes(bytes)}</b><span>весь ассет: 5 качеств × 64&nbsp;с</span></div>`;
  }

  function paintCost() {
    if (!costCv) return;
    const { ctx, w, h: H } = costCv;
    costCv.clear();
    const r = 1;
    const rows = film.shots.map(s => {
      let b = 0, n = 0;
      for (let i = s.f0; i < s.f1; i++) { const f = asset.frames[r][i]; if (f) { b += f.size; n++; } }
      return { s, kbps: n ? b * 8 / (n / 24) / 1000 : 0 };
    });
    const mx = Math.max(2000, ...rows.map(x => x.kbps)) * 1.08;
    const p = new FJ.Plot(ctx, { l: 150, t: 8, w: w - 160, h: H - 30 }, { min: 0, max: mx }, { min: 0, max: rows.length });
    const xt = FJ.ticks(0, mx, 4);
    p.gridX(xt); p.labelsX(xt, v => fmt.int(v), { size: 10 });
    rows.forEach((x, k) => {
      const y = p.r.t + k / rows.length * p.r.h + 2, bh = p.r.h / rows.length - 4;
      ctx.fillStyle = x.s.service ? '#3a3c41' : FJ.alpha(FJ.colors.q2, 0.75);
      ctx.fillRect(p.r.l, y, Math.max(1, p.sx(x.kbps) - p.r.l), bh);
      ctx.font = FJ.font.text(12); ctx.fillStyle = x.s.service ? FJ.colors.muted : FJ.colors['text-2']; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(x.s.name, p.r.l - 8, y + bh / 2);
      ctx.font = FJ.font.mono(10); ctx.textAlign = 'left'; ctx.fillStyle = FJ.colors.text;
      if (x.kbps > 0) ctx.fillText(fmt.int(x.kbps), p.sx(x.kbps) + 5, y + bh / 2);
    });
    ctx.strokeStyle = FJ.alpha(FJ.colors.q2, 0.9); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(p.sx(1400), p.r.t); ctx.lineTo(p.sx(1400), p.r.t + p.r.h); ctx.stroke(); ctx.setLineDash([]);
  }

  const fig = FJ.figure({
    id: 'shots', el: $('#fig-shots'),
    mount,
    start() { paintAll(); },
    frame(dt) {
      if (replayT != null) {
        replayT += dt * 1000;
        paintHeat();
        const end = (asset.finishedAt - asset.startedAt) || 1;
        if (replayT > end + 300) { replayT = null; paintHeat(); }
      }
    },
  });
})(window);

/* =====================================================================
   51-master — глава «Мастер»: исходный кадр, осциллограф и вектороскоп,
   лупа Y/Cb/Cr с субдискретизацией 4:2:0 и калькулятор несжатого видео.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const film = FJ.film;

  // BT.709: Y' = .2126R' + .7152G' + .0722B'; Cb = (B'−Y')/1.8556; Cr = (R'−Y')/1.5748
  const KR = 0.2126, KG = 0.7152, KB = 0.0722;
  const SW = 320, SH = 180;                 // разрешение, на котором считаем приборы

  let mon, wave, vec, loupe, calcChart;
  let src, srcX, small, smallX;
  let playing = true, i = film.shots[3].f0 + 30, acc = 0, sel = null;
  let loupePt = { x: 0.6, y: 0.6 };
  let waveImg = null, vecImg = null;
  let frameData = null;

  const RESES = [['SD', 720, 576], ['HD', 1280, 720], ['Full HD', 1920, 1080], ['UHD 4K', 3840, 2160], ['8K', 7680, 4320]];
  const FPSS = [24, 25, 50, 60, 120];
  const DEPTHS = [8, 10, 12];
  const CHROMA = [['4:4:4', 3], ['4:2:2', 2], ['4:2:0', 1.5]];
  let calc = { res: 3, fps: 1, depth: 1, chroma: 2 };

  function mount(el) {
    FJ.addStyle(`
      .ms-top { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
      .ms-scopes { display: grid; gap: 10px; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); }
      @media (max-width: 560px) { .ms-scopes { grid-template-columns: minmax(0, 1fr); } }
      .ms-scope { background: #0b0c0d; border: 1px solid #2b2d31; border-radius: 4px; padding: 6px; display: grid; gap: 4px; }
      .ms-scope .fig__canvas { aspect-ratio: 16 / 10; }
      .ms-vec .fig__canvas { aspect-ratio: 1 / 1; max-height: 240px; margin-inline: auto; width: 100%; }
      .ms-loupe { display: grid; gap: 8px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
      @media (max-width: 560px) { .ms-loupe { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      .ms-loupe figure { margin: 0; display: grid; gap: 4px; }
      .ms-loupe canvas { width: 100%; aspect-ratio: 1; image-rendering: pixelated; border-radius: 2px; background: #000; display: block; }
      .ms-loupe figcaption { font: 500 12px/1.3 var(--f-mono); color: var(--text-2); }
      .ms-mon { cursor: crosshair; touch-action: none; }
      .ms-calc { height: 250px; }
    `);
    $('#masterText').innerHTML = `
      <p>Путь начинается с&nbsp;мастера&nbsp;— файла, который сдаёт студия. Он огромный. Несжатое UHD‑видео при 60&nbsp;кадрах в&nbsp;секунду, 10&nbsp;битах и&nbsp;4:2:0 занимает около 7,5&nbsp;Гбит/с. Мастер для Netflix&nbsp;— пакет IMF с&nbsp;JPEG 2000 до&nbsp;800&nbsp;Мбит/с для UHD до&nbsp;30&nbsp;кадров/с${FJ.cite('nf-imf')}. ProRes 422 HQ в&nbsp;2160p24&nbsp;— 707&nbsp;Мбит/с, то&nbsp;есть 318&nbsp;ГБ в&nbsp;час${FJ.cite('prores')}. До&nbsp;зрителя доезжает в&nbsp;сотни раз меньше.</p>
      <p>Первое сжатие делает не&nbsp;кодек, а&nbsp;физиология. Глаз замечает детали яркости лучше, чем детали цвета. Поэтому кадр переводят в&nbsp;Y′CbCr и&nbsp;хранят цвет вчетверо реже: в&nbsp;4:2:0 один отсчёт Cb и&nbsp;один Cr приходятся на&nbsp;квадрат 2×2 пикселя. Наведите лупу на&nbsp;кадр справа&nbsp;— видно, как цвет расползается блоками, а&nbsp;яркость остаётся резкой.</p>
      <p>Наш фильм начинается как настоящий мастер: полосы SMPTE${FJ.cite('smpte-rp219')}, слейт с&nbsp;паспортом и&nbsp;отсчёт, где «2» стоит на&nbsp;одном кадре ровно за&nbsp;две секунды до&nbsp;первого кадра действия${FJ.cite('leader')}. Полосы нужны для приборов: на&nbsp;вектороскопе шесть цветов ложатся точно в&nbsp;свои мишени. Netflix, кстати, полосы и&nbsp;слейты в&nbsp;поставке запрещает: только секунда чёрного в&nbsp;начале и&nbsp;в&nbsp;конце${FJ.cite('nf-imf')}.</p>
      <p>Цвета ступеней в&nbsp;этой странице&nbsp;— те&nbsp;же полосы: белая, жёлтая, голубая, зелёная, пурпурная. Они идут по&nbsp;убыванию яркости, как и&nbsp;качество от&nbsp;720p к&nbsp;180p.</p>`;

    // монитор мастера
    const monHost = h('div', { class: 'monitor__screen ms-mon' });
    const cv = h('canvas', { width: 1280, height: 720, 'aria-label': 'Исходный кадр мастера' });
    monHost.append(cv);
    const tag = h('span', { class: 'tag', text: '' });
    monHost.append(h('div', { class: 'hud' }, [h('div', { class: 'hud__tl' }, [h('span', { class: 'tag', text: 'МАСТЕР · без сжатия' }), tag])]));
    const umdTc = h('span', { class: 'v', style: { fontWeight: '500', color: 'var(--text)' } });
    const monitor = h('div', { class: 'monitor' }, [monHost, h('div', { class: 'umd' }, [h('span', { class: 'tally on' }), h('span', { class: 'lbl', text: 'ВОСЕМЬ ПЛАНОВ' }), h('span', { text: '1280×720 · 24p · 8 бит · Rec. 709' }), umdTc])]);
    mon = { cv, ctx: cv.getContext('2d'), tag, umdTc, host: monHost };
    el.append(monitor);

    // выбор плана и пауза
    const bar = h('div', { class: 'row' });
    const shotSeg = h('div');
    const play = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Пауза' });
    play.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2"/></svg>';
    play.addEventListener('click', () => {
      playing = !playing;
      play.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
      play.innerHTML = playing ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2"/></svg>' : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>';
    });
    bar.append(play, shotSeg);
    el.append(bar);
    const items = [{ v: 0, label: 'Полосы' }, { v: 3, label: 'Рассвет' }, { v: 4, label: 'Мультфильм' }, { v: 5, label: 'Дождь' }, { v: 7, label: 'Крупный план' }, { v: 8, label: 'Архив' }, { v: 9, label: 'Огонь' }];
    sel = FJ.seg(shotSeg, items, 3, v => { i = film.shots[v].f0 + (v === 0 ? 6 : 30); drawFrame(); }, { small: true });

    // приборы
    const waveHost = h('div', { class: 'fig__canvas', role: 'img', 'aria-label': 'Осциллограф яркости' });
    const vecHost = h('div', { class: 'fig__canvas', role: 'img', 'aria-label': 'Вектороскоп' });
    el.append(h('div', { class: 'ms-scopes' }, [
      h('div', { class: 'ms-scope' }, [h('span', { class: 'ctl-label', text: 'Осциллограф: яркость по столбцам' }), waveHost]),
      h('div', { class: 'ms-scope ms-vec' }, [h('span', { class: 'ctl-label', text: 'Вектороскоп: Cb × Cr' }), vecHost]),
    ]));
    wave = FJ.canvas(waveHost, { maxDpr: 2 });
    vec = FJ.canvas(vecHost, { maxDpr: 2 });

    // лупа
    const lp = h('div', { class: 'ms-loupe' });
    const tiles = ['RGB', 'Y′ — яркость', 'Cb — 4:2:0', 'Cr — 4:2:0'].map(t => {
      const c = h('canvas', { width: 16, height: 16 });
      const cap = h('figcaption', { text: t });
      lp.append(h('figure', null, [c, cap]));
      return { c, x: c.getContext('2d'), cap };
    });
    const vals = h('p', { class: 'caption mono', style: { fontFamily: 'var(--f-mono)' } });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '8px' } }, [h('span', { class: 'ctl-label', text: 'Лупа 16 × 16 пикселей' }), h('span', { class: 'caption', text: 'наведите или проведите по кадру' })]), lp, vals]));
    loupe = { tiles, vals };
    const move = e => {
      const r = monHost.getBoundingClientRect();
      loupePt = { x: FJ.math.clamp((e.clientX - r.left) / r.width, 0, 1), y: FJ.math.clamp((e.clientY - r.top) / r.height, 0, 1) };
      drawLoupe(); drawMonitor();
    };
    monHost.addEventListener('pointermove', move);
    monHost.addEventListener('pointerdown', e => { monHost.setPointerCapture(e.pointerId); move(e); });

    // калькулятор
    el.append(h('h3', { text: 'Сколько весит несжатое видео', style: { marginTop: '8px' } }));
    const cBar = h('div', { class: 'stack', style: { gap: '10px' } });
    const mk = (label, arr, key, lab) => {
      const host = h('div');
      cBar.append(h('div', { class: 'row' }, [h('span', { class: 'ctl-label', text: label, style: { minWidth: '92px' } }), host]));
      FJ.seg(host, arr.map((a, k) => ({ v: k, label: lab(a) })), calc[key], v => { calc[key] = v; drawCalc(); }, { small: true });
    };
    mk('Разрешение', RESES, 'res', a => a[0]);
    mk('Кадров/с', FPSS, 'fps', a => String(a));
    mk('Разрядность', DEPTHS, 'depth', a => a + ' бит');
    mk('Цвет', CHROMA, 'chroma', a => a[0]);
    el.append(cBar);
    const statRow = h('div', { class: 'stat-row' });
    el.append(statRow);
    const cHost = h('div', { class: 'fig__canvas ms-calc', role: 'img', 'aria-label': 'Битрейты от несжатого видео до ступеней лесенки, логарифмическая шкала' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [cHost]));
    calcChart = { c: FJ.canvas(cHost, { onResize: () => drawCalc() }), stat: statRow };

    // рабочие буферы
    src = document.createElement('canvas'); src.width = 1280; src.height = 720; srcX = src.getContext('2d', { willReadFrequently: true });
    small = document.createElement('canvas'); small.width = SW; small.height = SH; smallX = small.getContext('2d', { willReadFrequently: true });
    film.init().then(() => { drawFrame(); drawCalc(); });
  }

  /* ---------- кадр и приборы ---------- */
  function drawFrame() {
    srcX.drawImage(film.render(i), 0, 0);
    smallX.drawImage(src, 0, 0, SW, SH);
    frameData = smallX.getImageData(0, 0, SW, SH).data;
    drawMonitor(); drawWave(); drawVec(); drawLoupe();
    const shot = film.shotAt(i);
    mon.tag.textContent = shot.name;
    mon.umdTc.textContent = fmt.tc(i, film.FPS);
    if (sel) { const idx = [0, 3, 4, 5, 7, 8, 9].indexOf(shot.index); if (idx >= 0) sel.set(shot.index); }
  }
  function drawMonitor() {
    const c = mon.ctx;
    c.drawImage(src, 0, 0);
    const x = loupePt.x * 1280, y = loupePt.y * 720;
    c.strokeStyle = '#ffb02e'; c.lineWidth = 3;
    c.strokeRect(Math.round(x - 24), Math.round(y - 24), 48, 48);
  }
  function drawWave() {
    const { ctx, w, h: H } = wave;
    const cw = Math.max(1, Math.round(w * wave.dpr)), ch = Math.max(1, Math.round(H * wave.dpr));
    if (!waveImg || waveImg.width !== cw || waveImg.height !== ch) waveImg = new ImageData(cw, ch);
    const d = waveImg.data; d.fill(0);
    const acc = new Uint16Array(cw * ch);
    for (let yy = 0; yy < SH; yy++) for (let xx = 0; xx < SW; xx++) {
      const k = (yy * SW + xx) * 4;
      const Y = (KR * frameData[k] + KG * frameData[k + 1] + KB * frameData[k + 2]) / 255;
      const px = Math.floor(xx / SW * cw), py = Math.floor((1 - Y) * (ch - 1));
      acc[py * cw + px]++;
    }
    for (let p = 0; p < acc.length; p++) {
      if (!acc[p]) continue;
      const v = Math.min(255, 40 + acc[p] * 28);
      d[p * 4] = v * 0.93; d[p * 4 + 1] = v; d[p * 4 + 2] = v * 0.86; d[p * 4 + 3] = 255;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c0d'; ctx.fillRect(0, 0, cw, ch);
    ctx.putImageData(waveImg, 0, 0);
    ctx.setTransform(wave.dpr, 0, 0, wave.dpr, 0, 0);
    // шкала 0–100 %
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left';
    for (const v of [0, 25, 50, 75, 100]) {
      const y = (1 - v / 100) * (H - 1);
      ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
      ctx.fillText(v + '%', 3, Math.min(H - 3, Math.max(10, y - 2)));
    }
  }
  function drawVec() {
    const { ctx, w, h: H } = vec;
    const cw = Math.round(w * vec.dpr), ch = Math.round(H * vec.dpr);
    if (!vecImg || vecImg.width !== cw || vecImg.height !== ch) vecImg = new ImageData(cw, ch);
    const d = vecImg.data; d.fill(0);
    const R = Math.min(cw, ch) * 0.46, cx = cw / 2, cy = ch / 2;
    const acc = new Uint16Array(cw * ch);
    for (let k = 0; k < frameData.length; k += 8) {
      const r = frameData[k] / 255, g = frameData[k + 1] / 255, b = frameData[k + 2] / 255;
      const Y = KR * r + KG * g + KB * b;
      const cb = (b - Y) / 1.8556, cr = (r - Y) / 1.5748;          // −0,5…0,5
      const px = Math.round(cx + cb * 2 * R), py = Math.round(cy - cr * 2 * R);
      if (px >= 0 && py >= 0 && px < cw && py < ch) acc[py * cw + px]++;
    }
    for (let p = 0; p < acc.length; p++) {
      if (!acc[p]) continue;
      const v = Math.min(255, 60 + acc[p] * 36);
      d[p * 4] = v; d[p * 4 + 1] = v * 0.97; d[p * 4 + 2] = v * 0.9; d[p * 4 + 3] = 255;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c0d'; ctx.fillRect(0, 0, cw, ch);
    ctx.putImageData(vecImg, 0, 0);
    ctx.setTransform(vec.dpr, 0, 0, vec.dpr, 0, 0);
    // графика: круг, линия телесных тонов, мишени 75 % полос
    const r = R / vec.dpr, x0 = w / 2, y0 = H / 2;
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x0, y0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0 - r, y0); ctx.lineTo(x0 + r, y0); ctx.moveTo(x0, y0 - r); ctx.lineTo(x0, y0 + r); ctx.stroke();
    // линия телесных тонов (~123° от оси B−Y)
    const a = 123 * Math.PI / 180;
    ctx.strokeStyle = 'rgba(255,176,46,.45)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.cos(a) * r, y0 - Math.sin(a) * r); ctx.stroke(); ctx.setLineDash([]);
    const T = [['R', [0.75, 0, 0]], ['Mg', [0.75, 0, 0.75]], ['B', [0, 0, 0.75]], ['Cy', [0, 0.75, 0.75]], ['G', [0, 0.75, 0]], ['Yl', [0.75, 0.75, 0]]];
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors['text-2']; ctx.textAlign = 'center';
    for (const [n, [rr, gg, bb]] of T) {
      const Y = KR * rr + KG * gg + KB * bb;
      const cb = (bb - Y) / 1.8556, cr = (rr - Y) / 1.5748;
      const x = x0 + cb * 2 * r, y = y0 - cr * 2 * r;
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.strokeRect(x - 5, y - 5, 10, 10);
      ctx.fillText(n, x + (x - x0) * 0.16, y + (y - y0) * 0.16 + 3);
    }
  }
  function drawLoupe() {
    if (!frameData) return;
    const N = 16;
    const x0 = Math.max(0, Math.min(1280 - N, Math.round(loupePt.x * 1280 - N / 2))) & ~1;
    const y0 = Math.max(0, Math.min(720 - N, Math.round(loupePt.y * 720 - N / 2))) & ~1;
    const px = srcX.getImageData(x0, y0, N, N).data;
    const [tR, tY, tB, tC] = loupe.tiles;
    const imR = tR.x.createImageData(N, N), imY = tY.x.createImageData(N, N), imB = tB.x.createImageData(N, N), imC = tC.x.createImageData(N, N);
    const Ys = new Float32Array(N * N), Cbs = new Float32Array(N * N), Crs = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) {
      const r = px[k * 4] / 255, g = px[k * 4 + 1] / 255, b = px[k * 4 + 2] / 255;
      const Y = KR * r + KG * g + KB * b;
      Ys[k] = Y; Cbs[k] = (b - Y) / 1.8556; Crs[k] = (r - Y) / 1.5748;
    }
    for (let yy = 0; yy < N; yy++) for (let xx = 0; xx < N; xx++) {
      const k = yy * N + xx;
      // 4:2:0 — среднее по квадрату 2×2
      const bx = xx & ~1, by = yy & ~1;
      const q = [by * N + bx, by * N + bx + 1, (by + 1) * N + bx, (by + 1) * N + bx + 1];
      const cb = (Cbs[q[0]] + Cbs[q[1]] + Cbs[q[2]] + Cbs[q[3]]) / 4, cr = (Crs[q[0]] + Crs[q[1]] + Crs[q[2]] + Crs[q[3]]) / 4;
      const o = k * 4;
      imR.data[o] = px[o]; imR.data[o + 1] = px[o + 1]; imR.data[o + 2] = px[o + 2]; imR.data[o + 3] = 255;
      const yv = Math.round(Ys[k] * 255); imY.data[o] = imY.data[o + 1] = imY.data[o + 2] = yv; imY.data[o + 3] = 255;
      // Cb/Cr показываем как цвет при средней яркости
      const show = (Y, cbv, crv, im) => {
        const R = Y + 1.5748 * crv, B = Y + 1.8556 * cbv, G = (Y - KR * R - KB * B) / KG;
        im.data[o] = FJ.math.clamp(R, 0, 1) * 255; im.data[o + 1] = FJ.math.clamp(G, 0, 1) * 255; im.data[o + 2] = FJ.math.clamp(B, 0, 1) * 255; im.data[o + 3] = 255;
      };
      show(0.5, cb * 1.6, 0, imB); show(0.5, 0, cr * 1.6, imC);
    }
    tR.x.putImageData(imR, 0, 0); tY.x.putImageData(imY, 0, 0); tB.x.putImageData(imB, 0, 0); tC.x.putImageData(imC, 0, 0);
    const c = (N / 2) * N + N / 2;
    const Y8 = Math.round(16 + 219 * Ys[c]), Cb8 = Math.round(128 + 224 * Cbs[c]), Cr8 = Math.round(128 + 224 * Crs[c]);
    loupe.vals.innerHTML = `пиксель (${x0 + N / 2}, ${y0 + N / 2}): R′G′B′ = ${px[c * 4]}, ${px[c * 4 + 1]}, ${px[c * 4 + 2]} → Y′CbCr (BT.709, 8&nbsp;бит, ограниченный диапазон) = ${Y8}, ${Cb8}, ${Cr8}. В&nbsp;4:2:0 на&nbsp;16×16 пикселей приходится 256 отсчётов яркости и&nbsp;по&nbsp;64 отсчёта Cb и&nbsp;Cr: вместо 768 чисел&nbsp;— 384.`;
  }

  /* ---------- калькулятор ---------- */
  function drawCalc() {
    if (!calcChart) return;
    const [nm, W, H] = RESES[calc.res], fps = FPSS[calc.fps], bits = DEPTHS[calc.depth], [cn, spp] = CHROMA[calc.chroma];
    const raw = W * H * spp * bits * fps;                  // бит/с
    const hour = raw / 8 * 3600, film2 = hour * 2;
    const ours = 2400e3;
    calcChart.stat.innerHTML = `
      <div class="stat"><b>${fmt.rate(raw)}</b><span>несжатое ${nm}, ${fps}&nbsp;к/с, ${bits}&nbsp;бит, ${cn}</span></div>
      <div class="stat"><b>${fmt.bytes(hour)}</b><span>один час</span></div>
      <div class="stat"><b>${fmt.bytes(film2)}</b><span>двухчасовой фильм</span></div>
      <div class="stat"><b>${fmt.int(raw / (W >= 3840 ? 16.8e6 : W >= 1920 ? 7.8e6 : ours))}×</b><span>во&nbsp;столько раз меньше верхняя ступень ${W >= 3840 ? '4K HEVC у Apple (16,8 Мбит/с)' : W >= 1920 ? '1080p H.264 у Apple (7,8 Мбит/с)' : 'нашей лесенки (2,4 Мбит/с)'}</span></div>`;
    const { ctx, w, h: Hh } = calcChart.c;
    calcChart.c.clear();
    const rows = [
      ['Несжатое, ваши настройки', raw, FJ.colors.red],
      ['ProRes 4444 XQ · 2160p24', 1591e6, FJ.colors['text-2']],
      ['IMF JPEG 2000 · UHD, макс.', 800e6, FJ.colors['text-2']],
      ['ProRes 422 HQ · 2160p24', 707e6, FJ.colors['text-2']],
      ['Apple: верх 4K HEVC', 16.8e6, FJ.colors.q1],
      ['Apple: верх 1080p H.264', 7.8e6, FJ.colors.q1],
      ['Наш верх · 720p', 2.4e6, FJ.colors.q1],
      ['Наш низ · 180p', 0.2e6, FJ.colors.q5],
    ];
    ctx.font = FJ.font.text(12);
    const L = Math.ceil(Math.max(...rows.map(r => ctx.measureText(r[0]).width))) + 16;
    const p = new FJ.Plot(ctx, { l: Math.min(L, w * 0.45), t: 6, w: w - Math.min(L, w * 0.45) - 12, h: Hh - 30 }, { min: 1e5, max: 1e11, log: true }, { min: 0, max: rows.length });
    const xt = [1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11];
    p.gridX(xt); p.labelsX(xt, v => fmt.rate(v).replace(/,0(?=\u00a0)/, ''), { size: 10 });
    rows.forEach(([label, v, col], k) => {
      const y = p.r.t + (k + 0.18) / rows.length * p.r.h, bh = p.r.h / rows.length * 0.64;
      ctx.fillStyle = FJ.alpha(col, k === 0 ? 0.9 : 0.55);
      ctx.fillRect(p.r.l, y, Math.max(1, p.sx(v) - p.r.l), bh);
      ctx.font = FJ.font.text(12); ctx.fillStyle = FJ.colors['text-2']; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(label, p.r.l - 8, y + bh / 2);
      ctx.textAlign = 'left'; ctx.fillStyle = FJ.colors.text; ctx.font = FJ.font.mono(11);
      const tx = p.sx(v) + 6;
      if (tx < p.r.l + p.r.w - 60) ctx.fillText(fmt.rate(v), tx, y + bh / 2);
    });
  }

  FJ.figure({
    id: 'master', el: $('#fig-master'),
    mount,
    frame(dt) {
      if (!playing || !src) return;
      acc += dt;
      if (acc >= 1 / 12) {   // приборы — 12 раз в секунду, фильм идёт в реальном времени
        i += Math.round(acc * film.FPS); acc = 0;
        if (i >= film.FRAMES) i = 0;
        drawFrame();
      }
    },
  });
})(window);

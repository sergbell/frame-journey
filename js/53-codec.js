/* =====================================================================
   53-codec — глава «Кодек»: сейсмограф размеров кадров, выравнивание
   ключевых кадров между качествами, «что передаёт кодек» и проверка
   кодеков, которые умеет это устройство.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const film = FJ.film, asset = FJ.asset;

  let seisCv, gopCv, diffA, diffB, probeBody, hdrNote;
  let rung = 1, hover = -1, dI = film.shots[5].f0 + 20, dAcc = 0, prevLuma = null;

  function mount(el) {
    FJ.addStyle(`
      .cd-seis { height: 250px; } .cd-gop { height: 150px; }
      .cd-diff { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      @media (max-width: 560px) { .cd-diff { grid-template-columns: minmax(0, 1fr); } }
      .cd-diff canvas { width: 100%; aspect-ratio: 16/9; display: block; background: #000; border-radius: 2px; }
      .cd-yes { color: var(--q4); } .cd-no { color: var(--muted); }
    `);
    FJ.sources['tizen-spec'] = ['Samsung Smart TV: спецификации медиа и веб-движка по годам', 'https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html'];
    FJ.sources['webos-spec'] = ['LG webOS TV: веб-движок, DRM и форматы по версиям', 'https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine'];
    $('#codecText').innerHTML = `
      <p>Кодек почти ничего не&nbsp;передаёт заново. Ключевой кадр (I, у&nbsp;нас IDR) описан полностью и&nbsp;весит много. Остальные кадры (P) ссылаются на&nbsp;предыдущие: «этот блок&nbsp;— как тот, только сдвинутый на&nbsp;3 пикселя вправо», плюс небольшая поправка. Неподвижный фон почти бесплатен, дождь и&nbsp;зерно&nbsp;— дороги.</p>
      <p>Ключевой кадр стоит в&nbsp;начале каждого 2‑секундного сегмента во&nbsp;всех пяти качествах, на&nbsp;одних и&nbsp;тех&nbsp;же местах. Только так плеер может переключиться на&nbsp;любой границе сегмента и&nbsp;начать просмотр с&nbsp;любого места. Apple требует IDR в&nbsp;начале каждого сегмента и&nbsp;советует ставить их каждые 2&nbsp;секунды${FJ.cite('apple-auth')}.</p>
      <p>Режим VBR даёт сложным планам больше бит, простым меньше. Поэтому «битрейт ступени»&nbsp;— это среднее, а&nbsp;отдельные сегменты бывают втрое тяжелее. В&nbsp;манифесте HLS для этого два числа: AVERAGE-BANDWIDTH и&nbsp;пиковый BANDWIDTH${FJ.cite('hls')}.</p>
      <p>Каждое поколение кодеков экономит заметную долю бит. HEVC требует на&nbsp;59&nbsp;% меньше бит, чем H.264, при равном субъективном качестве (PSNR показывает лишь 44&nbsp;%)${FJ.cite('hevc-tan')}. VVC экономит 46–50&nbsp;% против HEVC${FJ.cite('vvc')}. AV1 в&nbsp;Netflix обслуживает около 30&nbsp;% просмотров и&nbsp;экономит треть трафика против AVC и&nbsp;HEVC${FJ.cite('nf-av1')}, а&nbsp;AV2 вышел в&nbsp;июне 2026 года с&nbsp;заявкой на&nbsp;~30&nbsp;% к&nbsp;AV1${FJ.cite('av2')}. Но&nbsp;для кинотеатра решает не&nbsp;кодек, а&nbsp;парк устройств. AV1 декодируют телевизоры Samsung с&nbsp;2020–2021 годов и&nbsp;LG с&nbsp;webOS&nbsp;5 (2020)${FJ.cite('tizen-spec')}${FJ.cite('webos-spec')}. Всё, что старше, получит H.264 или HEVC.</p>`;

    // сейсмограф
    const seisHost = h('div', { class: 'fig__canvas cd-seis', role: 'img', 'aria-label': 'Размеры всех кадров фильма в выбранном качестве' });
    const rungSeg = h('div');
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, [h('span', { class: 'ctl-label', text: 'Сейсмограф: размер каждого кадра' }), rungSeg]),
      seisHost,
      h('div', { class: 'legend', style: { marginTop: '6px' } }, [h('span', null, [h('i', { class: 'box', style: { '--c': '#ff4d3d' } }), 'ключевой кадр (IDR)']), h('span', null, [h('i', { class: 'box', style: { '--c': '#bfc0c3' } }), 'P‑кадр']), h('span', null, [h('i', { style: { '--c': '#6fb3ff' } }), 'склейка'])])]));
    seisCv = FJ.canvas(seisHost, { onResize: () => paintSeis() });
    FJ.seg(rungSeg, asset.ladder.map((rg, r) => ({ v: r, label: rg.name, chip: `var(--q${r + 1})` })), rung, v => { rung = v; paintSeis(); }, { small: true });
    seisHost.addEventListener('pointermove', e => { const r = seisHost.getBoundingClientRect(); hover = Math.floor((e.clientX - r.left - 44) / (r.width - 52) * film.FRAMES); paintSeis(); });
    seisHost.addEventListener('pointerleave', () => { hover = -1; paintSeis(); });

    // выравнивание GOP
    const gopHost = h('div', { class: 'fig__canvas cd-gop', role: 'img', 'aria-label': 'Ключевые кадры всех качеств совпадают по времени' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [h('span', { class: 'ctl-label', text: 'Первые 6 секунд: ключевые кадры всех качеств на одних местах' }), gopHost]));
    gopCv = FJ.canvas(gopHost, { onResize: () => paintGop() });

    // что передаёт кодек
    const a = h('canvas', { width: 480, height: 270 }), b = h('canvas', { width: 480, height: 270 });
    diffA = a.getContext('2d', { willReadFrequently: true }); diffB = b.getContext('2d');
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [
      h('span', { class: 'ctl-label', text: 'Кадр и его отличие от предыдущего' }),
      h('div', { class: 'cd-diff', style: { marginTop: '8px' } }, [a, b]),
      h('p', { class: 'caption', style: { marginTop: '6px' }, html: 'Справа яркость = |кадр − предыдущий кадр| × 4. Чёрное почти бесплатно. Кодек ещё и&nbsp;сдвигает блоки по&nbsp;векторам движения, поэтому реальная поправка меньше, чем эта грубая разность.' }),
    ]));

    // пробы устройства
    const tbl = h('table', { class: 'tbl' });
    tbl.innerHTML = '<thead><tr><th>Кодек и формат</th><th>Декодирует</th><th>Плавно</th><th>Экономно</th><th>Кодирует (WebCodecs)</th></tr></thead>';
    probeBody = h('tbody'); tbl.append(probeBody);
    hdrNote = h('p', { class: 'caption' });
    el.append(h('h3', { text: 'Что умеет это устройство' }), h('div', { class: 'tbl-wrap' }, [tbl]), hdrNote);
    probe();
    asset.on('done', () => { paintSeis(); paintGop(); });
  }

  /* ---------- сейсмограф ---------- */
  function paintSeis() {
    if (!seisCv) return;
    const { ctx, w, h: H } = seisCv;
    seisCv.clear();
    const N = film.FRAMES, fr = asset.frames[rung];
    let mx = 1;
    for (let i = 0; i < N; i++) if (fr[i]) mx = Math.max(mx, fr[i].size);
    const p = new FJ.Plot(ctx, { l: 44, t: 26, w: w - 52, h: H - 50 }, { min: 0, max: N }, { min: 100, max: mx * 1.3, log: true });
    const yt = [100, 1000, 10000, 100000, 1000000].filter(v => v <= mx * 1.3);
    p.gridY(yt); p.labelsY(yt, v => fmt.bytes(v).replace(/,0(?= )/, ''));
    p.labelsX([0, 384, 768, 1152], v => fmt.clock(v / 24), { size: 10 });
    const bw = p.r.w / N;
    for (let i = 0; i < N; i++) {
      const f = fr[i]; if (!f) continue;
      const x = p.r.l + i * bw, y = p.sy(Math.max(100, f.size));
      ctx.fillStyle = f.key ? '#ff4d3d' : (i === hover ? '#ffffff' : 'rgba(215,214,209,.62)');
      ctx.fillRect(x, y, Math.max(1, bw * (f.key ? 1.6 : 0.9)), p.r.t + p.r.h - y);
    }
    ctx.font = FJ.font.mono(10); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    let lastX = -99;
    film.shots.forEach(s => {
      if (s.f0) { ctx.fillStyle = FJ.alpha('#6fb3ff', 0.9); ctx.fillRect(p.sx(s.f0) - 0.5, p.r.t - 6, 1, p.r.h + 6); }
      const x = p.sx(s.f0) + 3;
      const lab = s.name.split(/[ ,]/)[0];
      if (x - lastX > 48 && x + ctx.measureText(lab).width < w - 2) { ctx.fillStyle = FJ.colors.muted; ctx.fillText(lab, x, p.r.t - 10); lastX = x; }
    });
    if (hover >= 0 && hover < N && fr[hover]) {
      const f = fr[hover];
      const txt = `${fmt.tc(hover, 24)} · ${f.key ? 'IDR' : 'P'} · ${fmt.bytes(f.size)} · ${film.shotAt(hover).name}`;
      ctx.font = FJ.font.mono(11); const tw = ctx.measureText(txt).width + 12;
      const x = Math.min(p.sx(hover) + 8, w - tw - 4);
      ctx.fillStyle = 'rgba(12,13,14,.92)'; ctx.fillRect(x, p.r.t + 4, tw, 20);
      ctx.fillStyle = FJ.colors.text; ctx.fillText(txt, x + 6, p.r.t + 18);
    }
  }

  /* ---------- выравнивание GOP ---------- */
  function paintGop() {
    if (!gopCv) return;
    const { ctx, w, h: H } = gopCv;
    gopCv.clear();
    const F = 144, R = asset.ladder.length;
    const l = 52, t = 16, cw = (w - l - 8) / F, rh = (H - t - 22) / R;
    ctx.font = FJ.font.mono(10); ctx.textBaseline = 'middle';
    for (let r = 0; r < R; r++) {
      ctx.fillStyle = FJ.colors.q[r]; ctx.textAlign = 'right'; ctx.fillText(asset.ladder[r].name, l - 8, t + (r + 0.5) * rh);
      let mx = 1; for (let i = 0; i < F; i++) { const f = asset.frames[r][i]; if (f) mx = Math.max(mx, f.size); }
      for (let i = 0; i < F; i++) {
        const f = asset.frames[r][i]; if (!f) continue;
        const hh = Math.max(2, Math.sqrt(f.size / mx) * (rh - 4));
        ctx.fillStyle = f.key ? '#ff4d3d' : FJ.alpha(FJ.colors.q[r], 0.55);
        ctx.fillRect(l + i * cw, t + (r + 1) * rh - 2 - hh, Math.max(1, cw - 0.6), hh);
      }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = FJ.colors.muted;
    for (let k = 0; k <= 3; k++) {
      const x = l + k * 48 * cw;
      ctx.fillStyle = FJ.alpha('#ff4d3d', 0.35); ctx.fillRect(x, t - 4, 1, R * rh + 6);
      if (k < 3) { ctx.fillStyle = FJ.colors.muted; ctx.fillText('сегмент ' + (k + 1), x + 24 * cw, t + R * rh + 6); }
    }
  }

  /* ---------- «что передаёт кодек» ---------- */
  function paintDiff() {
    diffA.drawImage(film.render(dI), 0, 0, 480, 270);
    const cur = diffA.getImageData(0, 0, 480, 270);
    const out = diffB.createImageData(480, 270);
    const L = new Float32Array(480 * 270);
    for (let k = 0, j = 0; k < cur.data.length; k += 4, j++) L[j] = 0.2126 * cur.data[k] + 0.7152 * cur.data[k + 1] + 0.0722 * cur.data[k + 2];
    if (prevLuma) for (let j = 0; j < L.length; j++) {
      const v = Math.min(255, Math.abs(L[j] - prevLuma[j]) * 4);
      out.data[j * 4] = v; out.data[j * 4 + 1] = v * 0.93; out.data[j * 4 + 2] = v * 0.82; out.data[j * 4 + 3] = 255;
    }
    diffB.putImageData(out, 0, 0);
    prevLuma = L;
    diffB.font = FJ.font.mono(13); diffB.fillStyle = 'rgba(0,0,0,.6)'; diffB.fillRect(8, 8, 190, 22);
    diffB.fillStyle = '#fff'; diffB.fillText(film.shotAt(dI).name, 14, 24);
  }

  /* ---------- пробы кодеков ---------- */
  async function probe() {
    const rows = [
      ['H.264 High · 1080p', 'avc1.640028', 1920, 1080, 6e6, null],
      ['HEVC Main · 1080p', 'hvc1.1.6.L123.B0', 1920, 1080, 4e6, null],
      ['HEVC Main 10 · 4K HDR (PQ)', 'hvc1.2.4.L153.B0', 3840, 2160, 16e6, 'pq'],
      ['VP9 Profile 0 · 1080p', 'vp09.00.40.08', 1920, 1080, 4e6, null],
      ['VP9 Profile 2 · 4K HDR', 'vp09.02.51.10.01.09.16.09.00', 3840, 2160, 16e6, 'pq'],
      ['AV1 Main · 1080p', 'av01.0.08M.08', 1920, 1080, 3e6, null],
      ['AV1 Main 10 bit · 4K HDR', 'av01.0.12M.10.0.110.09.16.09.0', 3840, 2160, 12e6, 'pq'],
    ];
    const cell = v => v == null ? '<span class="cd-no">—</span>' : v ? '<span class="cd-yes">да</span>' : '<span class="cd-no">нет</span>';
    probeBody.innerHTML = rows.map(r => `<tr><td>${r[0]}<br><span class="muted mono" style="font-size:11.5px">${r[1]}</span></td><td>…</td><td>…</td><td>…</td><td>…</td></tr>`).join('');
    const out = [];
    for (const [name, codec, w, hh, br, tf] of rows) {
      let dec = null, smooth = null, eff = null, enc = null;
      try {
        if (navigator.mediaCapabilities) {
          const cfg = { type: 'media-source', video: { contentType: `video/mp4; codecs="${codec}"`, width: w, height: hh, bitrate: br, framerate: 24 } };
          if (tf) Object.assign(cfg.video, { transferFunction: tf, colorGamut: 'rec2020' });
          const r = await navigator.mediaCapabilities.decodingInfo(cfg);
          dec = r.supported; smooth = r.supported ? r.smooth : null; eff = r.supported ? r.powerEfficient : null;
        }
      } catch (e) { dec = false; }
      try {
        if (typeof VideoEncoder !== 'undefined') {
          const s = await VideoEncoder.isConfigSupported({ codec, width: Math.min(w, 1920), height: Math.min(hh, 1080), bitrate: br, framerate: 24 });
          enc = !!s.supported;
        }
      } catch (e) { enc = false; }
      out.push(`<tr><td>${name}<br><span class="muted mono" style="font-size:11.5px">${codec}</span></td><td>${cell(dec)}</td><td>${cell(smooth)}</td><td>${cell(eff)}</td><td>${cell(enc)}</td></tr>`);
    }
    probeBody.innerHTML = out.join('');
    const hdr = root.matchMedia && root.matchMedia('(dynamic-range: high)').matches;
    hdrNote.innerHTML = `Ответы дал сам браузер через MediaCapabilities и&nbsp;WebCodecs. «Плавно» и&nbsp;«экономно» обычно означают аппаратный декодер. Экран ${hdr ? '<strong>поддерживает</strong>' : 'не&nbsp;сообщает о&nbsp;поддержке'} HDR. Плееры кинотеатров делают такую проверку перед выбором манифеста: телевизору 2016 года AV1 не&nbsp;отдают.`;
  }

  FJ.figure({
    id: 'codec', el: $('#fig-codec'),
    mount,
    start() { paintSeis(); paintGop(); },
    frame(dt) {
      dAcc += dt;
      if (dAcc > 1 / 24) {
        dAcc = 0;
        dI += 1; if (dI >= film.FRAMES) { dI = 0; prevLuma = null; }
        paintDiff();
      }
    },
  });
})(window);

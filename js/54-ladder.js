/* =====================================================================
   54-ladder — глава «Лесенка»: настоящий эксперимент per-title/per-shot.
   Для каждого из восьми планов браузер кодирует 2-секундный отрывок в
   сетке «разрешение × QP», декодирует, считает PSNR по яркости после
   масштабирования к 1280×720 (на видеокарте), строит выпуклые оболочки
   и сравнивает три стратегии: фиксированная лесенка, per-title и
   per-shot с постоянным наклоном (как Dynamic Optimizer у Netflix).
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const film = FJ.film, asset = FJ.asset;

  const QPS = [22, 28, 34, 40];
  const VBR = [150, 350, 800, 1800];      // запасной режим, кбит/с
  const EX = 48;                           // отрывок: 48 кадров = один сегмент
  const CMP = 2;                           // сравниваем каждый второй кадр
  const RW = 1280, RH = 720;

  /* ------------------------------------------------------------------
     PSNR на видеокарте: эталонная яркость в слоях массива текстур,
     декодированный кадр растягивается билинейно до 1280×720.
     ------------------------------------------------------------------ */
  class PsnrGPU {
    constructor() {
      this.cv = document.createElement('canvas'); this.cv.width = 40; this.cv.height = 23;
      const gl = this.gl = this.cv.getContext('webgl2', { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) { this.ok = false; return; }
      this.ok = true;
      const vs = `#version 300 es
      void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
      const lumaFs = `#version 300 es
      precision highp float; uniform sampler2D uSrc; out vec4 o;
      void main(){ vec3 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb; o = vec4(dot(c, vec3(.2126,.7152,.0722)), 0., 0., 1.); }`;
      const mseFs = `#version 300 es
      precision highp float; precision highp sampler2DArray;
      uniform sampler2D uDec; uniform sampler2DArray uRef; uniform int uLayer; out vec4 o;
      void main(){
        ivec2 b = ivec2(gl_FragCoord.xy) * 32;
        float acc = 0.0, n = 0.0;
        for (int y = 0; y < 32; y++) {
          if (b.y + y >= ${RH}) break;
          for (int x = 0; x < 32; x++) {
            ivec2 p = b + ivec2(x, y);
            float r = texelFetch(uRef, ivec3(p, uLayer), 0).r * 255.0;
            vec3 d = texture(uDec, (vec2(p) + 0.5) / vec2(${RW}.0, ${RH}.0)).rgb * 255.0;
            float e = dot(d, vec3(.2126,.7152,.0722)) - r;
            acc += e * e; n += 1.0;
          }
        }
        o = vec4(acc, n, 0.0, 1.0);
      }`;
      const prog = (fs) => {
        const p = gl.createProgram();
        const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
        gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      this.pLuma = prog(lumaFs); this.pMse = prog(mseFs);
      this.tmp = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tmp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.dec = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.dec);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      this.layers = EX / CMP;
      this.ref = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ref);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, RW, RH, this.layers);
      this.fbRef = gl.createFramebuffer();
      this.out = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.out);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 40, 23);
      this.fbOut = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbOut);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out, 0);
      this.buf = new Float32Array(40 * 23 * 4);
    }
    /* Положить яркость эталонного кадра в слой */
    setRef(layer, canvas) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tmp);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbRef);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.ref, 0, layer);
      gl.viewport(0, 0, RW, RH);
      gl.useProgram(this.pLuma);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tmp);
      gl.uniform1i(gl.getUniformLocation(this.pLuma, 'uSrc'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    /* PSNR декодированного кадра против слоя, дБ */
    psnr(layer, frame) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dec);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ref);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbOut);
      gl.viewport(0, 0, 40, 23);
      gl.useProgram(this.pMse);
      gl.uniform1i(gl.getUniformLocation(this.pMse, 'uDec'), 0);
      gl.uniform1i(gl.getUniformLocation(this.pMse, 'uRef'), 1);
      gl.uniform1i(gl.getUniformLocation(this.pMse, 'uLayer'), layer);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 40, 23, gl.RGBA, gl.FLOAT, this.buf);
      let s = 0, n = 0;
      for (let i = 0; i < this.buf.length; i += 4) { s += this.buf[i]; n += this.buf[i + 1]; }
      const mse = s / Math.max(1, n);
      return mse < 1e-6 ? 60 : Math.min(60, 10 * Math.log10(255 * 255 / mse));
    }
  }

  /* ------------------------------------------------------------------
     Выпуклая оболочка (верхняя, в координатах битрейт — качество)
     ------------------------------------------------------------------ */
  function hull(points) {
    const pts = points.filter(p => isFinite(p.kbps) && isFinite(p.psnr)).slice().sort((a, b) => a.kbps - b.kbps || b.psnr - a.psnr);
    // Парето: качество должно расти с битрейтом
    const par = [];
    for (const p of pts) if (!par.length || p.psnr > par[par.length - 1].psnr) par.push(p);
    // верхняя выпуклая (вогнутая функция)
    const H = [];
    for (const p of par) {
      while (H.length >= 2) {
        const a = H[H.length - 2], b = H[H.length - 1];
        const cross = (b.kbps - a.kbps) * (p.psnr - a.psnr) - (b.psnr - a.psnr) * (p.kbps - a.kbps);
        if (cross >= 0) H.pop(); else break;
      }
      H.push(p);
    }
    return H;
  }
  /* Кусочно-линейная интерполяция качества по log(битрейта) вдоль кривой одного разрешения */
  function qAt(curve, kbps) {
    const c = curve.slice().sort((a, b) => a.kbps - b.kbps);
    if (!c.length) return NaN;
    if (kbps <= c[0].kbps) { if (c.length < 2) return c[0].psnr; const [a, b] = c; return a.psnr + (b.psnr - a.psnr) * (Math.log(kbps / a.kbps) / Math.log(b.kbps / a.kbps)); }
    for (let i = 1; i < c.length; i++) if (kbps <= c[i].kbps) { const a = c[i - 1], b = c[i]; return a.psnr + (b.psnr - a.psnr) * (Math.log(kbps / a.kbps) / Math.log(b.kbps / a.kbps)); }
    const a = c[c.length - 2] || c[0], b = c[c.length - 1];
    return c.length < 2 ? b.psnr : b.psnr + (b.psnr - a.psnr) * (Math.log(kbps / b.kbps) / Math.log(b.kbps / a.kbps)) * 0.5;
  }
  /* Битрейт, нужный кривой (по возрастанию), чтобы достичь качества q */
  function rateFor(curve, q) {
    if (curve.length && q <= curve[0].q) return -curve[0].r; // цель ниже всей кривой: хватает и самой низкой точки
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (q >= a.q && q <= b.q) { const t = (q - a.q) / (b.q - a.q || 1); return Math.exp(Math.log(a.r) + t * (Math.log(b.r) - Math.log(a.r))); }
    }
    return NaN;
  }

  /* ------------------------------------------------------------------
     Состояние эксперимента
     ------------------------------------------------------------------ */
  const S = {
    status: 'idle', mode: null, done: 0, total: 0, cur: '', t0: 0, t1: 0,
    res: film.eight.map(() => asset.ladder.map(() => [])),  // [shot][rung] = [{qp|kbpsTarget, kbps, psnr}]
    sel: 2,
  };

  async function supportsQuantizer() {
    if (typeof VideoEncoder === 'undefined') return false;
    try { const s = await VideoEncoder.isConfigSupported({ codec: asset.codec || 'avc1.64001f', width: 640, height: 360, framerate: 24, bitrateMode: 'quantizer', avc: { format: 'avc' } }); return !!(s && s.supported); }
    catch (e) { return false; }
  }

  async function run() {
    if (S.status === 'running') return;
    if (asset.mode !== 'webcodecs') { S.status = 'unsupported'; paintAll(); return; }
    const gpu = new PsnrGPU();
    if (!gpu.ok) { S.status = 'nogpu'; paintAll(); return; }
    S.status = 'running'; S.t0 = performance.now();
    S.mode = (await supportsQuantizer()) ? 'qp' : 'vbr';
    const knobs = S.mode === 'qp' ? QPS : VBR;
    S.res = film.eight.map(() => asset.ladder.map(() => []));
    S.total = film.eight.length * asset.ladder.length * knobs.length; S.done = 0;
    const cvs = asset.ladder.map(rg => { const c = document.createElement('canvas'); c.width = rg.w; c.height = rg.h; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; return { c, x }; });
    try {
      for (let s = 0; s < film.eight.length; s++) {
        const shot = film.eight[s];
        const i0 = shot.f0 + Math.max(0, Math.floor((shot.f1 - shot.f0 - EX) / 2));
        // эталон: яркость каждого второго кадра
        for (let f = 0; f < EX; f += CMP) { gpu.setRef(f / CMP, film.render(i0 + f)); }
        for (let r = 0; r < asset.ladder.length; r++) {
          const rg = asset.ladder[r];
          S.cur = `${shot.name} · ${rg.name}`;
          const outs = knobs.map(() => ({ chunks: [], bytes: 0, cfg: null }));
          const encs = knobs.map((k, j) => {
            const e = new VideoEncoder({
              output: (ch, meta) => { const d = new Uint8Array(ch.byteLength); ch.copyTo(d); outs[j].chunks.push({ type: ch.type, ts: ch.timestamp, data: d }); outs[j].bytes += d.byteLength; if (meta && meta.decoderConfig) outs[j].cfg = meta.decoderConfig; },
              error: e2 => { S.err = e2.message; },
            });
            const cfg = { codec: asset.codec, width: rg.w, height: rg.h, framerate: 24, avc: { format: 'avc' }, latencyMode: 'quality' };
            if (S.mode === 'qp') cfg.bitrateMode = 'quantizer'; else { cfg.bitrateMode = 'variable'; cfg.bitrate = k * 1000; }
            e.configure(cfg);
            return e;
          });
          for (let f = 0; f < EX; f++) {
            cvs[r].x.drawImage(film.render(i0 + f), 0, 0, rg.w, rg.h);
            const vf = new VideoFrame(cvs[r].c, { timestamp: Math.round(f * 1e6 / 24), duration: 41667 });
            encs.forEach((e, j) => e.encode(vf, S.mode === 'qp' ? { keyFrame: f === 0, avc: { quantizer: knobs[j] } } : { keyFrame: f === 0 }));
            vf.close();
            while (encs.some(e => e.encodeQueueSize > 4)) await FJ.sleep(1);
            if ((f & 7) === 7) await FJ.yield();
          }
          await Promise.all(encs.map(e => e.flush()));
          encs.forEach(e => e.close());
          if (S.err) throw new Error(S.err);
          // декодируем и меряем
          for (let j = 0; j < knobs.length; j++) {
            const o = outs[j];
            let sum = 0, n = 0;
            await new Promise((resolve, reject) => {
              const dec = new VideoDecoder({
                output: fr => {
                  const f = Math.round(fr.timestamp * 24 / 1e6);
                  if (f % CMP === 0) { sum += gpu.psnr(f / CMP, fr); n++; }
                  fr.close();
                },
                error: e3 => reject(e3),
              });
              dec.configure(o.cfg);
              for (const c of o.chunks) dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, data: c.data }));
              dec.flush().then(() => { dec.close(); resolve(); }, reject);
            });
            const kbps = o.bytes * 8 / (EX / 24) / 1000;
            S.res[s][r].push({ knob: knobs[j], kbps, psnr: n ? sum / n : NaN, r, s });
            S.done++;
            paintAll();
            await FJ.yield();
          }
        }
      }
      S.status = 'done'; S.t1 = performance.now();
    } catch (e) {
      S.status = 'error'; S.err = e.message;
    }
    paintAll();
  }

  /* ------------------------------------------------------------------
     Анализ: три стратегии
     ------------------------------------------------------------------ */
  function analyze() {
    if (S.status !== 'done') return null;
    // Архивную плёнку не усредняем: PSNR сравнивает зерно попиксельно, и оценка ломается
    const keep = film.eight.map((sh, k) => k).filter(k => film.eight[k].id !== 'archive');
    const all = keep.map(k => S.res[k]);
    const NS = all.length, NR = asset.ladder.length;
    const hullsAll = S.res.map(shotRes => hull([].concat(...shotRes)));
    const hulls = keep.map(k => hullsAll[k]);
    // Кривая фильма для каждого разрешения: один QP на весь фильм.
    // Так приближённо распределяет биты двухпроходный VBR: простым планам меньше, сложным больше.
    const titleByRes = [];
    for (let r = 0; r < NR; r++) {
      const c = [];
      for (let j = 0; j < all[0][r].length; j++) {
        let R = 0, Q = 0;
        for (let s = 0; s < NS; s++) { R += all[s][r][j].kbps; Q += all[s][r][j].psnr; }
        c.push({ kbps: R / NS, psnr: Q / NS, r });
      }
      titleByRes.push(c.sort((a, b) => a.kbps - b.kbps));
    }
    // Фиксированная лесенка: разрешение и средний битрейт ступени заданы заранее для всех фильмов
    const fixed = asset.ladder.map((rg, r) => ({ r: rg.kbps, q: qAt(titleByRes[r], rg.kbps), res: r })).sort((a, b) => a.r - b.r);
    // Per-title: оболочка кривых фильма по всем разрешениям
    const titleHull = hull([].concat(...titleByRes)).map(p => ({ r: p.kbps, q: p.psnr, res: p.r }));
    // Per-shot: каждый план берёт точку своей оболочки при одинаковом наклоне λ
    const shotCurve = [];
    for (let l = 60; l >= -60; l -= 0.25) {
      const lambda = Math.pow(10, l / 20);
      let R = 0, Q = 0;
      for (let s = 0; s < NS; s++) {
        let best = null, bv = -Infinity;
        for (const p of hulls[s]) { const v = p.psnr - lambda * p.kbps / 1000; if (v > bv) { bv = v; best = p; } }
        R += best.kbps; Q += best.psnr;
      }
      const pt = { r: R / NS, q: Q / NS };
      const lst = shotCurve[shotCurve.length - 1];
      if (!lst || Math.abs(lst.r - pt.r) > 1e-6) shotCurve.push(pt);
    }
    shotCurve.sort((a, b) => a.r - b.r);
    return { hulls: hullsAll, titleHull, titleByRes, fixed, shotCurve, keep };
  }

  /* ------------------------------------------------------------------
     Отрисовка
     ------------------------------------------------------------------ */
  let cvMain, cvSum, elStatus, elBar, elBtn, elThumbs, elTable, elBest, qSlider;
  const SHOT_COL = ['#ffb86b', '#7fe0a0', '#8fa8ff', '#e6d06a', '#f0a0c8', '#c8c4b8', '#ff8a5c', '#9fe6ff'];
  const X = { min: 40, max: 12000, log: true };

  function paintAll() { paintStatus(); paintMain(); paintSummary(); }

  function paintStatus() {
    if (!elStatus) return;
    const p = S.total ? S.done / S.total : 0;
    elBar.style.setProperty('--v', p.toFixed(3));
    const secs = S.t1 ? (S.t1 - S.t0) / 1000 : (performance.now() - S.t0) / 1000;
    const map = {
      idle: S.manual ? 'На этом устройстве эксперимент запускается кнопкой: около 160 кодирований займут от полуминуты.' : 'Эксперимент запустится, как только ферма закончит основной фильм.',
      running: `Кодируем и меряем: ${S.cur} · ${S.done} из ${S.total} кодирований`,
      done: `Готово: ${S.total} кодирований по ${EX} кадров и ${fmt.int(S.total * EX / CMP)} замеров PSNR за ${fmt.sec(secs, 1)} на этом устройстве. Режим: ${S.mode === 'qp' ? 'постоянный QP (как пробные кодирования у Netflix)' : 'VBR с целевыми битрейтами (QP-режим недоступен)'}.`,
      unsupported: 'WebCodecs недоступен: эксперимент нельзя провести в этом браузере.',
      nogpu: 'Нет WebGL2 с float-текстурами: PSNR посчитать нечем.',
      error: 'Эксперимент прервался: ' + (S.err || 'ошибка кодировщика') + '.',
    };
    elStatus.textContent = map[S.status] || '';
    elBtn.disabled = S.status === 'running';
    elBtn.lastChild.textContent = S.status === 'done' ? 'Повторить' : 'Запустить сейчас';
  }

  function paintMain() {
    if (!cvMain) return;
    const { ctx, w, h: H } = cvMain;
    cvMain.clear();
    const p = new FJ.Plot(ctx, { l: 40, t: 22, w: w - 50, h: H - 52 }, X, { min: 22, max: 56 });
    const xt = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    p.gridX(xt); p.gridY([25, 30, 35, 40, 45, 50, 55]);
    p.labelsX(xt, v => v >= 1000 ? (v / 1000) + 'M' : v + 'k', { size: 10 });
    p.labelsY([25, 30, 35, 40, 45, 50, 55], v => v + '');
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('битрейт, бит/с, логарифмическая шкала', p.r.l + p.r.w, p.r.t + p.r.h + 32);
    ctx.textAlign = 'left'; ctx.fillText('PSNR‑Y, дБ', p.r.l - 34, 12);
    const res = S.res;
    // оболочки всех планов тонко
    res.forEach((sr, s) => {
      if (s === S.sel) return;
      const hh = hull([].concat(...sr));
      if (hh.length > 1) p.line(hh.map(q => [q.kbps, q.psnr]), FJ.alpha(SHOT_COL[s], 0.35), 1);
    });
    // выбранный план: кривые разрешений и оболочка
    const sr = res[S.sel];
    sr.forEach((curve, r) => {
      const c = curve.slice().sort((a, b) => a.kbps - b.kbps);
      if (c.length > 1) p.line(c.map(q => [q.kbps, q.psnr]), FJ.alpha(FJ.colors.q[r], 0.8), 1.4);
      c.forEach(q => p.dot(q.kbps, q.psnr, 3.2, FJ.colors.q[r]));
    });
    const hh = hull([].concat(...sr));
    if (hh.length > 1) {
      p.line(hh.map(q => [q.kbps, q.psnr]), SHOT_COL[S.sel], 2.4);
      hh.forEach(q => p.dot(q.kbps, q.psnr, 5, 'transparent', SHOT_COL[S.sel]));
    }
    // подписи разрешений у последних точек
    ctx.font = FJ.font.mono(10); ctx.textAlign = 'left';
    sr.forEach((curve, r) => {
      if (!curve.length) return;
      const top = curve.reduce((a, b) => (b.kbps > a.kbps ? b : a));
      ctx.fillStyle = FJ.colors.q[r];
      ctx.fillText(asset.ladder[r].name, Math.min(p.sx(top.kbps) + 6, p.r.l + p.r.w - 30), p.sy(top.psnr) + 3);
    });
  }

  function paintSummary() {
    if (!cvSum) return;
    const { ctx, w, h: H } = cvSum;
    cvSum.clear();
    const A = analyze();
    const p = new FJ.Plot(ctx, { l: 40, t: 22, w: w - 50, h: H - 50 }, { min: 100, max: 5000, log: true }, { min: 26, max: 50 });
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('средний PSNR‑Y, дБ', p.r.l - 34, 12);
    ctx.textAlign = 'right'; ctx.fillText('средний битрейт фильма', p.r.l + p.r.w, p.r.t + p.r.h + 32);
    const xt = [100, 200, 500, 1000, 2000, 5000];
    p.gridX(xt); p.gridY([30, 35, 40, 45, 50]);
    p.labelsX(xt, v => v >= 1000 ? (v / 1000) + 'M' : v + 'k', { size: 10 });
    p.labelsY([30, 35, 40, 45, 50], v => v + '');
    if (!A) {
      ctx.font = FJ.font.text(13); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'center';
      ctx.fillText(S.status === 'running' ? 'считаем…' : 'здесь появится сравнение стратегий', p.r.l + p.r.w / 2, p.r.t + p.r.h / 2);
      elTable.innerHTML = ''; elBest.innerHTML = '';
      return;
    }
    p.clip(() => {
      p.line(A.fixed.map(q => [q.r, q.q]), '#8f9197', 2, [5, 4]);
      A.fixed.forEach(q => p.dot(q.r, q.q, 4, FJ.colors.q[q.res]));
      p.line(A.titleHull.map(q => [q.r, q.q]), '#6fb3ff', 2);
      p.line(A.shotCurve.map(q => [q.r, q.q]), '#ffb02e', 2.4);
    });
    // целевое качество
    const Q = qSlider ? qSlider.value : 38;
    ctx.strokeStyle = FJ.alpha(FJ.colors.text, 0.5); ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(p.r.l, p.sy(Q)); ctx.lineTo(p.r.l + p.r.w, p.sy(Q)); ctx.stroke(); ctx.setLineDash([]);
    const rf = rateFor(A.fixed, Q), rt = rateFor(A.titleHull, Q), rs = rateFor(A.shotCurve, Q);
    const kb = v => !isFinite(v) ? '<span class="muted">вне диапазона</span>' : v < 0 ? `≤&nbsp;${fmt.kbps(-v * 1000)}` : fmt.kbps(v * 1000);
    const rel = (v, base) => (isFinite(v) && isFinite(base) && v > 0 && base > 0) ? `<span class="${v < base ? 'amber' : 'muted'}">${v < base ? FJ.fmt.MINUS : '+'}${fmt.num(Math.abs(1 - v / base) * 100, 0)}&nbsp;%</span>` : '—';
    elTable.innerHTML = `
      <tr><td><i class="ld-sw" style="--c:#8f9197"></i>Фиксированная лесенка</td><td class="r mono">${kb(rf)}</td><td class="r mono">—</td><td class="r mono">—</td></tr>
      <tr><td><i class="ld-sw" style="--c:#6fb3ff"></i>Per-title: своя лесенка у&nbsp;фильма</td><td class="r mono">${kb(rt)}</td><td class="r mono">${rel(rt, rf)}</td><td class="r mono">—</td></tr>
      <tr><td><i class="ld-sw" style="--c:#ffb02e"></i>Per-shot: постоянный наклон</td><td class="r mono">${kb(rs)}</td><td class="r mono">${rel(rs, rf)}</td><td class="r mono">${rel(rs, rt)}</td></tr>`;
    // лучшее разрешение на оболочке плана при заданном битрейте
    const bestAt = (hh, k) => { let best = null; for (const q of hh) if (q.kbps <= k * 1.05 && (!best || q.psnr > best.psnr)) best = q; return best; };
    elBest.innerHTML = film.eight.map((shot, s) => {
      const hh = A.hulls[s];
      const b1 = bestAt(hh, 150), b2 = bestAt(hh, 800);
      const need = rateFor(hh.map(q => ({ r: q.kbps, q: q.psnr })), 38);
      const note = shot.id === 'archive' ? ' <span class="muted">· не усредняем</span>' : '';
      const cellR = b => b ? `<span style="color:var(--q${b.r + 1})">${asset.ladder[b.r].name}</span>` : '<span class="muted">—</span>';
      return `<tr><td><i class="ld-sw" style="--c:${SHOT_COL[s]}"></i>${shot.name}${note}</td><td class="mono">${cellR(b1)}</td><td class="mono">${cellR(b2)}</td><td class="r mono">${!isFinite(need) ? '<span class="muted">не достигает</span>' : need < 0 ? '≤&nbsp;' + fmt.kbps(-need * 1000) : fmt.kbps(need * 1000)}</td></tr>`;
    }).join('');
  }

  function mount(el) {
    FJ.addStyle(`
      .ld-thumbs { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 6px; }
      @media (max-width: 700px) { .ld-thumbs { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      .ld-thumb { appearance: none; border: 1px solid var(--line); background: var(--bezel); padding: 3px; border-radius: 3px; cursor: pointer; display: grid; gap: 3px; text-align: left; color: var(--text-2); font: 500 11.5px/1.25 var(--f-text); min-height: 40px; }
      .ld-thumb canvas { width: 100%; aspect-ratio: 16/9; display: block; border-radius: 1px; }
      .ld-thumb[aria-pressed="true"] { border-color: var(--c); color: var(--text); }
      .ld-thumb span { padding: 0 2px 2px; border-left: 3px solid var(--c); padding-left: 5px; }
      .ld-main { height: 360px; } .ld-sum { height: 260px; }
      .ld-sw { display: inline-block; width: 12px; height: 3px; background: var(--c); margin-right: 8px; vertical-align: 3px; }
    `);
    $('#ladderText').innerHTML = `
      <p>Лесенка&nbsp;— набор версий одного фильма: разрешение и&nbsp;битрейт каждой ступени. До 2015 года Netflix кодировал всё по&nbsp;одной фиксированной лесенке: от&nbsp;235&nbsp;кбит/с в&nbsp;320×240 до&nbsp;5800&nbsp;кбит/с в&nbsp;1080p${FJ.cite('nf-pertitle')}. Мультфильму столько не&nbsp;нужно, а&nbsp;зернистой драме&nbsp;— мало.</p>
      <p><strong>Per-title.</strong> Фильм пробно кодируют во&nbsp;многих разрешениях и&nbsp;с&nbsp;разным квантованием, а&nbsp;ступени берут с&nbsp;верхней границы облака точек&nbsp;— выпуклой оболочки. «Конь БоДжек» получил 1080p при 1540&nbsp;кбит/с, хотя фиксированная лесенка давала ему только 480p при 1750${FJ.cite('nf-pertitle')}. Разброс огромный: для VMAF ≈&nbsp;91 в&nbsp;1080p тестовому фильму Sparks нужно 12&nbsp;568&nbsp;кбит/с, а&nbsp;«БоДжеку»&nbsp;— 1673${FJ.cite('nf-movies')}.</p>
      <p><strong>Per-shot.</strong> Следующий шаг&nbsp;— своя оболочка у&nbsp;каждого плана и&nbsp;распределение бит с&nbsp;одинаковым наклоном «качество за&nbsp;бит». Dynamic Optimizer дал ещё 17&nbsp;% по&nbsp;VMAF и&nbsp;22,5&nbsp;% по&nbsp;PSNR против лучшего фиксированного QP${FJ.cite('nf-dynopt')}, а&nbsp;для 4K верхняя ступень в&nbsp;среднем упала с&nbsp;16 до&nbsp;8&nbsp;Мбит/с при −65&nbsp;% ребуферизаций${FJ.cite('nf-4k')}.</p>
      <p>Справа этот эксперимент идёт по‑настоящему: браузер кодирует каждый из&nbsp;восьми планов в&nbsp;сетке «пять разрешений × четыре QP», декодирует и&nbsp;меряет качество. Мы считаем PSNR по&nbsp;яркости, растягивая каждое разрешение до&nbsp;1280×720, как делают перед подсчётом VMAF. PSNR грубее глаза: в&nbsp;продакшне смотрят VMAF, а&nbsp;в&nbsp;2026 году вышел VMAF v1 с&nbsp;моделями под расстояние до&nbsp;экрана и&nbsp;детектором бандинга${FJ.cite('nf-vmaf')}${FJ.cite('nf-vmafv1')}.</p>`;

    const top = h('div', { class: 'row', style: { justifyContent: 'space-between' } });
    elBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => run() }, [svgPlay(), 'Запустить сейчас']);
    elStatus = h('p', { class: 'caption', style: { flex: '1', minWidth: '240px' } });
    top.append(elStatus, elBtn);
    el.append(top);
    const meter = h('div', { class: 'meter' }, [elBar = h('i', { style: { background: 'var(--amber)' } })]);
    el.append(meter);

    const mainHost = h('div', { class: 'fig__canvas ld-main', role: 'img', 'aria-label': 'Качество против битрейта: точки кодирований и выпуклая оболочка выбранного плана' });
    el.append(h('div', { class: 'panel', style: { padding: '12px 12px 6px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, [h('span', { class: 'ctl-label', text: 'План: точки кодирований и оболочка' }),
        h('div', { class: 'legend' }, asset.ladder.map((rg, r) => h('span', null, [h('i', { class: 'dot', style: { '--c': `var(--q${r + 1})` } }), rg.name])))]),
      mainHost]));
    cvMain = FJ.canvas(mainHost, { onResize: () => paintMain() });

    elThumbs = h('div', { class: 'ld-thumbs', role: 'group', 'aria-label': 'Выбор плана' });
    film.eight.forEach((shot, s) => {
      const c = h('canvas', { width: 160, height: 90 });
      const b = h('button', { class: 'ld-thumb', type: 'button', 'aria-pressed': String(s === S.sel), style: { '--c': SHOT_COL[s] } }, [c, h('span', { text: shot.name })]);
      b.addEventListener('click', () => { S.sel = s; FJ.$$('.ld-thumb', elThumbs).forEach((x, k) => x.setAttribute('aria-pressed', String(k === s))); paintMain(); });
      elThumbs.append(b);
      film.init().then(() => { const i = Math.floor((shot.f0 + shot.f1) / 2); c.getContext('2d').drawImage(film.render(i), 0, 0, 160, 90); });
    });
    el.append(elThumbs);

    const sumHost = h('div', { class: 'fig__canvas ld-sum', role: 'img', 'aria-label': 'Средний битрейт против среднего качества для трёх стратегий' });
    const qHost = h('div');
    const tbl = h('table', { class: 'tbl' });
    tbl.innerHTML = '<thead><tr><th>Стратегия</th><th class="r">Битрейт для цели</th><th class="r">к фиксированной</th><th class="r">к per-title</th></tr></thead>';
    elTable = h('tbody'); tbl.append(elTable);
    const tbl2 = h('table', { class: 'tbl' });
    tbl2.innerHTML = '<thead><tr><th>План</th><th>Лучшее при 150&nbsp;кбит/с</th><th>при 800&nbsp;кбит/с</th><th class="r">Для 38 дБ нужно</th></tr></thead>';
    elBest = h('tbody'); tbl2.append(elBest);
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, [h('span', { class: 'ctl-label', text: 'Три стратегии: средний битрейт → среднее качество' }),
        h('div', { class: 'legend' }, [h('span', null, [h('i', { style: { '--c': '#8f9197' } }), 'фиксированная']), h('span', null, [h('i', { style: { '--c': '#6fb3ff' } }), 'per-title']), h('span', null, [h('i', { style: { '--c': '#ffb02e' } }), 'per-shot'])])]),
      sumHost, qHost]));
    cvSum = FJ.canvas(sumHost, { onResize: () => paintSummary() });
    qSlider = FJ.slider(qHost, { id: 'ldQ', label: 'Целевое среднее качество', min: 30, max: 46, step: 0.5, value: 38, fmt: v => fmt.db(v, 1), onInput: () => paintSummary() });
    el.append(h('div', { class: 'tbl-wrap' }, [tbl]), h('div', { class: 'tbl-wrap' }, [tbl2]));
    el.append(h('p', { class: 'caption', html: `Фиксированная лесенка&nbsp;— наши пять ступеней: разрешение и&nbsp;средний битрейт заданы заранее, а&nbsp;внутри фильма биты распределяются как при постоянном QP (так приближённо работает двухпроходный VBR). Per-title&nbsp;— для каждого битрейта берётся лучшее разрешение на&nbsp;общей оболочке фильма. Per-shot&nbsp;— каждый план берёт точку своей оболочки с&nbsp;одинаковым наклоном λ, а&nbsp;λ перебирается. Качество фильма&nbsp;— среднее PSNR по&nbsp;семи планам: архивную плёнку не&nbsp;усредняем. Зерно новое в&nbsp;каждом кадре, и&nbsp;PSNR сравнивает его попиксельно: даже 60&nbsp;Мбит/с не&nbsp;поднимают его выше ~36&nbsp;дБ. Поэтому в&nbsp;AV1 зерно убирают перед кодированием и&nbsp;синтезируют в&nbsp;плеере&nbsp;— у&nbsp;Netflix это −36&nbsp;% битрейта от&nbsp;1080p${FJ.cite('nf-fgs')}. Наши планы нарочно непохожи друг на&nbsp;друга, поэтому выигрыш per-shot здесь больше, чем 17–22&nbsp;% у&nbsp;Netflix на&nbsp;настоящих фильмах. Отрывки по&nbsp;48 кадров из&nbsp;середины каждого плана, один ключевой кадр на&nbsp;отрывок, как в&nbsp;нашем 2‑секундном сегменте.` }));
    paintAll();
  }
  function svgPlay() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<path d="M5 3l8 5-8 5z" fill="currentColor"/>';
    return s;
  }

  let armed = false;
  FJ.figure({
    id: 'ladder', el: $('#fig-ladder'),
    mount,
    start() {
      // запускаем сами, когда фигура видна и ферма свободна
      if (armed || S.status !== 'idle') return;
      // на телефоне и слабых машинах — только по кнопке: 160 кодирований греют устройство
      const strong = root.matchMedia && root.matchMedia('(min-width: 900px)').matches && (navigator.hardwareConcurrency || 4) >= 4;
      if (!strong) { S.manual = true; paintStatus(); return; }
      armed = true;
      const go = () => { if (S.status === 'idle') run(); };
      if (asset.allReady || asset.mode === 'model') go(); else asset.on('done', go);
    },
    stop() { },
    frame() { if (S.status === 'running') paintStatus(); },
  });
  FJ.ladderLab = { S, analyze, hull };
})(window);

/* =====================================================================
   20-farm — ферма кодирования и хранилище ассета.
   Фильм рендерится кадр за кадром, масштабируется в пять качеств и
   кодируется пятью VideoEncoder (H.264) параллельно. Ключевой кадр —
   на границе каждого 2-секундного сегмента, поэтому качества можно
   переключать на любой границе. Без WebCodecs включается модель.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const film = FJ.film;
  const FPS = film.FPS, SEG = film.SEG, SEG_FRAMES = FPS * SEG;
  const SEG_COUNT = Math.ceil(film.FRAMES / SEG_FRAMES);

  /* Лесенка: разрешение и целевой битрейт (VBR) */
  const LADDER = [
    { r: 0, name: '720p', w: 1280, h: 720, kbps: 2400 },
    { r: 1, name: '540p', w: 960, h: 540, kbps: 1400 },
    { r: 2, name: '360p', w: 640, h: 360, kbps: 750 },
    { r: 3, name: '270p', w: 480, h: 270, kbps: 400 },
    { r: 4, name: '180p', w: 320, h: 180, kbps: 200 },
  ];
  const CODECS = [
    { codec: 'avc1.64001f', profile: 'High', level: '3.1' },
    { codec: 'avc1.4d401f', profile: 'Main', level: '3.1' },
    { codec: 'avc1.42e01f', profile: 'Constrained Baseline', level: '3.1' },
  ];

  const tsOf = i => Math.round(i * 1e6 / FPS);
  const frameOfTs = ts => Math.round(ts * FPS / 1e6);

  /* ------------------------------------------------------------------
     Ассет: всё, что знает «ориджин» об этом фильме
     ------------------------------------------------------------------ */
  const bus = FJ.emitter();
  const asset = {
    ladder: LADDER, fps: FPS, segDur: SEG, segFrames: SEG_FRAMES, segCount: SEG_COUNT, frameCount: film.FRAMES,
    mode: 'pending',          // 'webcodecs' | 'model'
    codec: null, profile: null, hw: null,
    frames: LADDER.map(() => new Array(film.FRAMES)),   // {i, ts, dur, key, size, data, qp?}
    segs: LADDER.map(() => Array.from({ length: SEG_COUNT }, (_, k) => ({ k, ready: false, bytes: 0, frames: 0, keys: 0 }))),
    decoderConfig: LADDER.map(() => null),
    doneFrames: LADDER.map(() => 0),
    readySegs: LADDER.map(() => 0),       // сколько сегментов подряд готово
    farmFps: 0, startedAt: 0, finishedAt: 0, error: null,
    diff: new Float32Array(film.FRAMES),  // разность соседних кадров (для детектора склеек)
    luma: new Float32Array(film.FRAMES),  // средняя яркость кадра
    on: bus.on, emit: bus.emit,
    tsOf, frameOfTs,
    isReady(r, k) { return !!this.segs[r][k] && this.segs[r][k].ready; },
    segBits(r, k) { return this.segs[r][k].bytes * 8; },
    /* Фактический средний битрейт качества по готовым сегментам */
    avgKbps(r) {
      let b = 0, n = 0;
      for (const s of this.segs[r]) if (s.ready) { b += s.bytes; n++; }
      return n ? b * 8 / (n * SEG) / 1000 : LADDER[r].kbps;
    },
    peakKbps(r) {
      let m = 0;
      for (const s of this.segs[r]) if (s.ready) m = Math.max(m, s.bytes * 8 / SEG / 1000);
      return m || LADDER[r].kbps;
    },
    get allReady() { return this.readySegs.every(n => n >= SEG_COUNT); },
    get progress() { return this.doneFrames.reduce((a, b) => a + b, 0) / (film.FRAMES * LADDER.length); },
  };
  FJ.asset = asset;

  /* ------------------------------------------------------------------
     Прожиг: таймкод и номер качества, как на скринерах
     ------------------------------------------------------------------ */
  function burnIn(x, rung, i) {
    const h = rung.h, w = rung.w;
    const fs = Math.max(6, Math.round(h * 0.03));
    x.font = `500 ${fs}px "JetBrains Mono", ui-monospace, monospace`;
    x.textBaseline = 'middle';
    const pad = Math.round(fs * 0.45), bh = Math.round(fs * 1.5), y = h - bh - Math.round(fs * 0.7);
    const tc = FJ.fmt.tc(i, FPS);
    const tag = 'R' + (rung.r + 1) + ' ' + rung.name;
    const w1 = x.measureText(tc).width + pad * 2, w2 = x.measureText(tag).width + pad * 2;
    x.fillStyle = 'rgba(0,0,0,.62)';
    x.fillRect(Math.round(fs * 0.8), y, w1, bh);
    x.fillRect(w - Math.round(fs * 0.8) - w2, y, w2, bh);
    x.fillStyle = '#f2f2ee';
    x.textAlign = 'left'; x.fillText(tc, Math.round(fs * 0.8) + pad, y + bh / 2 + 1);
    x.fillText(tag, w - Math.round(fs * 0.8) - w2 + pad, y + bh / 2 + 1);
  }

  /* ------------------------------------------------------------------
     Измерение: разность соседних кадров и яркость (для детектора склеек)
     ------------------------------------------------------------------ */
  const probe = document.createElement('canvas');
  probe.width = 64; probe.height = 36;
  const px = probe.getContext('2d', { willReadFrequently: true });
  let prevLuma = null;
  function measure(i, src) {
    px.drawImage(src, 0, 0, 64, 36);
    const d = px.getImageData(0, 0, 64, 36).data;
    const L = new Float32Array(64 * 36);
    let sum = 0;
    for (let k = 0, j = 0; k < d.length; k += 4, j++) { const y = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; L[j] = y; sum += y; }
    asset.luma[i] = sum / L.length / 255;
    if (prevLuma) { let s = 0; for (let j = 0; j < L.length; j++) s += Math.abs(L[j] - prevLuma[j]); asset.diff[i] = s / L.length / 255; }
    prevLuma = L;
  }

  /* ------------------------------------------------------------------
     Кодирование WebCodecs
     ------------------------------------------------------------------ */
  async function pickCodec() {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof VideoDecoder === 'undefined') return null;
    for (const c of CODECS) {
      for (const hw of ['no-preference', 'prefer-software']) {
        const cfg = { codec: c.codec, width: 1280, height: 720, bitrate: 2400000, framerate: FPS, hardwareAcceleration: hw, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } };
        try {
          const s = await VideoEncoder.isConfigSupported(cfg);
          if (s && s.supported) {
            const d = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: 1280, codedHeight: 720 });
            if (d && d.supported) return Object.assign({}, c, { hw });
          }
        } catch (e) { /* пробуем следующий */ }
      }
    }
    return null;
  }

  function makeEncoder(rung, choice) {
    const enc = new VideoEncoder({
      output(chunk, meta) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const i = frameOfTs(chunk.timestamp);
        if (meta && meta.decoderConfig) {
          const dc = Object.assign({}, meta.decoderConfig);
          if (dc.description) dc.description = new Uint8Array(dc.description.buffer ? dc.description.buffer.slice(dc.description.byteOffset || 0, (dc.description.byteOffset || 0) + dc.description.byteLength) : dc.description).slice();
          asset.decoderConfig[rung.r] = dc;
        }
        store(rung.r, i, chunk.type === 'key', data);
      },
      error(e) { asset.error = e.message; console.warn('encoder', rung.name, e.message); },
    });
    enc.configure({
      codec: choice.codec, width: rung.w, height: rung.h, bitrate: rung.kbps * 1000, framerate: FPS,
      hardwareAcceleration: choice.hw, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' },
    });
    return enc;
  }

  function store(r, i, key, data) {
    if (i < 0 || i >= film.FRAMES) return;
    const f = { i, ts: tsOf(i), dur: tsOf(i + 1) - tsOf(i), key, size: data ? data.byteLength : 0, data, shot: film.shotIndexAt(i) };
    asset.frames[r][i] = f;
    const k = Math.floor(i / SEG_FRAMES);
    const s = asset.segs[r][k];
    s.bytes += f.size; s.frames++; if (key) s.keys++;
    asset.doneFrames[r]++;
    const need = Math.min(SEG_FRAMES, film.FRAMES - k * SEG_FRAMES);
    if (s.frames >= need && !s.ready) {
      s.ready = true;
      s.doneAt = performance.now() - asset.startedAt;
      s.startsWithKey = !!(asset.frames[r][k * SEG_FRAMES] && asset.frames[r][k * SEG_FRAMES].key);
      while (asset.readySegs[r] < SEG_COUNT && asset.segs[r][asset.readySegs[r]].ready) asset.readySegs[r]++;
      bus.emit('segment', { r, k });
    }
  }

  async function runWebCodecs(choice) {
    asset.mode = 'webcodecs';
    asset.codec = choice.codec; asset.profile = choice.profile + ' @ L' + choice.level; asset.hw = choice.hw;
    const canvases = LADDER.map(rg => { const c = document.createElement('canvas'); c.width = rg.w; c.height = rg.h; const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return { c, x }; });
    const encs = LADDER.map(rg => makeEncoder(rg, choice));
    asset.startedAt = performance.now();
    let slice = performance.now();
    for (let i = 0; i < film.FRAMES; i++) {
      const src = film.render(i);
      measure(i, src);
      const key = i % SEG_FRAMES === 0;
      for (let r = 0; r < LADDER.length; r++) {
        const rg = LADDER[r], cv = canvases[r];
        cv.x.drawImage(src, 0, 0, rg.w, rg.h);
        burnIn(cv.x, rg, i);
        const vf = new VideoFrame(cv.c, { timestamp: tsOf(i), duration: tsOf(i + 1) - tsOf(i) });
        encs[r].encode(vf, { keyFrame: key });
        vf.close();
      }
      // обратное давление: не копим очередь в кодировщиках
      while (encs.some(e => e.encodeQueueSize > 4)) await FJ.sleep(2);
      if (performance.now() - slice > 10) {
        asset.farmFps = (i + 1) / ((performance.now() - asset.startedAt) / 1000);
        bus.emit('progress', asset.progress);
        await FJ.yield();
        slice = performance.now();
      }
      if (asset.error) throw new Error(asset.error);
    }
    await Promise.all(encs.map(e => e.flush()));
    encs.forEach(e => e.close());
    asset.finishedAt = performance.now();
    asset.farmFps = film.FRAMES / ((asset.finishedAt - asset.startedAt) / 1000);
  }

  /* ------------------------------------------------------------------
     Модель без WebCodecs: размер кадра из «сложности» плана
     ------------------------------------------------------------------ */
  const COMPLEXITY = { bars: 0.05, slate: 0.08, leader: 0.35, dawn: 0.7, toon: 0.35, rain: 1.5, train: 1.35, close: 0.55, archive: 2.2, fire: 1.3, credits: 0.3, fade: 0.2 };
  async function runModel() {
    asset.mode = 'model';
    asset.codec = 'модель'; asset.profile = '—'; asset.hw = '—';
    const rnd = FJ.rng(20260925);
    asset.startedAt = performance.now();
    for (let i = 0; i < film.FRAMES; i++) {
      const shot = film.shotAt(i);
      if (i % 4 === 0) { const src = film.render(i); measure(i, src); }
      for (let r = 0; r < LADDER.length; r++) {
        const rg = LADDER[r];
        const base = rg.kbps * 1000 / 8 / FPS;
        const key = i % SEG_FRAMES === 0;
        const c = (COMPLEXITY[shot.id] || 1) * (0.85 + 0.3 * rnd());
        const size = Math.round(base * Math.min(2.2, c) * (key ? 5 : 0.9));
        store(r, i, key, null);
        asset.frames[r][i].size = size;
        const s = asset.segs[r][Math.floor(i / SEG_FRAMES)];
        s.bytes += size;
      }
      if (i % 48 === 47) { bus.emit('progress', asset.progress); await FJ.yield(); }
    }
    asset.finishedAt = performance.now();
    asset.farmFps = film.FRAMES / ((asset.finishedAt - asset.startedAt) / 1000);
  }

  let started = null;
  FJ.farm = {
    LADDER, SEG_FRAMES, SEG_COUNT,
    start() {
      if (started) return started;
      started = (async () => {
        await film.init();
        const choice = await pickCodec();
        try {
          if (choice) await runWebCodecs(choice); else await runModel();
        } catch (e) {
          console.warn('ферма: переход в модель —', e.message);
          // сбрасываем и считаем моделью
          for (let r = 0; r < LADDER.length; r++) {
            asset.frames[r] = new Array(film.FRAMES);
            asset.segs[r] = Array.from({ length: SEG_COUNT }, (_, k) => ({ k, ready: false, bytes: 0, frames: 0, keys: 0 }));
            asset.doneFrames[r] = 0; asset.readySegs[r] = 0;
          }
          prevLuma = null;
          await runModel();
        }
        bus.emit('done', asset);
        return asset;
      })();
      return started;
    },
  };
})(window);

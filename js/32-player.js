/* =====================================================================
   32-player — плеер: старт, планировщик загрузок, буфер, остановки,
   ABR, декодирование WebCodecs и вывод кадров по часам.

   Время загрузки считает модель сети (30-net), а байты, ключевые кадры
   и картинка — настоящие, из ассета фермы. Остановка буфера — настоящая
   остановка картинки. Фильм зациклен: виртуальный сегмент K играет
   сегмент K mod 32 ассета, метки времени растут монотонно.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const net = FJ.net;
  let seq = 0;

  class Player {
    constructor(o) {
      this.o = o;
      this.id = ++seq;
      this.asset = o.asset;
      this.name = o.name || 'Плеер';
      this.canvas = o.canvas || null;
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.setDevice(o.device || FJ.devices.laptop, true);
      this.trace = o.trace;
      this.algoId = o.algoId || 'bola';
      this.startup = o.startup !== false;      // моделировать ли рукопожатия старта
      this.prefetched = !!o.prefetched;        // манифест, лицензия и init уже есть (ТВ: предзагрузка по фокусу)
      this.startAt = o.startAt || 0;
      this.onEvent = o.onEvent || null;
      this.decR = -1; this.dec = null; this.frames = []; this.shown = null;
      this.reset();
    }

    /* ---------- настройка ---------- */
    setDevice(dev, silent) {
      this.device = dev;
      this.maxBuffer = this.o.maxBuffer || dev.maxBuffer;
      if (!silent) this.reset();
    }
    setTrace(tr) { this.trace = tr; }
    setAlgo(id) { this.algoId = id; this.reset(); }
    /* Сменить алгоритм на лету, не трогая буфер и воспроизведение */
    swapAlgo(id) { this.algoId = id; this.algo = FJ.abr.ALGOS[id].make(this.buildLadder(), { startBw: this.o.startBw }); }
    /* Ферма досчитала: обновить фактические средние и пиковые битрейты */
    refreshLadder() {
      const L = this.buildLadder();
      if (this.algo && this.algo.L) this.algo.L.forEach((x, q) => Object.assign(x, L[q]));
    }

    /* Лесенка для ABR: только разрешённые ступени, по возрастанию битрейта */
    buildLadder() {
      const a = this.asset, rs = [];
      for (let r = a.ladder.length - 1; r >= this.device.topRung; r--) rs.push(r);
      this.rungs = rs;                                   // q → r
      return rs.map(r => ({ r, kbps: a.ladder[r].kbps, avgKbps: a.avgKbps(r), peakKbps: a.peakKbps(r) }));
    }
    rOf(q) { return this.rungs[q]; }
    qOf(r) { return this.rungs.indexOf(r); }

    reset() {
      const a = this.asset;
      this.segDur = a.segDur;
      this.simT = 0;
      this.playhead = this.startAt;                     // виртуальные секунды медиа
      this.state = this.startup ? 'handshake' : 'buffering';
      this.loadedR = new Map();                          // K → r
      this.loadedEnd = Math.floor(this.startAt / this.segDur) * this.segDur;
      this.nextK = Math.floor(this.startAt / this.segDur);
      this.dl = null;
      this.lastQ = -1;
      this.algo = FJ.abr.ALGOS[this.algoId].make(this.buildLadder(), { startBw: this.o.startBw });
      this.hs = [];                                      // водопад старта
      this.hsQueue = null;
      this.licenseAt = this.prefetched || !this.startup ? 0 : null;
      this.firstFrameAt = null;
      this.stats = { ttff: null, stalls: 0, stallTime: 0, playTime: 0, bitSec: 0, switches: 0, bytes: 0, qoe: 0, qSum: 0, swSum: 0, segs: 0, dropped: 0, shownFrames: 0, lastPlayedR: -1, waitEncoder: 0 };
      this.hist = [];                                    // для графиков
      this.segLog = [];
      this.samples = [];
      this.stallStart = null;
      this.lastHist = -1;
      this.resetDecoder();
      if (this.o.preload) this.preloadFirst();
      else if (this.startup) this.beginHandshake();
    }

    /* Предзагрузка по фокусу: манифест, лицензия, init и первый сегмент уже есть */
    preloadFirst() {
      const a = this.asset, K = this.nextK, k = this.segOf(K);
      const st = { buffer: 0, lastQ: -1, segDur: this.segDur, maxBuffer: this.maxBuffer, startup: true, nextSize: (j, q) => a.segs[this.rOf(q)][this.segOf(K + j)].bytes };
      let q = this.algo.choose(st);
      while (q > 0 && !a.isReady(this.rOf(q), k)) q--;
      const r = this.rOf(q);
      this.loadedR.set(K, r);
      this.loadedEnd = (K + 1) * this.segDur;
      this.nextK = K + 1;
      this.lastQ = q;
      this.stats.bytes += a.segs[r][k].bytes;
      this.stats.lastPlayedR = r; this.stats.qSum += a.ladder[r].kbps / 1000; this.stats.segs++;
      this.licenseAt = 0;
      this.state = 'buffering';
    }

    resetDecoder() {
      for (const f of this.frames) f.close();
      this.frames = [];
      if (this.shown) { this.shown.close(); this.shown = null; }
      if (this.dec && this.dec.state !== 'closed') { try { this.dec.close(); } catch (e) { /* уже закрыт */ } }
      this.dec = null; this.decR = -1;
      this.fedI = Math.round(this.playhead * this.asset.fps);
      this.ensureDecoder();
    }

    /* Декодер создаётся лениво: ферма могла ещё не решить, есть ли WebCodecs */
    ensureDecoder() {
      if (this.dec || !this.canvas || this.asset.mode !== 'webcodecs' || typeof VideoDecoder === 'undefined') return !!this.dec;
      this.dec = new VideoDecoder({
        output: f => { this.frames.push(f); if (this.frames.length > 24) this.frames.shift().close(); },
        error: e => { this.decError = e.message; },
      });
      this.decR = -1;
      const I = Math.floor(this.playhead * this.asset.fps);
      this.fedI = Math.floor(I / this.asset.segFrames) * this.asset.segFrames;
      return true;
    }

    /* Фигура ушла из вида: отдать кадры видеопамяти, продолжить потом с ключевого кадра */
    suspend() {
      for (const f of this.frames) f.close();
      this.frames = [];
      if (this.dec && this.dec.state === 'configured') { try { this.dec.reset(); } catch (e) { /* уже сброшен */ } }
      this.decR = -1;
      const I = Math.floor(this.playhead * this.asset.fps);
      this.fedI = Math.floor(I / this.asset.segFrames) * this.asset.segFrames;
    }

    destroy() {
      for (const f of this.frames) f.close();
      this.frames = [];
      if (this.shown) { this.shown.close(); this.shown = null; }
      if (this.dec && this.dec.state !== 'closed') try { this.dec.close(); } catch (e) { /* уже закрыт */ }
      this.dec = null;
    }

    /* ---------- старт: манифест → плейлист → init → лицензия ∥ сегмент ---------- */
    beginHandshake() {
      const dev = this.device;
      const steps = this.prefetched
        ? []
        : [
          { id: 'app', label: 'подготовка плеера', local: dev.appStart },
          { id: 'master', label: 'master.m3u8', bytes: 2800 },
          { id: 'media', label: 'плейлист качества', bytes: 3400 },
          { id: 'init', label: 'init.mp4', bytes: 820 },
        ];
      this.hsQueue = steps;
      this.hsStep();
    }
    hsStep() {
      const s = this.hsQueue.shift();
      if (!s) { this.state = 'buffering'; if (!this.prefetched) this.requestLicense(); return; }
      const t0 = this.simT;
      const end = s.local != null ? t0 + s.local : net.downloadEnd(this.trace, t0, s.bytes);
      this.hs.push({ id: s.id, label: s.label, t0, t1: end, kind: s.local != null ? 'local' : 'net' });
      this.hsCur = { end };
    }
    requestLicense() {
      const t0 = this.simT;
      const end = net.downloadEnd(this.trace, t0, 1600) + 0.08; // запрос + 80 мс сервера лицензий
      this.hs.push({ id: 'lic', label: 'лицензия DRM', t0, t1: end, kind: 'drm' });
      this.licenseAt = end;
    }

    /* ---------- сколько видео впереди ---------- */
    get buffer() { return Math.max(0, this.loadedEnd - this.playhead); }
    get rShown() { const K = Math.floor(this.playhead / this.segDur); return this.loadedR.has(K) ? this.loadedR.get(K) : -1; }

    segOf(K) { return ((K % this.asset.segCount) + this.asset.segCount) % this.asset.segCount; }

    /* ---------- главный шаг ---------- */
    update(dt) {
      const a = this.asset;
      this.simT += dt;
      const t = this.simT;

      // старт
      if (this.state === 'handshake') {
        if (this.hsCur && t >= this.hsCur.end) { this.hsCur = null; this.hsStep(); }
        if (this.state === 'handshake') { this.sampleHist(); return; }
      }

      // сеть
      if (this.dl) {
        if (this.dl.advance(t)) this.onLoaded(this.dl);
      }
      if (!this.dl) this.schedule();

      // часы воспроизведения
      if (this.state === 'playing') {
        const adv = dt;
        const room = this.loadedEnd - this.playhead;
        if (room <= 1e-6) {
          this.state = 'stalled'; this.stats.stalls++; this.stallStart = t;
          this.emit('stall');
        } else {
          const step = Math.min(adv, room);
          this.accountPlay(step);
          this.playhead += step;
        }
      } else if (this.state === 'stalled') {
        this.stats.stallTime += dt;
        if (this.buffer >= Math.min(this.segDur, this.maxBuffer * 0.5)) { this.state = 'playing'; this.emit('resume'); }
      } else if (this.state === 'buffering') {
        // первый кадр: нужен сегмент и лицензия
        if (this.loadedEnd > this.playhead && this.licenseAt != null && t >= this.licenseAt) {
          this.state = 'playing';
          if (this.stats.ttff == null) { this.stats.ttff = t; this.emit('firstframe'); }
        }
      }

      this.sampleHist();
    }

    accountPlay(step) {
      const r = this.rShown;
      if (r < 0) return;
      const st = this.stats;
      st.playTime += step;
      st.bitSec += this.asset.ladder[r].kbps * step;
    }

    /* Решить, что грузить дальше */
    schedule() {
      const a = this.asset;
      if (this.state === 'handshake') return;
      if (this.buffer > this.maxBuffer - this.segDur) return;          // буфер полон — ждём
      const K = this.nextK, k = this.segOf(K);
      const st = {
        buffer: this.buffer, lastQ: this.lastQ, segDur: this.segDur, maxBuffer: this.maxBuffer,
        startup: this.stats.ttff == null,
        nextSize: (j, q) => { const s = a.segs[this.rOf(q)][this.segOf(K + j)]; return s && s.ready ? s.bytes : a.ladder[this.rOf(q)].kbps * 125 * this.segDur; },
      };
      let q = this.algo.choose(st);
      let r = this.rOf(q);
      // ферма ещё не докодировала: берём ближайшую готовую ступень ниже, иначе ждём
      if (!a.isReady(r, k)) {
        let alt = -1;
        for (let qq = q - 1; qq >= 0; qq--) if (a.isReady(this.rOf(qq), k)) { alt = qq; break; }
        if (alt < 0) { this.stats.waitEncoder += 1 / 60; return; }
        q = alt; r = this.rOf(q);
      }
      const bytes = a.segs[r][k].bytes;
      this.dl = new net.Transfer(this.trace, this.simT, bytes, { K, r, q, brain: this.algo.brain });
      this.dl.t0 = this.simT;
    }

    onLoaded(dl) {
      const { K, r, q } = dl.meta;
      const transfer = Math.max(0.001, dl.tEnd - dl.tFirst);
      this.algo.sample({ bytes: dl.bytes, transfer, ttfb: this.trace.rtt });
      this.samples.push({ t: dl.tEnd, bps: dl.bytes * 8 / (dl.tEnd - dl.t0) });
      if (this.samples.length > 200) this.samples.shift();
      this.loadedR.set(K, r);
      for (const key of this.loadedR.keys()) if (key < K - 40) this.loadedR.delete(key);
      this.loadedEnd = (K + 1) * this.segDur;
      this.nextK = K + 1;
      this.stats.bytes += dl.bytes;
      // QoE_lin по сегментам (Мбит/с): R − λ|ΔR|, минус μ·остановки считаем отдельно
      const R = this.asset.ladder[r].kbps / 1000;
      const prevR = this.stats.lastPlayedR >= 0 ? this.asset.ladder[this.stats.lastPlayedR].kbps / 1000 : R;
      if (this.stats.lastPlayedR >= 0 && this.stats.lastPlayedR !== r) this.stats.switches++;
      this.stats.qSum += R; this.stats.swSum += Math.abs(R - prevR); this.stats.segs++;
      this.stats.lastPlayedR = r;
      this.lastQ = q;
      this.segLog.push({ K, r, t0: dl.t0, t1: dl.tEnd, bytes: dl.bytes, brain: dl.meta.brain });
      if (this.segLog.length > 120) this.segLog.shift();
      if (this.stats.ttff == null && this.startup) {
        this.hs.push({ id: 'seg', label: 'первый сегмент · ' + this.asset.ladder[r].name, t0: dl.t0, t1: dl.tEnd, kind: 'seg' });
      }
      this.dl = null;
      this.emit('segment', { K, r });
    }

    /* QoE_lin: Σ R − λ Σ|ΔR| − μ · остановки; нормируем на сегмент */
    get qoe() {
      const s = this.stats;
      if (!s.segs) return 0;
      const mu = this.asset.ladder[this.device.topRung].kbps / 1000;
      return (s.qSum - s.swSum - mu * s.stallTime) / s.segs;
    }
    get avgKbps() { return this.stats.playTime ? this.stats.bitSec / this.stats.playTime : 0; }

    sampleHist() {
      const slot = Math.floor(this.simT * 4);
      if (slot === this.lastHist) return;
      this.lastHist = slot;
      const b = this.algo.brain;
      let est = null;
      if (this.algo.est) est = this.algo.est.estimate();
      else if (b && b.robust) est = b.robust;
      this.hist.push({ t: this.simT, cap: net.capacityAt(this.trace, this.simT), est, buf: this.buffer, r: this.rShown, st: this.state });
      if (this.hist.length > 4 * 150) this.hist.shift();
    }

    emit(evt, data) { if (this.onEvent) this.onEvent(evt, data, this); }

    /* ---------- декодирование и вывод ---------- */
    feedDecoder() {
      const a = this.asset, dec = this.dec;
      if (!dec || dec.state === 'closed') return;
      const F = a.fps, sf = a.segFrames;
      const target = Math.floor(this.playhead * F) + 8;
      let guard = 0;
      while (this.fedI <= target && dec.decodeQueueSize < 6 && guard++ < 16) {
        const I = this.fedI, K = Math.floor(I / sf);
        if (!this.loadedR.has(K)) break;
        const r = this.loadedR.get(K);
        const i = ((I % a.frameCount) + a.frameCount) % a.frameCount;
        const fr = a.frames[r][i];
        if (!fr || !fr.data) break;
        if (r !== this.decR) {
          if (!fr.key) { this.fedI++; continue; } // переключаться можно только с ключевого кадра
          dec.configure(a.decoderConfig[r]);
          this.decR = r;
        }
        dec.decode(new EncodedVideoChunk({ type: fr.key ? 'key' : 'delta', timestamp: Math.round(I * 1e6 / F), duration: fr.dur, data: fr.data }));
        this.fedI++;
      }
    }

    /* Нарисовать текущий кадр в свой холст (или в переданный контекст) */
    render(ctx, w, h) {
      ctx = ctx || this.ctx;
      if (!ctx) return;
      w = w || ctx.canvas.width; h = h || ctx.canvas.height;
      const a = this.asset;
      if (a.mode === 'webcodecs') this.ensureDecoder();
      if (a.mode !== 'webcodecs' || !this.dec) return this.renderModel(ctx, w, h);
      this.feedDecoder();
      const now = this.playhead * 1e6 + 1;
      let pick = -1;
      for (let j = 0; j < this.frames.length; j++) if (this.frames[j].timestamp <= now) pick = j;
      if (pick >= 0) {
        const fr = this.frames[pick];
        for (let j = 0; j < pick; j++) this.frames[j].close();
        this.frames.splice(0, pick + 1);
        // устройство не тянет ступень: часть кадров не успевает к показу
        const r = this.rShown;
        const drop = r >= 0 && r < this.device.smoothRung && ((Math.round(fr.timestamp * a.fps / 1e6)) % 4 === 1);
        if (drop) { this.stats.dropped++; fr.close(); }
        else {
          if (this.shown) this.shown.close();
          this.shown = fr; this.stats.shownFrames++;
        }
      }
      if (this.shown) ctx.drawImage(this.shown, 0, 0, w, h);
      else { ctx.fillStyle = '#050506'; ctx.fillRect(0, 0, w, h); }
    }

    /* Модельный режим: исходный кадр в разрешении ступени */
    renderModel(ctx, w, h) {
      const a = this.asset;
      const r = this.rShown;
      if (r < 0) { ctx.fillStyle = '#050506'; ctx.fillRect(0, 0, w, h); return; }
      const I = Math.floor(this.playhead * a.fps);
      const i = ((I % a.frameCount) + a.frameCount) % a.frameCount;
      if (!this._mc) { this._mc = document.createElement('canvas'); }
      const rg = a.ladder[r];
      if (this._mc.width !== rg.w) { this._mc.width = rg.w; this._mc.height = rg.h; }
      const mx = this._mc.getContext('2d');
      mx.drawImage(FJ.film.render(i), 0, 0, rg.w, rg.h);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._mc, 0, 0, w, h);
    }
  }

  FJ.Player = Player;

  /* =====================================================================
     RungView — контрольный монитор одного качества: без сети, просто
     декодирует свою ступень синхронно с чужим плейхедом.
     ===================================================================== */
  class RungView {
    constructor(asset, r) {
      this.asset = asset; this.r = r;
      this.dec = null; this.frames = []; this.shown = null; this.fedI = -1; this.baseI = -1;
    }
    ensure() {
      const a = this.asset;
      if (this.dec || a.mode !== 'webcodecs' || !a.decoderConfig[this.r] || typeof VideoDecoder === 'undefined') return !!this.dec;
      this.dec = new VideoDecoder({
        output: f => { this.frames.push(f); if (this.frames.length > 16) this.frames.shift().close(); },
        error: () => { this.dead = true; },
      });
      this.dec.configure(a.decoderConfig[this.r]);
      return true;
    }
    restart(I) {
      for (const f of this.frames) f.close();
      this.frames = [];
      if (this.dec.state !== 'closed') { this.dec.reset(); this.dec.configure(this.asset.decoderConfig[this.r]); }
      this.baseI = Math.floor(I / this.asset.segFrames) * this.asset.segFrames;
      this.fedI = this.baseI;
    }
    sync(I) {
      if (!this.ensure() || this.dead) return;
      const a = this.asset;
      if (this.fedI < 0 || I < this.baseI || I > this.fedI + 36) this.restart(I);
      let guard = 0;
      while (this.fedI <= I + 4 && this.dec.decodeQueueSize < 6 && guard++ < 48) {
        const i = ((this.fedI % a.frameCount) + a.frameCount) % a.frameCount;
        const fr = a.frames[this.r][i];
        if (!fr || !fr.data) break;
        this.dec.decode(new EncodedVideoChunk({ type: fr.key ? 'key' : 'delta', timestamp: Math.round(this.fedI * 1e6 / a.fps), duration: fr.dur, data: fr.data }));
        this.fedI++;
      }
    }
    draw(ctx, w, h, I) {
      const a = this.asset;
      if (a.mode === 'model') return this.drawModel(ctx, w, h, I);
      this.sync(I);
      const now = I * 1e6 / a.fps + 1;
      let pick = -1;
      for (let j = 0; j < this.frames.length; j++) if (this.frames[j].timestamp <= now) pick = j;
      if (pick >= 0) {
        for (let j = 0; j < pick; j++) this.frames[j].close();
        const fr = this.frames[pick];
        this.frames.splice(0, pick + 1);
        if (this.shown) this.shown.close();
        this.shown = fr;
      }
      if (this.shown) ctx.drawImage(this.shown, 0, 0, w, h);
      else { ctx.fillStyle = '#050506'; ctx.fillRect(0, 0, w, h); }
    }
    drawModel(ctx, w, h, I) {
      const a = this.asset, rg = a.ladder[this.r];
      if (!this._mc) { this._mc = document.createElement('canvas'); this._mc.width = rg.w; this._mc.height = rg.h; }
      const i = ((I % a.frameCount) + a.frameCount) % a.frameCount;
      this._mc.getContext('2d').drawImage(FJ.film.render(i), 0, 0, rg.w, rg.h);
      ctx.drawImage(this._mc, 0, 0, w, h);
    }
    suspend() {
      for (const f of this.frames) f.close();
      this.frames = [];
      if (this.dec && this.dec.state === 'configured') { try { this.dec.reset(); this.dec.configure(this.asset.decoderConfig[this.r]); } catch (e) { /* уже сброшен */ } }
      this.fedI = -1;
    }
    destroy() {
      for (const f of this.frames) f.close();
      this.frames = [];
      if (this.shown) { this.shown.close(); this.shown = null; }
      if (this.dec && this.dec.state !== 'closed') try { this.dec.close(); } catch (e) { /* уже закрыт */ }
      this.dec = null; this.fedI = -1;
    }
  }
  FJ.RungView = RungView;
})(window);

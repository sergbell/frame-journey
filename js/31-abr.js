/* =====================================================================
   31-abr — алгоритмы адаптивного битрейта.
   Индекс q: 0 — нижняя ступень (самый низкий битрейт), N−1 — верхняя.
   Каждый алгоритм после choose() кладёт в this.brain то, чем он «думал»,
   чтобы это можно было нарисовать.

   Throughput — по правилам hls.js (EWMA 3/9 с, запас 0,95/0,7, проверка
               времени загрузки против буфера).
   BBA-0      — Huang et al., SIGCOMM 2014: карта «буфер → битрейт»,
               резервуар и подушка.
   BOLA-O     — Spiteri et al., INFOCOM 2016; параметры как в dash.js
               (MINIMUM_BUFFER_S = 10, +2 с на ступень), ограничение подъёма.
   RobustMPC  — Yin et al., SIGCOMM 2015: горизонт 5 сегментов,
               гармоническое среднее и поправка на худшую ошибку прогноза.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};

  /* EWMA с поправкой на старт, как в hls.js и Shaka */
  class Ewma {
    constructor(halfLife) { this.alpha = Math.exp(Math.log(0.5) / halfLife); this.est = 0; this.total = 0; }
    sample(weight, value) { const a = Math.pow(this.alpha, weight); this.est = value * (1 - a) + a * this.est; this.total += weight; }
    get() { const z = 1 - Math.pow(this.alpha, this.total); return z > 0 ? this.est / z : 0; }
  }
  class BwEstimator {
    constructor(fast, slow, def) { this.fastH = fast; this.slowH = slow; this.def = def; this.reset(); }
    reset() { this.fast = new Ewma(this.fastH); this.slow = new Ewma(this.slowH); }
    /* dur — время передачи тела без TTFB, с; bytes — байты */
    sample(dur, bytes) {
      const w = Math.max(dur, 0.05);
      const v = 8 * bytes / w;
      this.fast.sample(w, v); this.slow.sample(w, v);
    }
    estimate() {
      if (this.fast.total < 0.001) return this.def;
      return Math.min(this.fast.get(), this.slow.get());
    }
  }

  const DEFAULT_BW = 5e5; // стартовая оценка 500 кбит/с (как abrEwmaDefaultEstimate в hls.js)

  /* Общая часть */
  class Base {
    constructor(ladder) {
      // ladder: [{kbps, avgKbps, peakKbps}] по возрастанию
      this.L = ladder; this.N = ladder.length; this.brain = null;
    }
    kb(q) { return this.L[q].kbps; }
    reset() { this.brain = null; }
    sample() { }
  }

  /* ---------------- Throughput (hls.js) ---------------- */
  class Throughput extends Base {
    constructor(ladder, o) { super(ladder); this.est = new BwEstimator(3, 9, (o && o.startBw) || DEFAULT_BW); this.ttfb = 0.05; }
    reset() { super.reset(); this.est.reset(); }
    sample(s) { this.est.sample(s.transfer, s.bytes); this.ttfb = 0.8 * this.ttfb + 0.2 * s.ttfb; }
    choose(st) {
      const bw = this.est.estimate();
      const last = st.lastQ;
      const cand = [];
      let pick = -1, pass = 0;
      for (const starv of [0, Math.min(st.segDur, 4)]) {
        for (let q = this.N - 1; q >= 0; q--) {
          const up = last >= 0 && q > last;
          const factor = up ? 0.7 : 0.95;
          const budget = bw * factor;
          // при буфере ≥ 2 сегментов hls.js берёт средний битрейт, иначе пиковый
          const br = (st.buffer >= 2 * st.segDur ? this.L[q].avgKbps : this.L[q].peakKbps) * 1000;
          const fetch = this.ttfb + br * st.segDur / budget;
          const ok = budget >= br && fetch < st.buffer + starv;
          if (starv === 0) cand[q] = { factor, budget, br, fetch, ok };
          if (ok && pick < 0) { pick = q; }
        }
        if (pick >= 0) break;
        pass++;
      }
      if (pick < 0) pick = 0;
      this.brain = { bw, fast: this.est.fast.total ? this.est.fast.get() : null, slow: this.est.slow.total ? this.est.slow.get() : null, cand, pick, pass, buffer: st.buffer };
      return pick;
    }
  }

  /* ---------------- BBA-0 ---------------- */
  class Bba extends Base {
    constructor(ladder, o) { super(ladder); o = o || {}; this.r = o.reservoir || 5; this.c = o.cushion || 16; }
    map(B) {
      const Rmin = this.kb(0), Rmax = this.kb(this.N - 1);
      if (B <= this.r) return Rmin;
      if (B >= this.r + this.c) return Rmax;
      return Rmin + (Rmax - Rmin) * (B - this.r) / this.c;
    }
    choose(st) {
      const B = st.buffer, N = this.N;
      const f = this.map(B);
      const prev = st.lastQ < 0 ? 0 : st.lastQ;
      const plus = prev === N - 1 ? this.kb(N - 1) : this.kb(prev + 1);
      const minus = prev === 0 ? this.kb(0) : this.kb(prev - 1);
      let q, why;
      if (B <= this.r) { q = 0; why = 'резервуар'; }
      else if (B >= this.r + this.c) { q = N - 1; why = 'верх'; }
      else if (f >= plus) { q = 0; for (let i = 0; i < N; i++) if (this.kb(i) < f) q = i; why = 'вверх'; }
      else if (f <= minus) { q = N - 1; for (let i = N - 1; i >= 0; i--) if (this.kb(i) > f) q = i; why = 'вниз'; }
      else { q = prev; why = 'держим'; }
      this.brain = { B, f, plus, minus, q, why, r: this.r, c: this.c };
      return q;
    }
  }

  /* ---------------- BOLA-O (dash.js) ---------------- */
  class Bola extends Base {
    constructor(ladder, o) {
      super(ladder);
      this.startBw = (o && o.startBw) || DEFAULT_BW;
      const N = this.N;
      let u = ladder.map(l => Math.log(l.kbps));
      const u0 = u[0];
      this.u = u.map(x => x - u0 + 1);                     // нормировка, как в dash.js
      this.bufferTime = Math.max(18, 10 + 2 * N);             // bufferTimeDefault 18 с
      this.gp = (this.u[N - 1] - 1) / (this.bufferTime / 10 - 1);
      this.Vp = 10 / this.gp;
      this.est = new BwEstimator(2, 5.33, this.startBw);     // эффективные полураспады dash.js
    }
    reset() { super.reset(); this.est.reset(); }
    sample(s) { this.est.sample(s.transfer, s.bytes); }
    tputChoice() {
      const bw = this.est.estimate() * 0.9;                   // bandwidthSafetyFactor 0,9
      let q = 0;
      for (let i = 0; i < this.N; i++) if (this.kb(i) * 1000 <= bw) q = i;
      return q;
    }
    choose(st) {
      const N = this.N, B = st.buffer;
      const tq = this.tputChoice();
      const scores = [];
      for (let i = 0; i < N; i++) scores[i] = (this.Vp * (this.u[i] - 1 + this.gp) - B) / this.kb(i);
      let q, mode;
      if (st.lastQ < 0 || B < st.segDur) { q = tq; mode = 'старт по сети'; }
      else {
        q = 0;
        for (let i = 1; i < N; i++) if (scores[i] >= scores[q]) q = i;
        mode = 'BOLA';
        if (scores[q] <= 0) { q = N - 1; mode = 'буфер выше цели'; }
        if (q > st.lastQ && q > tq) { q = tq > st.lastQ ? tq : st.lastQ; mode = 'подъём ограничен сетью'; }
      }
      this.brain = { scores, q, tq, B, Vp: this.Vp, gp: this.gp, mode, bw: this.est.estimate() };
      return q;
    }
  }

  /* ---------------- RobustMPC ---------------- */
  class Mpc extends Base {
    constructor(ladder, o) {
      super(ladder); o = o || {};
      this.H = o.horizon || 5; this.lambda = o.lambda == null ? 1 : o.lambda;
      this.startBw = o.startBw || DEFAULT_BW;
      this.mu = o.mu || this.kb(this.N - 1) / 1000;            // μ = верхний битрейт в Мбит/с (QoE_lin)
      this.reset();
    }
    reset() { super.reset(); this.samples = []; this.errors = []; this.lastPred = null; }
    sample(s) {
      const bps = 8 * s.bytes / Math.max(s.transfer + s.ttfb, 0.02);
      if (this.lastPred) this.errors.push(Math.abs(this.lastPred - bps) / bps);
      this.samples.push(bps);
      if (this.samples.length > 5) this.samples.shift();
      if (this.errors.length > 5) this.errors.shift();
    }
    choose(st) {
      const N = this.N, H = this.H, lam = this.lambda, mu = this.mu;
      let pred = this.startBw;
      if (this.samples.length) pred = this.samples.length / this.samples.reduce((a, x) => a + 1 / x, 0);
      const maxErr = this.errors.length ? Math.max.apply(null, this.errors) : 0;
      const robust = pred / (1 + maxErr);
      this.lastPred = pred;
      const R = q => this.kb(q) / 1000; // Мбит/с
      const prevQ = st.lastQ;
      const sizes = [];
      for (let j = 0; j < H; j++) { sizes[j] = []; for (let q = 0; q < N; q++) sizes[j][q] = st.nextSize(j, q); }
      let best = -Infinity, bestPlan = null, second = -Infinity;
      const plan = new Array(H);
      const perFirst = new Array(N).fill(-Infinity);
      const rec = (j, B, prev, score) => {
        if (j === H) {
          if (score > best) { second = best; best = score; bestPlan = plan.slice(); } else if (score > second) second = score;
          if (score > perFirst[plan[0]]) perFirst[plan[0]] = score;
          return;
        }
        for (let q = 0; q < N; q++) {
          const dt = sizes[j][q] * 8 / robust;
          const reb = Math.max(0, dt - B);
          let nb = Math.max(B - dt, 0) + st.segDur;
          if (nb > st.maxBuffer) nb = st.maxBuffer;
          const sw = prev < 0 ? 0 : Math.abs(R(q) - R(prev));
          plan[j] = q;
          rec(j + 1, nb, q, score + R(q) - lam * sw - mu * reb);
        }
      };
      rec(0, st.buffer, prevQ, 0);
      const q = bestPlan ? bestPlan[0] : 0;
      this.brain = { pred, robust, maxErr, plan: bestPlan, best, perFirst, q, samples: this.samples.slice(), mu };
      return q;
    }
  }

  const ALGOS = {
    tput: { name: 'Throughput', short: 'THR', make: (l, o) => new Throughput(l, o), color: '--blue',
      desc: 'Как hls.js: берёт минимум двух EWMA (3 и 9 с), вниз — запас 0,95, вверх — 0,7' },
    bba: { name: 'BBA-0', short: 'BBA', make: (l, o) => new Bba(l, o), color: '--amber',
      desc: 'Смотрит только на буфер: резервуар 5 с, подушка 16 с (Netflix, SIGCOMM 2014)' },
    bola: { name: 'BOLA-O', short: 'BOLA', make: (l, o) => new Bola(l, o), color: '--violet',
      desc: 'Максимизирует полезность ln(битрейта) против риска по Ляпунову, параметры dash.js' },
    mpc: { name: 'RobustMPC', short: 'MPC', make: (l, o) => new Mpc(l, o), color: '--q3',
      desc: 'Перебирает 5⁵ = 3125 планов на 5 сегментов вперёд по осторожному прогнозу сети' },
  };

  FJ.abr = { Ewma, BwEstimator, Throughput, Bba, Bola, Mpc, ALGOS, DEFAULT_BW };
  if (typeof module !== 'undefined') module.exports = FJ.abr;
})(typeof window !== 'undefined' ? window : globalThis);

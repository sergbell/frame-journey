/* =====================================================================
   30-net — модель сети: трассы пропускной способности и загрузка.
   Трасса — ступенчатая функция с шагом 0,5 с, повторяется по кругу.
   Загрузка = RTT до первого байта + интеграл ёмкости по времени.
   Трассы синтетические, «по мотивам» открытых наборов данных.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const STEP = 0.5;          // шаг трассы, с
  const LEN = 240;           // длина трассы в шагах (120 с)
  const M = 1e6;

  /* Лог-нормальный AR(1): x_{n+1} = a x_n + (1−a) μ + σ√(1−a²) ε */
  function ar1(rnd, n, median, sigma, a) {
    const out = new Float64Array(n), mu = Math.log(median);
    let x = mu;
    for (let i = 0; i < n; i++) { x = a * x + (1 - a) * mu + sigma * Math.sqrt(1 - a * a) * rnd.gauss(); out[i] = Math.exp(x); }
    return out;
  }

  const TRACES = {
    fiber: {
      name: 'Оптика дома', rtt: 0.012,
      desc: 'Стабильные 40 Мбит/с: запаса хватит на всё',
      gen(rnd) { return Float64Array.from({ length: LEN }, () => 40 * M * (0.97 + 0.06 * rnd())); },
    },
    wifi: {
      name: 'Wi‑Fi 2,4 ГГц', rtt: 0.028,
      desc: 'Около 5 Мбит/с, но каждые полминуты — провалы из‑за соседей и микроволновки',
      gen(rnd) {
        const a = ar1(rnd, LEN, 5.2 * M, 0.25, 0.9);
        for (let i = 16; i < LEN; i += 50 + Math.floor(rnd() * 20)) {
          const len = 6 + Math.floor(rnd() * 8), depth = 0.12 + rnd() * 0.18;
          for (let j = i; j < Math.min(LEN, i + len); j++) a[j] *= depth;
        }
        return a;
      },
    },
    lte: {
      name: '4G в дороге', rtt: 0.055,
      desc: 'Медиана около 3 Мбит/с, сильные колебания и передачи между сотами',
      gen(rnd) {
        const a = ar1(rnd, LEN, 3.0 * M, 0.6, 0.93);
        for (let i = 20; i < LEN; i += 30 + Math.floor(rnd() * 30)) a[i] *= 0.08;
        return a;
      },
    },
    hsdpa: {
      name: '3G в электричке', rtt: 0.11,
      desc: 'По мотивам трасс HSDPA из Осло (Riiser и др., 2013): медиана ~1 Мбит/с, провалы до нуля',
      gen(rnd) {
        const a = ar1(rnd, LEN, 1.0 * M, 0.7, 0.9);
        for (let i = 30; i < LEN; i += 55 + Math.floor(rnd() * 30)) {
          const len = 4 + Math.floor(rnd() * 10);
          for (let j = i; j < Math.min(LEN, i + len); j++) a[j] = 0.03 * M + 0.05 * M * rnd();
        }
        return a;
      },
    },
    tunnel: {
      name: 'Метро и тоннели', rtt: 0.06,
      desc: '4 Мбит/с, а каждые ~25 с сигнал пропадает на 6–9 с',
      gen(rnd) {
        const a = Float64Array.from({ length: LEN }, () => 4 * M * (0.85 + 0.3 * rnd()));
        for (let i = 24; i < LEN; i += 46 + Math.floor(rnd() * 12)) {
          const len = 12 + Math.floor(rnd() * 6);
          for (let j = i; j < Math.min(LEN, i + len); j++) a[j] = 0;
        }
        return a;
      },
    },
    evening: {
      name: 'Вечерний пик', rtt: 0.045,
      desc: 'Домашний канал в 21:00: соседи тоже смотрят — 0,8–2,5 Мбит/с',
      gen(rnd) {
        const a = ar1(rnd, LEN, 1.5 * M, 0.35, 0.97);
        for (let i = 0; i < LEN; i++) a[i] *= 1 + 0.35 * Math.sin(i / LEN * Math.PI * 6);
        return a;
      },
    },
    steps: {
      name: 'Ступени', rtt: 0.03,
      desc: 'Учебная трасса: 3 → 0,8 → 1,6 → 0,35 → 3 Мбит/с по 20–25 с',
      gen() {
        const lv = [[40, 3], [44, 0.8], [40, 1.6], [36, 0.35], [80, 3]];
        const a = new Float64Array(LEN); let i = 0;
        for (const [n, v] of lv) for (let k = 0; k < n && i < LEN; k++) a[i++] = v * M;
        return a;
      },
    },
  };

  function makeTrace(id, seed) {
    const def = TRACES[id];
    const rnd = FJ.rng(seed || 7);
    return { id, name: def.name, desc: def.desc, rtt: def.rtt, step: STEP, bps: def.gen(rnd), period: LEN * STEP };
  }
  function customTrace(values, rtt) {
    return { id: 'custom', name: 'Своя трасса', desc: 'Нарисована вручную', rtt: rtt || 0.04, step: STEP, bps: Float64Array.from(values), period: values.length * STEP };
  }
  function capacityAt(tr, t) {
    const n = tr.bps.length;
    let i = Math.floor(t / tr.step) % n; if (i < 0) i += n;
    return tr.bps[i];
  }

  /* Загрузка одного объекта по трассе: возвращает момент окончания */
  function downloadEnd(tr, t0, bytes) {
    let t = t0 + tr.rtt, left = bytes * 8;
    for (let guard = 0; guard < 200000 && left > 0; guard++) {
      const c = capacityAt(tr, t);
      const next = (Math.floor(t / tr.step + 1e-9) + 1) * tr.step;
      const can = c * (next - t);
      if (can >= left) return t + left / c;
      left -= can; t = next;
    }
    return t;
  }

  /* Пошаговая передача для симуляции в реальном времени */
  class Transfer {
    constructor(tr, t0, bytes, meta) {
      this.tr = tr; this.t0 = t0; this.bytes = bytes; this.meta = meta || {};
      this.tFirst = t0 + tr.rtt; this.loaded = 0; this.done = false; this.tEnd = null;
    }
    /* Продвинуть до момента t1; возвращает true, если закончено */
    advance(t1) {
      if (this.done) return true;
      let t = Math.max(this.tFirst, this._t || this.t0);
      if (t1 <= t) { this._t = Math.max(this._t || 0, t1); return false; }
      const tr = this.tr;
      while (t < t1) {
        const c = capacityAt(tr, t);
        const next = Math.min(t1, (Math.floor(t / tr.step + 1e-9) + 1) * tr.step);
        const need = (this.bytes - this.loaded) * 8;
        const can = c * (next - t);
        if (can >= need) { this.loaded = this.bytes; this.tEnd = t + need / c; this.done = true; return true; }
        this.loaded += can / 8; t = next;
      }
      this._t = t1;
      return false;
    }
  }

  FJ.net = { TRACES, STEP, makeTrace, customTrace, capacityAt, downloadEnd, Transfer };
  if (typeof module !== 'undefined') module.exports = FJ.net;
})(typeof window !== 'undefined' ? window : globalThis);

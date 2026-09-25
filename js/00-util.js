/* =====================================================================
   00-util — пространство имён FJ, форматирование, случайность, цикл кадров,
   холсты с учётом DPR, активация фигур по видимости.
   Файл подключается и в браузере, и в node (для тестов чистой логики).
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};

  /* ---------- математика ---------- */
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invlerp = (a, b, x) => (x - a) / (b - a);
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = {
    out: t => 1 - Math.pow(1 - t, 3),
    inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  };
  FJ.math = { clamp, lerp, invlerp, smoothstep, ease };

  /* Детерминированный генератор (mulberry32) */
  FJ.rng = function (seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    const next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = (lo, hi) => lo + (hi - lo) * next();
    next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
    next.pick = arr => arr[Math.floor(next() * arr.length)];
    next.gauss = () => { const u = next() || 1e-9, v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return next;
  };

  /* ---------- форматирование по-русски ---------- */
  const NB = ' ';           // неразрывный пробел
  const MINUS = '−';
  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NB); }
  function num(x, digits) {
    if (!isFinite(x)) return '—';
    const d = digits == null ? (Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2) : digits;
    const neg = x < 0;
    let s = Math.abs(x).toFixed(d);
    let [i, f] = s.split('.');
    i = Math.abs(x) >= 10000 ? group(i) : i; // 1234 без разделителя, 12 345 с разделителем
    return (neg ? MINUS : '') + i + (f ? ',' + f : '');
  }
  function numAlways(x, digits) {
    if (!isFinite(x)) return '—';
    const neg = x < 0;
    let [i, f] = Math.abs(x).toFixed(digits || 0).split('.');
    return (neg ? MINUS : '') + group(i) + (f ? ',' + f : '');
  }
  FJ.fmt = {
    NB, MINUS, num, numAlways,
    int: x => numAlways(Math.round(x), 0),
    kbps: (bps, d) => numAlways(bps / 1000, d || 0) + NB + 'кбит/с',
    mbps: (bps, d) => num(bps / 1e6, d == null ? (bps >= 1e8 ? 0 : 1) : d) + NB + 'Мбит/с',
    rate(bps) {
      if (!isFinite(bps)) return '—';
      if (bps >= 1e12) return num(bps / 1e12, 1) + NB + 'Тбит/с';
      if (bps >= 1e9) return num(bps / 1e9, bps >= 1e11 ? 0 : 1) + NB + 'Гбит/с';
      if (bps >= 1e6) return num(bps / 1e6, bps >= 1e8 ? 0 : 1) + NB + 'Мбит/с';
      return numAlways(bps / 1e3, 0) + NB + 'кбит/с';
    },
    bytes(b) {
      if (!isFinite(b)) return '—';
      if (b >= 1e12) return num(b / 1e12, 1) + NB + 'ТБ';
      if (b >= 1e9) return num(b / 1e9, 1) + NB + 'ГБ';
      if (b >= 1e6) return num(b / 1e6, 1) + NB + 'МБ';
      if (b >= 1e3) return num(b / 1e3, b >= 1e5 ? 0 : 1) + NB + 'КБ';
      return Math.round(b) + NB + 'Б';
    },
    sec: (s, d) => num(s, d == null ? (s >= 10 ? 0 : 1) : d) + NB + 'с',
    ms: s => numAlways(s * 1000, 0) + NB + 'мс',
    pct: (x, d) => num(x * 100, d == null ? (Math.abs(x) >= 0.1 ? 0 : 1) : d) + NB + '%',
    db: (x, d) => num(x, d == null ? 1 : d) + NB + 'дБ',
    /* Таймкод без пропуска кадров: ЧЧ:ММ:СС:КК */
    tc(frame, fps) {
      fps = fps || 24;
      frame = Math.max(0, Math.floor(frame));
      const ff = frame % fps, s = Math.floor(frame / fps);
      const p = n => String(n).padStart(2, '0');
      return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60) + ':' + p(ff);
    },
    clock(sec) {
      const p = n => String(n).padStart(2, '0');
      sec = Math.max(0, sec);
      return p(Math.floor(sec / 60)) + ':' + p(Math.floor(sec) % 60);
    },
    plural(n, one, few, many) {
      const a = Math.abs(n) % 100, b = a % 10;
      if (a > 10 && a < 20) return many;
      if (b > 1 && b < 5) return few;
      if (b === 1) return one;
      return many;
    },
  };

  /* ---------- крошечная шина событий ---------- */
  FJ.emitter = function () {
    const map = new Map();
    return {
      on(evt, fn) { if (!map.has(evt)) map.set(evt, new Set()); map.get(evt).add(fn); return () => map.get(evt).delete(fn); },
      emit(evt, data) { const s = map.get(evt); if (s) for (const fn of [...s]) fn(data); },
    };
  };
  FJ.bus = FJ.emitter();

  /* ---------- безопасное хранилище ---------- */
  FJ.store = {
    get(k, d) { try { const v = root.localStorage.getItem('fj:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { root.localStorage.setItem('fj:' + k, JSON.stringify(v)); } catch (e) { /* хранилище недоступно — не страшно */ } },
  };

  /* Всё ниже нужно только в браузере */
  if (typeof document === 'undefined') { if (typeof module !== 'undefined') module.exports = FJ; return; }

  /* ---------- DOM ---------- */
  FJ.$ = (sel, el) => (el || document).querySelector(sel);
  FJ.$$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  FJ.h = function (tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') { for (const sk in v) { if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]); else el.style[sk] = v[sk]; } }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    if (children != null) for (const c of [].concat(children)) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  FJ.css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  /* Стили главы живут рядом с её кодом */
  FJ.addStyle = function (cssText) { const s = document.createElement('style'); s.textContent = cssText; document.head.append(s); return s; };

  /* Цвета для холстов — из токенов CSS */
  FJ.colors = {};
  FJ.readColors = function () {
    const names = ['ground', 'ground-2', 'panel', 'panel-2', 'bezel', 'line', 'line-2', 'text', 'text-2', 'muted', 'red', 'amber', 'blue', 'violet', 'q1', 'q2', 'q3', 'q4', 'q5'];
    for (const n of names) FJ.colors[n] = FJ.css('--' + n) || '#888';
    FJ.colors.q = [FJ.colors.q1, FJ.colors.q2, FJ.colors.q3, FJ.colors.q4, FJ.colors.q5];
  };
  FJ.alpha = function (hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };

  /* Шрифты холстов */
  FJ.font = {
    mono: (px, w) => `${w || 400} ${px}px "JetBrains Mono", ui-monospace, Menlo, monospace`,
    text: (px, w) => `${w || 400} ${px}px "Golos Text", "Segoe UI", system-ui, sans-serif`,
    display: (px, w) => `${w || 800} ${px}px "Sofia Sans Extra Condensed", "Arial Narrow", sans-serif`,
    led: (px, w) => `${w || 500} ${px}px "JetBrains Mono", monospace`,
  };

  /* ---------- холст с DPR и отслеживанием размера ---------- */
  FJ.canvas = function (host, opts) {
    opts = opts || {};
    const cv = host.tagName === 'CANVAS' ? host : host.appendChild(document.createElement('canvas'));
    const ctx = cv.getContext('2d', opts.ctx || undefined);
    const state = { cv, ctx, w: 0, h: 0, dpr: 1, onResize: opts.onResize || null };
    function fit() {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(opts.maxDpr || 2, root.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === state.w && h === state.h && dpr === state.dpr) return false;
      state.w = w; state.h = h; state.dpr = dpr;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (state.onResize) state.onResize(state);
      return true;
    }
    state.fit = fit;
    state.clear = function (color) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (color) { ctx.fillStyle = color; ctx.fillRect(0, 0, cv.width, cv.height); } else ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    };
    if (root.ResizeObserver) new ResizeObserver(() => fit()).observe(cv);
    fit();
    return state;
  };

  /* ---------- цикл кадров: один rAF на всю страницу ---------- */
  const tasks = new Set();
  let rafId = 0, last = 0, running = false;
  FJ.clock = { t: 0 }; // «страничные» секунды без учёта скрытой вкладки
  function tick(now) {
    rafId = root.requestAnimationFrame(tick);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    FJ.clock.t += dt;
    for (const fn of tasks) {
      try { fn(dt, FJ.clock.t); } catch (e) { tasks.delete(fn); if (root.console) console.error(e); }
    }
  }
  FJ.loop = {
    add(fn) { tasks.add(fn); if (!running) FJ.loop.start(); return () => tasks.delete(fn); },
    remove(fn) { tasks.delete(fn); },
    start() { if (running || document.hidden) return; running = true; last = 0; rafId = root.requestAnimationFrame(tick); },
    stop() { running = false; root.cancelAnimationFrame(rafId); },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { FJ.loop.stop(); FJ.bus.emit('hidden'); }
    else { FJ.loop.start(); FJ.bus.emit('visible'); }
  });

  /* ---------- фигуры: активны, только пока видны ---------- */
  const figures = [];
  FJ.figure = function (def) {
    // def: { id, el, mount(el), start(), stop(), frame(dt, t) }
    const fig = Object.assign({ active: false, mounted: false }, def);
    figures.push(fig);
    return fig;
  };
  FJ.figures = figures;
  FJ.bootFigures = function () {
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        const fig = en.target.__fig;
        if (!fig) continue;
        if (en.isIntersecting) activate(fig); else deactivate(fig);
      }
    }, { rootMargin: '200px 0px 200px 0px', threshold: 0 });
    for (const fig of figures) {
      if (!fig.el) continue;
      fig.el.__fig = fig;
      try { if (fig.mount && !fig.mounted) { fig.mount(fig.el); fig.mounted = true; } }
      catch (e) { console.error('mount', fig.id, e); }
      io.observe(fig.el);
    }
  };
  function activate(fig) {
    if (fig.active) return;
    fig.active = true;
    try { if (fig.start) fig.start(); } catch (e) { console.error('start', fig.id, e); }
    if (fig.frame) fig._rm = FJ.loop.add(fig.frame);
  }
  function deactivate(fig) {
    if (!fig.active) return;
    fig.active = false;
    if (fig._rm) { fig._rm(); fig._rm = null; }
    try { if (fig.stop) fig.stop(); } catch (e) { console.error('stop', fig.id, e); }
  }

  /* ---------- сегментированные кнопки ---------- */
  FJ.seg = function (host, items, value, onChange, opts) {
    // items: [{v, label, chip}] ; value: текущее
    host.classList.add('seg');
    if (opts && opts.small) host.classList.add('small');
    host.setAttribute('role', 'group');
    host.innerHTML = '';
    const btns = items.map(it => {
      const b = FJ.h('button', { type: 'button', 'aria-pressed': String(it.v === value), title: it.title || null });
      if (it.chip) b.append(FJ.h('span', { class: 'chip', style: { '--c': it.chip } }));
      b.append(it.label);
      b.addEventListener('click', () => { set(it.v); onChange(it.v); });
      host.append(b);
      return b;
    });
    function set(v) { btns.forEach((b, i) => b.setAttribute('aria-pressed', String(items[i].v === v))); }
    return { set, buttons: btns };
  };

  /* ---------- ползунок ---------- */
  FJ.slider = function (host, o) {
    // o: {id, label, min, max, step, value, fmt(v), onInput(v)}
    host.classList.add('slider');
    const val = FJ.h('span', { class: 'slider__val' });
    const inp = FJ.h('input', { type: 'range', id: o.id, min: o.min, max: o.max, step: o.step || 1, value: o.value, 'aria-label': o.label });
    host.append(FJ.h('div', { class: 'slider__top' }, [FJ.h('label', { class: 'ctl-label', for: o.id, text: o.label }), val]), inp);
    function paint() {
      const v = +inp.value;
      inp.style.setProperty('--p', ((v - o.min) / (o.max - o.min) * 100) + '%');
      val.textContent = o.fmt ? o.fmt(v) : String(v);
    }
    inp.addEventListener('input', () => { paint(); o.onInput && o.onInput(+inp.value); });
    paint();
    return { input: inp, set(v) { inp.value = v; paint(); }, get value() { return +inp.value; } };
  };

  /* ---------- переключатель ---------- */
  FJ.toggle = function (host, o) {
    const inp = FJ.h('input', { type: 'checkbox', id: o.id });
    inp.checked = !!o.value;
    const lab = FJ.h('label', { class: 'toggle', for: o.id }, [inp, FJ.h('span', { class: 'toggle__box' }), FJ.h('span', { text: o.label })]);
    host.append(lab);
    inp.addEventListener('change', () => o.onChange && o.onChange(inp.checked));
    return { input: inp, set(v) { inp.checked = !!v; } };
  };

  /* ---------- уступить главный поток ---------- */
  const mc = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
  const pending = [];
  if (mc) mc.port1.onmessage = () => { const f = pending.shift(); if (f) f(); };
  FJ.yield = function () {
    if (root.scheduler && root.scheduler.yield) return root.scheduler.yield();
    return new Promise(r => { if (mc) { pending.push(r); mc.port2.postMessage(0); } else setTimeout(r, 0); });
  };
  FJ.sleep = ms => new Promise(r => setTimeout(r, ms));

  if (typeof module !== 'undefined') module.exports = FJ;
})(typeof window !== 'undefined' ? window : globalThis);

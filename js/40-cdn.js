/* =====================================================================
   40-cdn — модель раздачи (чистая логика, тестируется в node).

   Топология: ориджин в Москве → два шилда (Москва, Новосибирск) →
   14 узлов у провайдеров в крупных городах. Зрители каждого города
   идут на ближайший живой узел (с учётом ёмкости), узел — на ближайший
   живой шилд. RTT = 2 × расстояние по дуге × 1,5 (маршрут) / 200 км/мс.
   Часы модели — московские; суточная кривая и окно заливки у каждого
   города — по его местному времени (Владивосток — МСК+7).

   Кэши: каталог N тайтлов, популярность по Ципфу p_i ∝ i^−α.
   LRU — аппроксимация Че: t_C из Σ(1 − e^(−p_i·t_C)) = C,
         доля попаданий h = Σ p_i (1 − e^(−p_i·t_C)).
   Предзаливка — top-C по прогнозу; прогноз = истинная популярность ×
         логнормальная ошибка e^(σ·ε). Вероятность попасть в набор
         Φ((ln p_i − θ)/σ), порог θ из Σ Φ(…) = C (приближение
         «среднего поля», как у Че).
   Шилд — LRU по потоку промахов узлов q_i ∝ p_i (1 − h_i) (иерархическая
         модель Че; поток промахов считаем независимым — приближение).

   Премьера: вспышка стартов в 00:00. Если серии нет на узлах, каждый
   «передний» сегмент (его первыми просят самые ранние зрители) — промах.
   Без схлопывания наверх уходят все запросы, пришедшие за время промаха F:
   ≈ 1 + λ·F. Со схлопыванием — один, пока F < proxy_cache_lock_timeout.
   Ориджин — очередь с ёмкостью μ: чем больше запросов, тем больше F —
   и тем больше дублей (положительная обратная связь).
   Все числа нагрузки иллюстративные.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};

  /* ---------------- константы модели ---------------- */
  const K = {
    N_TITLES: 20000,        // тайтлов в каталоге
    TITLE_GB: 20,           // средний тайтл со всеми качествами и кодеками, ГБ (модель)
    SHIELD_PCT: 90,         // кэш шилда, % каталога
    BITRATE: 5e6,           // средний битрейт потока, бит/с
    SEG_DUR: 2,             // сегмент, с
    SEG_BITS: 1e7,          // 2 с × 5 Мбит/с = 10 Мбит = 1,25 МБ
    PEAK_VIEWERS: 700000,   // одновременных потоков в пик страны, ~21:00 МСК (иллюстративно)
    SERVER_GBPS: 200,       // один сервер узла, Гбит/с (иллюстративно)
    HEADROOM: 1.3,          // запас ёмкости узла над пиком своего региона
    STEER_LIMIT: 0.95,      // выше этой загрузки направление переливает зрителей дальше
    SHIELD_SERVERS: [6, 2], // Москва, Новосибирск
    ORIGIN_GBPS: 120,       // ёмкость ориджина (хранилище + упаковщик), Гбит/с
    ORIGIN_T0: 0.12,        // первый байт ориджина: чтение из хранилища и упаковка, с
    T_XFER: 0.001,          // передача 1,25 МБ по магистрали 10 Гбит/с, с
    HOP_RTTS: 2,            // RTT на ярус: запрос и разгон окна TCP после простоя
    Q_MAX_S: 10,            // очередь ориджина не длиннее 10 с (дальше — отказы 503)
    ROUTE: 1.5,             // коэффициент маршрута: путь по оптике длиннее дуги
    FIBER: 200,             // км/мс в оптике (≈ 2/3 c)
    LOCAL_MS: 0.5,          // RTT внутри города (без последней мили), мс
    FILL: [2, 14],          // окно заливки Open Connect по умолчанию, ч
    FILL_CHURN: 0.05,       // доля набора узла, которую обновляют за ночь (модель)
    SESSION_S: 2400,        // средний сеанс просмотра, с (для перевода t_C в минуты)
    RHO: 0.8,               // перенесённая аудитория: хит-рейт × 0,8, пока кэш не подстроится
    VARIANTS: 4,            // вариантов сегмента, которые реально запрашивают (качества)
    BUNDLE: 5,              // старт: манифест, init и три сегмента
    LOCK_TIMEOUT: 5,        // nginx proxy_cache_lock_timeout, с (по умолчанию)
    LOCK_AGE: 5,            // nginx proxy_cache_lock_age, с (по умолчанию)
    PREM_BURST: 60000,      // зрителей стартуют в первые секунды после 00:00
    PREM_TAU_BURST: 1,      // с
    PREM_WAVE: 200000,      // ещё столько — в течение часа
    PREM_TAU_WAVE: 1200,    // с
    PREM_EPISODE: 2700,     // длина серии, с
  };

  /* ---------------- города (население — примерное, тыс.) ---------------- */
  // Москва разделена на две зоны: у каждой свой узел. tz — часы от Москвы:
  // вечерний пик и окно заливки у каждого города — по местному времени.
  const REGIONS = [
    { id: 'msk-w', name: 'Москва (запад)', lat: 55.77, lon: 37.40, tz: 0, pop: 6575, city: 'msk' },
    { id: 'msk-e', name: 'Москва (восток)', lat: 55.74, lon: 37.85, tz: 0, pop: 6575, city: 'msk' },
    { id: 'spb', name: 'Санкт‑Петербург', lat: 59.9386, lon: 30.3141, tz: 0, pop: 5600 },
    { id: 'nn', name: 'Нижний Новгород', lat: 56.3269, lon: 44.0059, tz: 0, pop: 1200 },
    { id: 'kzn', name: 'Казань', lat: 55.7887, lon: 49.1221, tz: 0, pop: 1320 },
    { id: 'smr', name: 'Самара', lat: 53.1959, lon: 50.1002, tz: 1, pop: 1160 },
    { id: 'rnd', name: 'Ростов‑на‑Дону', lat: 47.2357, lon: 39.7015, tz: 0, pop: 1140 },
    { id: 'krd', name: 'Краснодар', lat: 45.0355, lon: 38.9753, tz: 0, pop: 1150 },
    { id: 'ekb', name: 'Екатеринбург', lat: 56.8389, lon: 60.6057, tz: 2, pop: 1540 },
    { id: 'chl', name: 'Челябинск', lat: 55.1644, lon: 61.4368, tz: 2, pop: 1180 },
    { id: 'nsk', name: 'Новосибирск', lat: 55.0084, lon: 82.9357, tz: 4, pop: 1640 },
    { id: 'krs', name: 'Красноярск', lat: 56.0153, lon: 92.8932, tz: 4, pop: 1210 },
    { id: 'irk', name: 'Иркутск', lat: 52.2870, lon: 104.3050, tz: 5, pop: 620 },
    { id: 'vvo', name: 'Владивосток', lat: 43.1155, lon: 131.8855, tz: 7, pop: 600 },
    { id: 'vrn', name: 'Воронеж', lat: 51.6720, lon: 39.1843, tz: 0, pop: 1050 },
    { id: 'vlg', name: 'Волгоград', lat: 48.7080, lon: 44.5133, tz: 0, pop: 1020 },
    { id: 'srt', name: 'Саратов', lat: 51.5331, lon: 46.0342, tz: 1, pop: 890 },
    { id: 'ufa', name: 'Уфа', lat: 54.7388, lon: 55.9721, tz: 2, pop: 1160 },
    { id: 'prm', name: 'Пермь', lat: 58.0105, lon: 56.2502, tz: 2, pop: 1030 },
    { id: 'tmn', name: 'Тюмень', lat: 57.1530, lon: 65.5343, tz: 2, pop: 850 },
    { id: 'oms', name: 'Омск', lat: 54.9885, lon: 73.3242, tz: 3, pop: 1100 },
    { id: 'khv', name: 'Хабаровск', lat: 48.4827, lon: 135.0838, tz: 7, pop: 620 },
  ];
  // Узлы у провайдеров (кэши в сетях операторов и региональные точки)
  const EDGES = [
    { id: 'msk1', code: 'МСК‑1', city: 'Москва', lat: 55.77, lon: 37.45, tz: 0 },
    { id: 'msk2', code: 'МСК‑2', city: 'Москва', lat: 55.74, lon: 37.80, tz: 0 },
    { id: 'spb', code: 'СПБ', city: 'Санкт‑Петербург', lat: 59.9386, lon: 30.3141, tz: 0 },
    { id: 'nn', code: 'НН', city: 'Нижний Новгород', lat: 56.3269, lon: 44.0059, tz: 0 },
    { id: 'kzn', code: 'КЗН', city: 'Казань', lat: 55.7887, lon: 49.1221, tz: 0 },
    { id: 'smr', code: 'СМР', city: 'Самара', lat: 53.1959, lon: 50.1002, tz: 1 },
    { id: 'rnd', code: 'РНД', city: 'Ростов‑на‑Дону', lat: 47.2357, lon: 39.7015, tz: 0 },
    { id: 'krd', code: 'КРД', city: 'Краснодар', lat: 45.0355, lon: 38.9753, tz: 0 },
    { id: 'ekb', code: 'ЕКБ', city: 'Екатеринбург', lat: 56.8389, lon: 60.6057, tz: 2 },
    { id: 'chl', code: 'ЧЛБ', city: 'Челябинск', lat: 55.1644, lon: 61.4368, tz: 2 },
    { id: 'nsk', code: 'НСК', city: 'Новосибирск', lat: 55.0084, lon: 82.9357, tz: 4 },
    { id: 'krs', code: 'КРСК', city: 'Красноярск', lat: 56.0153, lon: 92.8932, tz: 4 },
    { id: 'irk', code: 'ИРК', city: 'Иркутск', lat: 52.2870, lon: 104.3050, tz: 5 },
    { id: 'vvo', code: 'ВЛД', city: 'Владивосток', lat: 43.1155, lon: 131.8855, tz: 7 },
  ];
  const SHIELDS = [
    { id: 's-msk', code: 'ШИЛД МСК', city: 'Москва', lat: 55.7558, lon: 37.6173 },
    { id: 's-nsk', code: 'ШИЛД НСК', city: 'Новосибирск', lat: 55.0084, lon: 82.9357 },
  ];
  const ORIGIN = { id: 'origin', code: 'ОРИДЖИН', city: 'Москва', lat: 55.7558, lon: 37.6173 };

  /* ---------------- география ---------------- */
  const RAD = Math.PI / 180;
  function km(a, b) {
    const dl = (b.lat - a.lat) * RAD, dn = (b.lon - a.lon) * RAD;
    const s = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dn / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  /* RTT по оптике, мс: туда и обратно по пути в ROUTE раз длиннее дуги */
  function rttMs(d) { return K.LOCAL_MS + 2 * d * K.ROUTE / K.FIBER; }
  /* Равнопромежуточная коническая проекция (φ1 = 50°, φ2 = 62°, λ0 = 83°).
     Возвращает единичные координаты; y растёт вниз (как на экране). */
  const PJ = (function () {
    const p1 = 50 * RAD, p2 = 62 * RAD;
    const n = (Math.cos(p1) - Math.cos(p2)) / (p2 - p1);
    return { n, G: Math.cos(p1) / n + p1, l0: 83 };
  })();
  function project(lat, lon) {
    const rho = PJ.G - lat * RAD, th = PJ.n * (lon - PJ.l0) * RAD;
    return { x: rho * Math.sin(th), y: rho * Math.cos(th) };
  }

  /* ---------------- генератор случайных чисел (mulberry32) ---------------- */
  function rng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- каталог и кэши ---------------- */
  function zipf(alpha, N) {
    const p = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { p[i] = Math.pow(i + 1, -alpha); s += p[i]; }
    for (let i = 0; i < N; i++) p[i] /= s;
    return p;
  }

  /* Каталог группами: первые 200 рангов по одному, дальше — геометрические
     корзины с шагом 2 %. p — средняя вероятность тайтла в группе, w — число
     тайтлов. Для N ≤ 5000 (и по запросу) — точный, по одному тайтлу. */
  const catCache = new Map();
  function catalog(alpha, N, opts) {
    const exact = !!(opts && opts.exact) || N <= 5000;
    const key = alpha.toFixed(4) + ':' + N + ':' + (exact ? 'x' : 'b');
    const hit = catCache.get(key);
    if (hit) return hit;
    const pw = new Float64Array(N);
    let H = 0;
    for (let i = 0; i < N; i++) { pw[i] = Math.pow(i + 1, -alpha); H += pw[i]; }
    let p, w;
    if (exact) {
      p = new Float64Array(N); w = new Float64Array(N);
      for (let i = 0; i < N; i++) { p[i] = pw[i] / H; w[i] = 1; }
    } else {
      const P = [], W = [];
      let i = 0;
      while (i < N) {
        const len = i < 200 ? 1 : Math.max(1, Math.floor(i * 0.02));
        const j = Math.min(N, i + len);
        let s = 0;
        for (let k = i; k < j; k++) s += pw[k];
        P.push(s / (j - i) / H); W.push(j - i);
        i = j;
      }
      p = Float64Array.from(P); w = Float64Array.from(W);
    }
    const cat = { alpha, N, n: p.length, p, w, exact };
    if (catCache.size > 24) catCache.clear();
    catCache.set(key, cat);
    return cat;
  }

  /* Время Че: Σ w_g (1 − e^(−q_g·t)) = C. q — вероятности групп (по умолчанию p).
     Если C не меньше числа тайтлов с q > 0, всё помещается: t = ∞. */
  function cheT(cat, C, q) {
    q = q || cat.p;
    const w = cat.w, n = cat.n;
    if (!(C > 0)) return 0;
    let room = 0;
    for (let g = 0; g < n; g++) if (q[g] > 0) room += w[g];
    if (C >= room - 1e-9) return Infinity;
    const occ = t => { let s = 0; for (let g = 0; g < n; g++) s -= w[g] * Math.expm1(-q[g] * t); return s; };
    let lo = 0, hi = Math.max(1, C);
    while (occ(hi) < C) { lo = hi; hi *= 2; }
    for (let it = 0; it < 80; it++) {
      const mid = 0.5 * (lo + hi);
      if (occ(mid) < C) lo = mid; else hi = mid;
      if (hi - lo < 1e-10 * hi) break;
    }
    return 0.5 * (lo + hi);
  }
  /* Попадания LRU по Че для потока q: {hit, t, hi[] — вероятность попадания по группам} */
  function lruStats(cat, C, q, wantPer) {
    q = q || cat.p;
    const t = cheT(cat, C, q), n = cat.n, w = cat.w;
    const per = wantPer ? new Float64Array(n) : null;
    let h = 0;
    for (let g = 0; g < n; g++) {
      const x = t === Infinity ? (q[g] > 0 ? 1 : 0) : -Math.expm1(-q[g] * t);
      if (per) per[g] = x;
      h += w[g] * q[g] * x;
    }
    return { hit: h, t, per };
  }
  function hitLRU(alpha, N, C, opts) { return lruStats(catalog(alpha, N, opts), C).hit; }

  /* Нормальная функция распределения (Абрамовиц — Стиган 7.1.26) */
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));

  /* Предзаливка: вероятность каждой группы оказаться в наборе из C тайтлов
     по прогнозу с логнормальной ошибкой σ. σ = 0 — идеальный прогноз. */
  function prefillIn(cat, C, sigma) {
    const n = cat.n, p = cat.p, w = cat.w, inS = new Float64Array(n);
    if (!(C > 0)) return inS;
    if (C >= cat.N) { inS.fill(1); return inS; }
    if (!(sigma > 1e-6)) {
      let left = C;
      for (let g = 0; g < n && left > 0; g++) { const take = Math.min(w[g], left); inS[g] = take / w[g]; left -= take; }
      return inS;
    }
    const lp = new Float64Array(n);
    for (let g = 0; g < n; g++) lp[g] = Math.log(p[g]);
    const count = th => { let c = 0; for (let g = 0; g < n; g++) c += w[g] * Phi((lp[g] - th) / sigma); return c; };
    let lo = lp[n - 1] - 12 * sigma, hi = lp[0] + 12 * sigma;
    for (let it = 0; it < 50; it++) {
      const mid = 0.5 * (lo + hi);
      if (count(mid) > C) lo = mid; else hi = mid;
    }
    const th = 0.5 * (lo + hi);
    for (let g = 0; g < n; g++) inS[g] = Phi((lp[g] - th) / sigma);
    return inS;
  }
  function prefillStats(cat, C, sigma) {
    const inS = prefillIn(cat, C, sigma);
    let h = 0;
    for (let g = 0; g < cat.n; g++) h += cat.w[g] * cat.p[g] * inS[g];
    return { hit: h, per: inS };
  }
  function hitPrefill(alpha, N, C, noise, opts) { return prefillStats(catalog(alpha, N, opts), C, noise || 0).hit; }

  /* Кривые «размер кэша → доля попаданий» для графика: параметрически,
     без подбора корней. x — доля каталога, y — доля попаданий. */
  function curves(alpha, N, sigma, pts) {
    const cat = catalog(alpha, N), n = cat.n, p = cat.p, w = cat.w;
    pts = pts || 160;
    const lru = [], pre = [], ideal = [];
    // LRU: t пробегает логарифмическую сетку
    const t0 = 0.05 / p[0], t1 = 60 / p[n - 1];
    for (let k = 0; k <= pts; k++) {
      const t = t0 * Math.pow(t1 / t0, k / pts);
      let c = 0, h = 0;
      for (let g = 0; g < n; g++) { const x = -Math.expm1(-p[g] * t); c += w[g] * x; h += w[g] * p[g] * x; }
      lru.push([c / N, h]);
    }
    // идеальный прогноз: верхние C тайтлов
    let c = 0, h = 0;
    ideal.push([0, 0]);
    for (let g = 0; g < n; g++) { c += w[g]; h += w[g] * p[g]; ideal.push([c / N, h]); }
    // предзаливка с ошибкой σ: порог θ пробегает сетку
    if (sigma > 1e-6) {
      const lp = new Float64Array(n);
      for (let g = 0; g < n; g++) lp[g] = Math.log(p[g]);
      const a = lp[0] + 5 * sigma, b = lp[n - 1] - 5 * sigma;
      for (let k = 0; k <= pts; k++) {
        const th = a + (b - a) * k / pts;
        let cc = 0, hh = 0;
        for (let g = 0; g < n; g++) { const x = Phi((lp[g] - th) / sigma); cc += w[g] * x; hh += w[g] * p[g] * x; }
        pre.push([cc / N, hh]);
      }
    } else pre.push(...ideal);
    return { lru, prefill: pre, ideal };
  }

  /* Ярусы: узел (LRU или предзаливка) → шилд (LRU по потоку промахов).
     Возвращает доли попаданий и долю запросов, дошедших до ориджина. */
  function tier(o) {
    const cat = catalog(o.alpha, o.N || K.N_TITLES);
    const N = cat.N, C = o.C, Cs = o.Cs != null ? o.Cs : Math.round(N * K.SHIELD_PCT / 100);
    const lru = lruStats(cat, C, null, true);
    const pre = o.mode === 'prefill' ? prefillStats(cat, C, o.sigma || 0) : null;
    const per = pre ? pre.per : lru.per;
    const hEdge = pre ? pre.hit : lru.hit;
    const q = new Float64Array(cat.n);
    let z = 0;
    for (let g = 0; g < cat.n; g++) { q[g] = cat.p[g] * (1 - per[g]); z += cat.w[g] * q[g]; }
    if (z > 0) for (let g = 0; g < cat.n; g++) q[g] /= z;
    const hShield = z > 1e-12 ? lruStats(cat, Cs, q).hit : 1;
    const hShieldDirect = lruStats(cat, Cs).hit;
    return {
      hEdge, hShield, hShieldDirect, tC: lru.t,
      hLRU: lru.hit, hPrefill: pre ? pre.hit : prefillStats(cat, C, o.sigma || 0).hit,
      fOrigin: (1 - hEdge) * (1 - hShield),
    };
  }

  /* Прямая симуляция LRU (для проверки аппроксимации Че) */
  function sampleCdf(cdf, u) {
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
    return lo;
  }
  function simulateLRU(alpha, N, C, nReq, seed, warm) {
    const p = zipf(alpha, N), cdf = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { s += p[i]; cdf[i] = s; }
    cdf[N - 1] = 1;
    const r = rng(seed || 1);
    const prev = new Int32Array(N).fill(-1), next = new Int32Array(N).fill(-1), inC = new Uint8Array(N);
    let head = -1, tail = -1, size = 0, hits = 0, counted = 0;
    warm = warm == null ? Math.min(nReq / 5, 20 * C) : warm;
    for (let k = 0; k < nReq; k++) {
      const i = sampleCdf(cdf, r());
      let hit = false;
      if (inC[i]) {
        hit = true;
        if (head !== i) { // вынуть и поставить в голову
          const a = prev[i], b = next[i];
          if (a >= 0) next[a] = b;
          if (b >= 0) prev[b] = a; else tail = a;
          prev[i] = -1; next[i] = head; prev[head] = i; head = i;
        }
      } else {
        inC[i] = 1; prev[i] = -1; next[i] = head;
        if (head >= 0) prev[head] = i; head = i;
        if (tail < 0) tail = i;
        if (++size > C) { // вытеснить хвост
          const v = tail; tail = prev[v];
          if (tail >= 0) next[tail] = -1;
          inC[v] = 0; prev[v] = next[v] = -1; size--;
        }
      }
      if (k >= warm) { counted++; if (hit) hits++; }
    }
    return hits / counted;
  }
  /* Статический набор из C самых популярных по зашумлённому прогнозу (Монте-Карло) */
  function simulatePrefill(alpha, N, C, sigma, seed) {
    const p = zipf(alpha, N), r = rng(seed || 3);
    const idx = new Array(N), sc = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const u = r() || 1e-12, v = r();
      sc[i] = Math.log(p[i]) + (sigma || 0) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      idx[i] = i;
    }
    idx.sort((a, b) => sc[b] - sc[a]);
    let h = 0;
    for (let k = 0; k < C; k++) h += p[idx[k]];
    return h;
  }

  /* ---------------- схлопывание запросов ----------------
     Поштучно: сколько запросов к одному объекту уйдёт наверх.
     arrivals — отсортированные моменты запросов к объекту на одном узле;
     F — время промаха (число или функция от момента старта загрузки).
     collapse=true — как proxy_cache_lock: один запрос наполняет кэш,
     остальные ждут; ждавший дольше lockTimeout идёт наверх сам (ответ не
     кэшируется); загрузка дольше lockAge разрешает ещё один наполняющий. */
  function upstreamRequests(arrivals, F, o) {
    o = o || {};
    const collapse = !!o.collapse;
    const lockTimeout = o.lockTimeout != null ? o.lockTimeout : K.LOCK_TIMEOUT;
    const lockAge = o.lockAge != null ? o.lockAge : K.LOCK_AGE;
    const fetch = typeof F === 'function' ? F : () => F;
    let cachedAt = Infinity, lockStart = -Infinity, lockEnd = -Infinity, up = 0;
    for (const a of arrivals) {
      if (a >= cachedAt) continue;                        // попадание
      if (!collapse) { up++; cachedAt = Math.min(cachedAt, a + fetch(a)); continue; }
      if (a >= lockEnd || a - lockStart >= lockAge) {     // замка нет или он «устарел»
        up++; lockStart = a; lockEnd = a + fetch(a); cachedAt = Math.min(cachedAt, lockEnd);
        continue;
      }
      if (cachedAt - a > lockTimeout) up++;               // не дождался — пошёл сам
    }
    return up;
  }
  /* То же в среднем: λ — частота запросов к объекту, F — время промаха */
  function upstreamFluid(lambda, F, o) {
    o = o || {};
    const lockTimeout = o.lockTimeout != null ? o.lockTimeout : K.LOCK_TIMEOUT;
    const lockAge = o.lockAge != null ? o.lockAge : K.LOCK_AGE;
    if (!o.collapse) return 1 + lambda * F;
    return 1 + Math.floor(F / lockAge + 1e-9) * (F > lockAge ? 1 : 0) + lambda * Math.max(0, F - lockTimeout);
  }

  /* ---------------- суточная кривая (иллюстративно) ----------------
     Вечерний пик около 21:00, минимум ~12 % около 03:30. */
  const vm = (h, mu, k) => Math.exp(k * (Math.cos(2 * Math.PI * (h - mu) / 24) - 1));
  const DAY_NORM = 0.76565;
  function dayShape(h) {
    h = ((h % 24) + 24) % 24;
    return (0.07 + 0.62 * vm(h, 20.85, 6.5) + 0.17 * vm(h, 23.2, 9) + 0.20 * vm(h, 14, 1.3) + 0.05 * vm(h, 9, 6)) / DAY_NORM;
  }
  const inFill = h => { h = ((h % 24) + 24) % 24; return h >= K.FILL[0] && h < K.FILL[1]; };
  /* Веса зрителей ∝ населению; страна — сумма городских кривых в местном времени,
     нормированная так, чтобы её максимум (около 21:00 по Москве) был PEAK_VIEWERS */
  const POP = REGIONS.reduce((a, x) => a + x.pop, 0);
  const W_REG = Float64Array.from(REGIONS, x => x.pop / POP);
  function nationShape(hMsk) { let v = 0; for (let r = 0; r < REGIONS.length; r++) v += W_REG[r] * dayShape(hMsk + REGIONS[r].tz); return v; }
  const NAT_MAX = (function () { let mx = 0; for (let x = 0; x < 24; x += 0.02) mx = Math.max(mx, nationShape(x)); return mx; })();
  const VIEW_SCALE = K.PEAK_VIEWERS / NAT_MAX;      // зрителей на единицу веса в местный пик

  /* Премьера: интенсивность стартов (зрителей в секунду) и их накопленное число */
  const premRate = u => (u < 0 ? 0 : K.PREM_BURST / K.PREM_TAU_BURST * Math.exp(-u / K.PREM_TAU_BURST) + K.PREM_WAVE / K.PREM_TAU_WAVE * Math.exp(-u / K.PREM_TAU_WAVE));
  const premCum = u => (u <= 0 ? 0 : K.PREM_BURST * -Math.expm1(-u / K.PREM_TAU_BURST) + K.PREM_WAVE * -Math.expm1(-u / K.PREM_TAU_WAVE));

  /* =====================================================================
     Симуляция сети раздачи
     Узлы: 0..E−1 — узлы у провайдеров, E..E+S−1 — шилды, E+S — ориджин.
     Шаг: направление зрителей → попадания узлов → промахи к шилдам →
     промахи шилдов к ориджину → лавина премьеры и очередь ориджина →
     сводка. Время — модельные секунды от полуночи первого дня.
     ===================================================================== */
  const E = EDGES.length, S = SHIELDS.length, R = REGIONS.length, NN = E + S + 1, OR = E + S;
  const G_PER_VIEWER = K.BITRATE / 1e9;                 // Гбит/с на один поток
  const MU = K.ORIGIN_GBPS * 1e9 / K.SEG_BITS;          // ёмкость ориджина, запросов/с

  class Sim {
    constructor(o) {
      o = o || {};
      this.p = { mode: 'lru', cPct: 50, alpha: 0.8, sigma: 0.5, collapse: false };
      for (const k in this.p) if (k in o) this.p[k] = o[k];
      this.t = o.t != null ? o.t : 21 * 3600;
      /* геометрия и задержки */
      const nodes = EDGES.concat(SHIELDS, [ORIGIN]);
      this.nodes = nodes;
      this.rttRN = new Float64Array(R * NN);
      for (let r = 0; r < R; r++) for (let n = 0; n < NN; n++) this.rttRN[r * NN + n] = rttMs(km(REGIONS[r], nodes[n]));
      this.rttES = new Float64Array(E * S);
      for (let e = 0; e < E; e++) for (let s = 0; s < S; s++) this.rttES[e * S + s] = rttMs(km(EDGES[e], SHIELDS[s]));
      this.rttSO = Float64Array.from(SHIELDS, s => rttMs(km(s, ORIGIN)));
      this.rttEO = Float64Array.from(EDGES, e => rttMs(km(e, ORIGIN)));
      this.prefE = REGIONS.map((_, r) => EDGES.map((_, e) => e).sort((a, b) => this.rttRN[r * NN + a] - this.rttRN[r * NN + b]));
      this.prefS = REGIONS.map((_, r) => SHIELDS.map((_, s) => s).sort((a, b) => this.rttRN[r * NN + E + a] - this.rttRN[r * NN + E + b]));
      this.w = W_REG;                                          // веса зрителей ∝ населению
      this.tz = Int8Array.from(REGIONS, x => x.tz);
      this.etz = Int8Array.from(EDGES, x => x.tz);
      this.vr = new Float64Array(R);                           // зрителей в регионе сейчас
      this.pr = new Float64Array(R);                           // из них смотрят премьеру
      this.premW = new Float64Array(R);                        // доли зрителей премьеры по регионам
      this.home = Int16Array.from(this.prefE, pr => pr[0]);    // «свой» (ближайший) узел региона
      /* ёмкость: пик своих регионов × запас, округлённо до серверов по 200 Гбит/с */
      this.servers = new Int16Array(NN);
      this.cap = new Float64Array(NN);
      const peakG = VIEW_SCALE * G_PER_VIEWER;              // у каждого города пик — в его 21:00
      for (let e = 0; e < E; e++) {
        let d = 0;
        for (let r = 0; r < R; r++) if (this.home[r] === e) d += this.w[r] * peakG;
        this.servers[e] = Math.max(1, Math.ceil(d * K.HEADROOM / K.SERVER_GBPS));
        this.cap[e] = this.servers[e] * K.SERVER_GBPS;
      }
      for (let s = 0; s < S; s++) { this.servers[E + s] = K.SHIELD_SERVERS[s]; this.cap[E + s] = K.SHIELD_SERVERS[s] * K.SERVER_GBPS; }
      this.cap[OR] = K.ORIGIN_GBPS;
      /* состояние */
      this.alive = new Uint8Array(NN).fill(1);
      this.A = new Float64Array(R * NN);          // Гбит/с региона r, отданные узлом n
      this.warm = new Float32Array(R * E);        // прогрев кэша узла e под чужой регион r (0…1)
      this.edgeShield = new Int16Array(E);        // куда узел ходит за промахами (индекс узла)
      this.order = new Int16Array(R);
      this.load = new Float64Array(NN);           // отдача зрителям, Гбит/с
      this.hitG = new Float64Array(E);            // из неё — из кэша
      this.upG = new Float64Array(NN);            // промахи наверх, Гбит/с
      this.inG = new Float64Array(NN);            // поток промахов снизу, Гбит/с
      this.fillG = new Float64Array(NN);          // ночная заливка, Гбит/с (к узлу)
      this.stormRps = new Float64Array(E);        // лавина премьеры от узла, запросов/с
      this.stormSRps = new Float64Array(S);       // лавина от шилда к ориджину, запросов/с
      this._accS = new Float64Array(S);
      this.share = new Float64Array(E);           // доля зрителей премьеры на узле
      this.stT0 = new Float64Array(E);            // передний край премьеры: начало шага,
      this.stF = new Float64Array(E);             //   время промаха этого шага,
      this.stB = new Float64Array(E);             //   объектов на зрителя (старт — пачка)
      this._shF = new Float64Array(S);
      this._pairs = new Float64Array(R * NN * 2);
      this._idx = [];
      this._cmp = (a, b) => this._pairs[2 * a] - this._pairs[2 * b];
      this._rE = 0; this._rO = 0;
      this._premM = { u: 0, prefilled: false, storm: false, F: 0, dup: 0, waiting: 0, stall: 0, peakRps: 0, maxF: 0 };
      this.prem = null;
      this.q = 0;                                 // очередь ориджина, запросов
      this.m = { edges: EDGES.map(() => ({})), shields: SHIELDS.map(() => ({})), prem: null };
      this.recalc();
      this.route();
      this.step(0);
    }

    /* ---------- параметры ---------- */
    set(o) {
      let need = false;
      for (const k in o) if (k in this.p && o[k] !== this.p[k]) { if (k !== 'collapse') need = true; this.p[k] = o[k]; }
      if (need) this.recalc();
    }
    recalc() {
      const N = K.N_TITLES;
      this.C = Math.max(1, Math.round(N * this.p.cPct / 100));
      this.tr = tier({ alpha: this.p.alpha, N, C: this.C, mode: this.p.mode, sigma: this.p.sigma });
    }
    get hour() { return (((this.t / 3600) % 24) + 24) % 24; }
    nodeIndex(id) { return this.nodes.findIndex(x => x.id === id); }

    /* ---------- события ---------- */
    /* Уронить (on = true) / поднять (false) / переключить (undefined) узел или шилд */
    fail(id, on) {
      const n = this.nodeIndex(id);
      if (n < 0 || n === OR) return false;
      const down = on == null ? !!this.alive[n] : !!on;
      if (!this.alive[n] === down) return false;
      this.alive[n] = down ? 0 : 1;
      this.route();
      return true;
    }
    isAlive(id) { const n = this.nodeIndex(id); return n >= 0 && !!this.alive[n]; }
    /* Премьера в ближайшую полночь; часы ставятся за lead секунд до неё */
    premiere(lead) {
      lead = lead == null ? 10 : lead;
      const release = (Math.floor(this.t / 86400) + 1) * 86400;
      this.t = release - lead;
      this.prem = { t0: release, prefilled: this.p.mode === 'prefill', init: false, peakRps: 0, maxF: 0, peakWait: 0 };
      // в полночь по Москве Владивосток завтракает: зрители премьеры ∝ местной активности
      let z = 0;
      for (let r = 0; r < R; r++) { this.premW[r] = this.w[r] * dayShape(this.tz[r]); z += this.premW[r]; }
      for (let r = 0; r < R; r++) this.premW[r] /= z;
      return this.prem;
    }
    reset(t) {
      this.alive.fill(1); this.warm.fill(0); this.q = 0; this.prem = null;
      if (t != null) this.t = t;
      this.route(); this.step(0);
    }

    /* Узел → ближайший живой шилд (или ориджин); порядок обслуживания регионов */
    route() {
      for (let e = 0; e < E; e++) {
        let best = OR, bd = Infinity;
        for (let s = 0; s < S; s++) if (this.alive[E + s] && this.rttES[e * S + s] < bd) { bd = this.rttES[e * S + s]; best = E + s; }
        this.edgeShield[e] = best;
      }
      const near = new Float64Array(R);
      for (let r = 0; r < R; r++) {
        near[r] = Infinity;
        for (const e of this.prefE[r]) if (this.alive[e]) { near[r] = this.rttRN[r * NN + e]; break; }
      }
      const ord = Array.from({ length: R }, (_, r) => r).sort((a, b) => near[a] - near[b] || this.w[b] - this.w[a]);
      this.order.set(ord);
    }
    /* Время промаха узла e (узел → шилд → ориджин и обратно), с, с учётом очереди */
    fetchF(e) {
      const s = this.edgeShield[e], D = this.q / MU, H = K.HOP_RTTS / 1000;
      if (s === OR) return H * this.rttEO[e] + K.T_XFER + K.ORIGIN_T0 + D;
      return H * (this.rttES[e * S + (s - E)] + this.rttSO[s - E]) + 2 * K.T_XFER + K.ORIGIN_T0 + D;
    }
    shieldF(s) { return K.HOP_RTTS / 1000 * this.rttSO[s] + K.T_XFER + K.ORIGIN_T0 + this.q / MU; }
    /* Характерное время LRU узла e в реальных секундах: t_C (в запросах-сеансах) / частота сеансов */
    tcSeconds(e, loadG) {
      const tC = this.tr.tC;
      if (!isFinite(tC)) return Infinity;
      const viewers = (loadG != null ? loadG : this.load[e]) / G_PER_VIEWER;
      return tC * K.SESSION_S / Math.max(1, viewers);
    }
    /* Установившийся режим (все узлы живы, без событий) — для суточного графика */
    steady(h) {
      const tr = this.tr, tot = VIEW_SCALE * nationShape(h) * G_PER_VIEWER;
      const miss = tot * (1 - tr.hEdge);
      let fill = 0;
      if (this.p.mode === 'prefill') for (let e = 0; e < E; e++) if (inFill(h + this.etz[e])) fill += this.fillPerEdge();
      return { totalG: tot, hitG: tot * tr.hEdge, missG: miss, originG: miss * (1 - tr.hShield), fillG: fill };
    }
    fillPerEdge() { return K.FILL_CHURN * this.C * K.TITLE_GB * 8 / ((K.FILL[1] - K.FILL[0]) * 3600); }

    /* ---------- шаг симуляции: dt — модельные секунды ---------- */
    step(dt) {
      dt = Math.max(0, dt || 0);
      this.t += dt;
      const h = this.hour, tr = this.tr, p = this.p;
      const alive = this.alive, cap = this.cap, A = this.A, load = this.load;
      /* зрители по регионам — в местном времени */
      let baseV = 0;
      for (let r = 0; r < R; r++) { this.vr[r] = VIEW_SCALE * this.w[r] * dayShape(h + this.tz[r]); baseV += this.vr[r]; }
      /* премьера: зрители серии (досмотревшие уходят) */
      const pr = this.prem;
      let premV = 0, u = -Infinity;
      if (pr) {
        u = this.t - pr.t0;
        if (u > K.PREM_EPISODE + 4 * K.PREM_TAU_WAVE) { this.prem = null; u = -Infinity; }
        else if (u >= 0) premV = premCum(u) - premCum(u - K.PREM_EPISODE);
      }
      const baseG = baseV * G_PER_VIEWER, premG = premV * G_PER_VIEWER, totG = baseG + premG;
      for (let r = 0; r < R; r++) this.pr[r] = pr ? premV * this.premW[r] : 0;

      /* 1. Направление: регион → ближайший живой узел с запасом ёмкости,
            излишек — на следующий; узлов нет — на шилд, затем на ориджин */
      A.fill(0); load.fill(0);
      for (let k = 0; k < R; k++) {
        const r = this.order[k];
        let left = (this.vr[r] + this.pr[r]) * G_PER_VIEWER;
        for (const e of this.prefE[r]) {
          if (!alive[e]) continue;
          const spare = cap[e] * K.STEER_LIMIT - load[e];
          if (spare <= 0) continue;
          const take = Math.min(left, spare);
          A[r * NN + e] += take; load[e] += take; left -= take;
          if (left <= 1e-9) break;
        }
        if (left > 1e-9) {
          let n = OR;
          for (const s of this.prefS[r]) if (alive[E + s]) { n = E + s; break; }
          A[r * NN + n] += left; load[n] += left;
        }
      }

      /* 2. Попадания узлов. Чужая аудитория (после отказа или перелива)
            сначала попадает хуже: h × (ρ + (1 − ρ)·прогрев). LRU прогревается
            за время порядка t_C, предзаливка — только в окно заливки. */
      const premHit = pr && u >= 0 ? 1 : 0;           // серия: после первой загрузки — в кэше
      const hitG = this.hitG, upG = this.upG, inG = this.inG, fillG = this.fillG;
      hitG.fill(0); upG.fill(0); inG.fill(0); fillG.fill(0);
      for (let e = 0; e < E; e++) {
        const fillOn = inFill(h + this.etz[e]);        // окно заливки — по местному времени узла
        const tau = Math.min(6 * 3600, Math.max(60, this.tcSeconds(e)));
        let hg = 0;
        for (let r = 0; r < R; r++) {
          const a = A[r * NN + e];
          const own = this.home[r] === e;
          const wi = r * E + e;
          if (!own) {
            if (a > 0) {
              if (p.mode === 'lru') this.warm[wi] += (1 - this.warm[wi]) * -Math.expm1(-dt / tau);
              else if (fillOn) this.warm[wi] += (1 - this.warm[wi]) * -Math.expm1(-dt / 7200);
            } else if (this.warm[wi] > 0) this.warm[wi] *= Math.exp(-dt / tau);
          }
          if (a <= 0) continue;
          const hb = tr.hEdge * (own ? 1 : K.RHO + (1 - K.RHO) * this.warm[wi]);
          const pf = this.pr[r] / (this.vr[r] + this.pr[r] || 1);
          hg += a * ((1 - pf) * hb + pf * (premHit ? 1 : hb));
        }
        if (!alive[e]) continue;
        hitG[e] = hg;
        upG[e] = load[e] - hg;
        if (p.mode === 'prefill' && fillOn) fillG[e] = this.fillPerEdge();
      }

      /* 3. Шилды: LRU по потоку промахов; промахи шилдов — на ориджин */
      for (let e = 0; e < E; e++) if (upG[e] > 0) inG[this.edgeShield[e]] += upG[e];
      let baseOrigin = 0;
      for (let s = 0; s < S; s++) {
        const n = E + s;
        const miss = inG[n] * (1 - tr.hShield) + load[n] * (1 - tr.hShieldDirect);
        upG[n] = miss; baseOrigin += miss;
        if (p.mode === 'prefill') {
          let f = 0;
          for (let e = 0; e < E; e++) if (this.edgeShield[e] === n) f += fillG[e];
          fillG[n] = 0.1 * f;                          // новинки доезжают до шилда один раз
        }
      }
      for (let e = 0; e < E; e++) if (this.edgeShield[e] === OR) baseOrigin += upG[e];
      baseOrigin += load[OR];
      inG[OR] = baseOrigin;
      const baseRps = baseOrigin * 1e9 / K.SEG_BITS;

      /* 4. Доли зрителей премьеры по узлам */
      const share = this.share;
      share.fill(0);
      for (let r = 0; r < R; r++) {
        const tot = (this.vr[r] + this.pr[r]) * G_PER_VIEWER, wr = pr ? this.premW[r] : this.w[r];
        if (tot <= 0) continue;
        for (let e = 0; e < E; e++) { const a = A[r * NN + e]; if (a > 0) share[e] += wr * a / tot; }
      }

      /* 5. Лавина премьеры и очередь ориджина — мелкими подшагами */
      const stormOn = !!pr && !pr.prefilled && u < K.PREM_EPISODE && u + dt >= 0;
      if (stormOn && !pr.init && u >= 0) this.initFront();
      let stormO = 0, stormE = 0, rejected = 0;
      if (stormOn || this.q > 0 || baseRps > MU) {
        const fine = stormOn && dt <= 2;
        const sub = fine ? 0.02 : Math.min(1, Math.max(0.02, dt));
        let left = dt, uu = u - dt, acc = 0, accO = 0, accE = 0, over = 0;
        this._accS.fill(0);
        while (left > 1e-9) {
          const hh = Math.min(sub, left);
          left -= hh; uu += hh;
          let rO = 0, rE = 0;
          if (stormOn && uu >= 0) {
            if (!pr.init) this.initFront();
            this.stormStep(uu, fine); rO = this._rO; rE = this._rE;
            for (let s = 0; s < S; s++) this._accS[s] += this.stormSRps[s] * hh;
          }
          const q2 = this.q + (baseRps + rO - MU) * hh, qMax = MU * K.Q_MAX_S;
          if (q2 > qMax) over += q2 - qMax;
          this.q = Math.max(0, Math.min(qMax, q2));
          acc += hh; accO += rO * hh; accE += rE * hh;
        }
        if (acc > 0) {
          stormO = accO / acc; stormE = accE / acc; rejected = over / acc;
          for (let s = 0; s < S; s++) this.stormSRps[s] = this._accS[s] / acc;
        }
        else if (stormOn && u >= 0) { this.stormStep(u, true); stormO = this._rO; stormE = this._rE; }
      }
      if (!stormOn) { this.stormRps.fill(0); this.stormSRps.fill(0); }

      /* 6. Сводка */
      const m = this.m;
      let edgeLoad = 0, edgeHit = 0;
      for (let e = 0; e < E; e++) { edgeLoad += load[e]; edgeHit += hitG[e]; }
      let shieldLoad = 0, shieldCap = 0;
      for (let s = 0; s < S; s++) { shieldLoad += inG[E + s] + load[E + s]; if (alive[E + s]) shieldCap += cap[E + s]; }
      const stormEG = stormE * K.SEG_BITS / 1e9, stormOG = stormO * K.SEG_BITS / 1e9;
      const originRps = baseRps + stormO;
      m.t = this.t; m.hour = h;
      m.viewers = baseV + premV; m.premViewers = premV;
      m.totalG = totG; m.edgeG = edgeLoad; m.edgeHitG = edgeHit;
      m.offload = totG > 0 ? edgeHit / totG : 0;
      m.hitEdge = edgeLoad > 0 ? edgeHit / edgeLoad : tr.hEdge;
      m.hitNominal = tr.hEdge; m.hitShield = tr.hShield;
      m.hitLRU = tr.hLRU; m.hitPrefill = tr.hPrefill; m.fOrigin = tr.fOrigin;
      m.shieldG = shieldLoad + stormEG; m.shieldCapG = shieldCap;
      m.originOfferedG = baseOrigin + stormOG; m.originBaseG = baseOrigin;
      m.originG = Math.min(m.originOfferedG, K.ORIGIN_GBPS);
      m.originRps = originRps; m.originBaseRps = baseRps;
      m.originUtil = originRps / MU;
      m.queueS = this.q / MU; m.rejectedRps = rejected;
      m.stormRps = stormO; m.stormEdgeRps = stormE;
      m.F = this.fetchF(0);
      m.fillG = 0;
      for (let e = 0; e < E; e++) m.fillG += fillG[e];
      // характерное время LRU по живым узлам, мин
      let tMin = Infinity, tMax = 0;
      for (let e = 0; e < E; e++) if (alive[e] && load[e] > 0) { const x = this.tcSeconds(e) / 60; if (x < tMin) tMin = x; if (x > tMax) tMax = x; }
      m.tcMin = tMin; m.tcMax = tMax;
      m.prem = null;
      if (pr) {
        const Fm = this.fetchF(0);
        if (u >= 0) { pr.peakRps = Math.max(pr.peakRps, originRps); pr.maxF = Math.max(pr.maxF, Fm); }
        const waiting = stormOn && u >= 0 ? premCum(Math.min(Fm, u)) : 0;
        if (waiting > pr.peakWait) pr.peakWait = waiting;
        const x = this._premM, on = stormOn && u >= 0;
        x.u = u; x.prefilled = pr.prefilled; x.storm = on; x.F = Fm;
        x.dup = on ? this.dupPerObject(0, Fm) : 0;
        x.waiting = waiting; x.stall = on ? Math.max(0, 1 - K.SEG_DUR / Math.max(K.SEG_DUR, Fm)) : 0;
        x.peakRps = pr.peakRps; x.maxF = pr.maxF;
        m.prem = x;
      }
      let hot = -1, hotU = -1;
      for (let e = 0; e < E; e++) {
        const x = m.edges[e];
        x.id = EDGES[e].id; x.alive = !!alive[e]; x.load = load[e]; x.cap = cap[e]; x.servers = this.servers[e];
        x.util = load[e] / cap[e];
        x.hit = load[e] > 0 ? hitG[e] / load[e] : tr.hEdge;
        x.up = upG[e]; x.storm = this.stormRps[e]; x.shield = this.edgeShield[e]; x.fill = fillG[e];
        if (alive[e] && x.util > hotU) { hotU = x.util; hot = e; }
      }
      m.hot = hot; m.hotUtil = hotU;
      for (let s = 0; s < S; s++) {
        const x = m.shields[s], n = E + s;
        x.id = SHIELDS[s].id; x.alive = !!alive[n]; x.in = inG[n]; x.direct = load[n];
        x.load = inG[n] + load[n]; x.cap = cap[n]; x.util = x.load / cap[n]; x.up = upG[n]; x.fill = fillG[n];
        x.storm = this.stormSRps[s];
      }
      /* 7. RTT до обслуживающего узла: p50 / p95 по зрителям */
      const pairs = this._pairs, idx = this._idx;
      idx.length = 0;
      let wsum = 0;
      for (let r = 0; r < R; r++) for (let n = 0; n < NN; n++) {
        const a = A[r * NN + n];
        if (a <= 0) continue;
        const k = idx.length;
        pairs[2 * k] = this.rttRN[r * NN + n]; pairs[2 * k + 1] = a; idx.push(k); wsum += a;
      }
      idx.sort(this._cmp);
      m.rtt50 = this.pctRtt(0.5, wsum); m.rtt95 = this.pctRtt(0.95, wsum);
      return m;
    }
    /* Взвешенный перцентиль RTT по отсортированным парам «регион — узел» */
    pctRtt(qq, wsum) {
      const pairs = this._pairs, idx = this._idx;
      let c = 0;
      for (let i = 0; i < idx.length; i++) { c += pairs[2 * idx[i] + 1]; if (c >= qq * wsum - 1e-12) return pairs[2 * idx[i]]; }
      return idx.length ? pairs[2 * idx[idx.length - 1]] : 0;
    }

    /* Передний край премьеры: первые зрители просят пачку (манифест, init, 3 сегмента) */
    initFront() {
      for (let e = 0; e < E; e++) { this.stT0[e] = 0; this.stF[e] = this.fetchF(e); this.stB[e] = K.BUNDLE; }
      this.prem.init = true;
    }
    /* Сколько запросов наверх в среднем на один объект переднего края (узел e) */
    dupPerObject(e, F) {
      const lam = this.share[e] / K.VARIANTS;         // доля зрителей на один вариант сегмента
      if (!this.p.collapse) return 1 + lam * premCum(F);
      return 1 + (F > K.LOCK_TIMEOUT ? lam * premCum(F - K.LOCK_TIMEOUT) : 0);
    }
    /* Подшаг лавины. u — секунды после выхода серии. Пишет запросы/с:
       _rE — от узлов к шилдам, _rO — от шилдов к ориджину (без аллокаций).
       fine: окна промахов разрешены по времени; иначе — средние за шаг. */
    stormStep(u, fine) {
      const storm = this.stormRps, col = this.p.collapse;
      const V = K.VARIANTS, SEG = K.SEG_DUR, LT = K.LOCK_TIMEOUT;
      const shF = this._shF, sS = this.stormSRps;
      shF.fill(0); sS.fill(0);
      let edgeSum = 0, direct = 0;
      for (let e = 0; e < E; e++) {
        const sh = this.share[e];
        if (!this.alive[e] || sh <= 0) { storm[e] = 0; continue; }
        const Fe = this.fetchF(e);
        // новый шаг переднего края — когда самые ранние зрители получили сегмент
        let P = Math.max(SEG, this.stF[e]);
        while (u >= this.stT0[e] + P) { this.stT0[e] += P; this.stF[e] = Fe; this.stB[e] = 1; P = Math.max(SEG, Fe); }
        const x = u - this.stT0[e], F = this.stF[e], B = this.stB[e];
        let r = V * B / P;                            // по одному первому запросу на объект
        if (fine) {
          if (!col) { if (x < F) r += sh * premRate(x) * B; }          // все, кто пришёл за F
          else if (F > LT && x >= LT && x < F) r += sh * premRate(x - LT) * B; // не дождались замка
        } else if (!col) r += sh * premCum(F) * B / P;
        else if (F > LT) r += sh * premCum(F - LT) * B / P;
        storm[e] = r; edgeSum += r;
        const s = this.edgeShield[e];
        if (s === OR) direct += r;
        else if (!col) sS[s - E] += r;              // шилд без схлопывания пропускает всё
        else shF[s - E] = Math.max(shF[s - E], V * B / Math.max(SEG, this.shieldF(s - E)));
      }
      let origin = direct;
      for (let s = 0; s < S; s++) {
        if (col) sS[s] = this.alive[E + s] ? shF[s] : 0;
        origin += sS[s];
      }
      this._rE = edgeSum; this._rO = origin;
    }
  }

  FJ.cdn = {
    K, REGIONS, EDGES, SHIELDS, ORIGIN,
    km, rttMs, project, rng,
    zipf, catalog, cheT, lruStats, hitLRU, prefillIn, prefillStats, hitPrefill, curves, tier, Phi,
    simulateLRU, simulatePrefill,
    upstreamRequests, upstreamFluid,
    dayShape, nationShape, inFill, premRate, premCum, VIEW_SCALE, NAT_MAX,
    Sim,
  };
  if (typeof module !== 'undefined') module.exports = FJ.cdn;
})(typeof window !== 'undefined' ? window : globalThis);

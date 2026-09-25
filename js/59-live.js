/* =====================================================================
   59-live — «Прямой эфир».
   1. Модель задержки «от камеры до экрана»: шесть этапов, формулы
      из спецификаций (HOLD-BACK, PART-HOLD-BACK), типичные значения
      и диапазоны из источников. Чистая логика — LiveModel, её тесты
      лежат в tests/live.test.js.
   2. «ГОЛ!»: мультивьюер соседей по дому. Все смотрят один матч,
      каждый со своей задержкой; кто увидел гол — кричит, и шум из окна
      спойлерит тех, у кого гол ещё впереди.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};

  /* =================================================================
     Модель задержки — чистые функции (работают и в node)
     ================================================================= */

  /* Этапы пути кадра. Цвет — ключ из FJ.colors. */
  const COMPONENTS = [
    { id: 'enc', name: 'Захват и кодирование', short: 'кодер', color: 'violet' },
    { id: 'pack', name: 'Ожидание упаковки', short: 'упаковка', color: 'q5' },
    { id: 'cdn', name: 'Ориджин → CDN', short: 'CDN', color: 'blue' },
    { id: 'req', name: 'Запрос и загрузка', short: 'загрузка', color: 'q3' },
    { id: 'hold', name: 'Буфер плеера', short: 'буфер', color: 'amber' },
    { id: 'dec', name: 'Декодирование и вывод', short: 'вывод', color: 'q1' },
  ];

  /* Сеть зрителя и CDN по умолчанию (модель):
     RTT до края CDN, уровни CDN (ориджин → щит → край) и задержка на уровень,
     битрейт верхней ступени футбольной трансляции и канал зрителя. */
  const ENV = { rtt: 0.04, hops: 2, hop: 0.05, bitrate: 6e6, bw: 30e6 };

  /* Типичные значения (модель). Итоги сверены с диапазонами REFS. */
  const PRESETS = {
    tv: { id: 'tv', kind: 'broadcast', name: 'Эфирное ТВ', enc: 2.0, mux: 0.2, tx: 0.6, rx: 1.0, dec: 0.3 },
    hls6: { id: 'hls6', kind: 'hls', name: 'HLS · 6 с', seg: 6, k: 3, enc: 1.0, dec: 0.1 },
    hls2: { id: 'hls2', kind: 'hls', name: 'HLS/DASH · 2 с', seg: 2, k: 3, enc: 1.0, dec: 0.1 },
    llhls: { id: 'llhls', kind: 'llhls', name: 'LL‑HLS', part: 1, k: 3, enc: 0.5, dec: 0.1 },
    lldash: { id: 'lldash', kind: 'lldash', name: 'LL‑DASH (чанки)', seg: 2, part: 0.5, k: 3, enc: 0.5, dec: 0.1 },
    webrtc: { id: 'webrtc', kind: 'webrtc', name: 'WebRTC', enc: 0.12, frame: 0.02, sfu: 0.05, jitter: 0.08, dec: 0.05 },
    moq: { id: 'moq', kind: 'moq', name: 'MoQ', exp: true, enc: 0.15, frame: 0.02, jitter: 0.25, dec: 0.05 },
  };
  const ORDER = ['tv', 'hls6', 'hls2', 'llhls', 'lldash', 'webrtc', 'moq'];

  /* Диапазоны и отметки из источников (секунды): скобки на графике сравнения. */
  const REFS = {
    tv: [{ a: 3, b: 6, label: 'BBC', src: 'dvb-ll' }, { a: 3, b: 10, label: 'большинство замеров', src: 'dashif-ll' }],
    hls6: [{ a: 12, b: 30, label: 'обзор IEEE', src: 'll-survey' }],
    hls2: [],
    llhls: [{ a: 1, b: 2, label: 'цель Apple', src: 'wwdc19' }, { a: 2, b: 6, label: 'обзор IEEE', src: 'll-survey' }],
    lldash: [{ a: 2, b: 10, label: 'DASH‑IF', src: 'dashif-ll', mark: 3.5 }],
    webrtc: [{ a: 0, b: 0.5, label: 'Cloudflare', src: 'cf-webrtc' }],
    moq: [{ a: 0, b: 1, label: 'цель', src: 'cf-moq' }],
  };

  function cfgOf(id, over) { return Object.assign({}, ENV, PRESETS[id], over || null); }

  /* Бюджет задержки. v — в среднем, vw — в худшем случае (кадр в начале
     сегмента/части ждёт её целиком). term — слагаемое формулы. */
  function budget(input) {
    const c = Object.assign({}, ENV, input);
    const parts = [];
    const add = (id, v, vw, term) => parts.push({ id, v, vw: vw == null ? v : vw, term });
    let unit = 0, sym = '';
    switch (c.kind) {
      case 'broadcast':
        add('enc', c.enc, null, 't_кодир');
        add('pack', c.mux, null, 't_мукс');
        add('cdn', c.tx, null, 't_передача');
        add('req', 0, null, '0');
        add('hold', c.rx, null, 't_приёмник');
        add('dec', c.dec, null, 't_вывод');
        break;
      case 'hls':
        unit = c.seg; sym = 'TD';
        add('enc', c.enc, null, 't_кодир');
        add('pack', unit / 2, unit, 'TD/2');
        add('cdn', c.hops * c.hop, null, 'n·t_хоп');
        add('req', c.rtt + c.bitrate * unit / c.bw, null, 'RTT + TD·R/B');
        add('hold', c.k * unit, null, 'k·TD');
        add('dec', c.dec, null, 't_вывод');
        break;
      case 'llhls':
      case 'lldash':
        unit = c.part; sym = c.kind === 'llhls' ? 'p' : 'c';
        add('enc', c.enc, null, 't_кодир');
        add('pack', unit / 2, unit, sym + '/2');
        add('cdn', c.hops * c.hop, null, 'n·t_хоп');
        add('req', c.rtt / 2 + c.bitrate * unit / c.bw, null, 'RTT/2 + ' + sym + '·R/B');
        add('hold', c.k * unit, null, 'k·' + sym);
        add('dec', c.dec, null, 't_вывод');
        break;
      case 'webrtc':
        add('enc', c.enc, null, 't_кодир');
        add('pack', c.frame, null, 't_кадр');
        add('cdn', c.sfu, null, 't_SFU');
        add('req', c.rtt / 2, null, 'RTT/2');
        add('hold', c.jitter, null, 't_джиттер');
        add('dec', c.dec, null, 't_вывод');
        break;
      case 'moq':
        add('enc', c.enc, null, 't_кодир');
        add('pack', c.frame, null, 't_объект');
        add('cdn', c.hops * c.hop, null, 'n·t_реле');
        add('req', c.rtt / 2, null, 'RTT/2');
        add('hold', c.jitter, null, 't_буфер');
        add('dec', c.dec, null, 't_вывод');
        break;
      default:
        throw new Error('неизвестный режим ' + c.kind);
    }
    let total = 0, worst = 0;
    for (const p of parts) { total += p.v; worst += p.vw; }
    return { kind: c.kind, cfg: c, parts, total, worst, unit, sym, buffer: parts[4].v };
  }

  /* Правила спецификаций для текущей настройки.
     HLS (draft-pantos-hls-rfc8216bis-22): HOLD-BACK ≥ 3 × TD — MUST;
     PART-HOLD-BACK ≥ 2 × PART-TARGET — MUST, ≥ 3 × — SHOULD.
     Apple HLS Authoring Spec, §14: PART-TARGET ≥ P95 RTT — MUST, ≥ 3 × P95 RTT — SHOULD;
     PART-HOLD-BACK ≥ 3 × PART-TARGET — MUST. */
  const EPS = 1e-9;
  function rules(input) {
    const c = Object.assign({}, ENV, input), out = [];
    if (c.kind === 'hls') out.push(c.k + EPS >= 3 ? { id: 'hb-ok', level: 'ok' } : { id: 'hb-must', level: 'must' });
    if (c.kind === 'llhls') {
      out.push(c.k + EPS >= 3 ? { id: 'phb-ok', level: 'ok' } : c.k + EPS >= 2 ? { id: 'phb-should', level: 'should' } : { id: 'phb-must', level: 'must' });
      out.push(c.part + EPS >= 3 * c.rtt ? { id: 'rtt-ok', level: 'ok' } : c.part + EPS >= c.rtt ? { id: 'rtt-should', level: 'should' } : { id: 'rtt-must', level: 'must' });
    }
    if (c.kind === 'lldash') out.push({ id: 'cte', level: 'info' });
    if (c.kind === 'webrtc') out.push({ id: 'sfu', level: 'info' });
    if (c.kind === 'moq') out.push({ id: 'moq', level: 'info' });
    if (c.kind === 'broadcast') out.push({ id: 'air', level: 'info' });
    return out;
  }

  /* Запросы к краю CDN в секунду на N зрителей одной дорожки (до склейки).
     HLS: плейлист и сегмент раз в TD; LL-HLS: блокирующий плейлист и часть
     раз в часть; LL-DASH: один долгий запрос на сегмент, чанки идут в нём,
     MPD по шаблону не перезапрашивается. */
  function requests(input, N) {
    const c = Object.assign({}, ENV, input);
    switch (c.kind) {
      case 'hls': return { kind: 'http', playlist: N / c.seg, media: N / c.seg, total: 2 * N / c.seg };
      case 'llhls': return { kind: 'http', playlist: N / c.part, media: N / c.part, total: 2 * N / c.part };
      case 'lldash': return { kind: 'http', playlist: 0, media: N / c.seg, total: N / c.seg };
      case 'webrtc': return { kind: 'sessions', playlist: 0, media: 0, total: N };
      case 'moq': return { kind: 'subs', playlist: 0, media: 0, total: N };
      default: return { kind: 'none', playlist: 0, media: 0, total: 0 };
    }
  }

  /* Соседи по дому (типичные значения) и чат: сосед смотрит эфир по антенне
     и пишет «ГОЛ!» через CHAT_DELAY секунд (иллюстративно). */
  const CHAT_DELAY = 3.5;
  const NEIGHBOURS = [
    { id: 'webrtc', preset: 'webrtc', label: 'WebRTC' },
    { id: 'lldash', preset: 'lldash', label: 'LL‑DASH' },
    { id: 'tv', preset: 'tv', label: 'Антенна' },
    { id: 'llhls', preset: 'llhls', label: 'LL‑HLS' },
    { id: 'chat', kind: 'chat', after: 'tv', label: 'Чат соседа' },
    { id: 'hls2', preset: 'hls2', label: 'DASH 2 с' },
    { id: 'hls6', preset: 'hls6', label: 'HLS 6 с' },
    { id: 'you', label: 'Вы' },
  ];

  function raceSetup(yourCfg) {
    return NEIGHBOURS.map(nb => {
      let L;
      if (nb.kind === 'chat') L = budget(cfgOf(nb.after)).total + CHAT_DELAY;
      else if (nb.id === 'you') L = budget(yourCfg).total;
      else L = budget(cfgOf(nb.preset)).total;
      return { id: nb.id, L, kind: nb.kind || 'viewer', label: nb.label };
    });
  }

  /* Кто кого спойлерит. Зритель узнаёт о голе от первого, кто увидел его
     раньше (крик за стеной), или из чата — что раньше. Равные не спойлерят. */
  function race(list) {
    const viewers = list.filter(x => x.kind !== 'chat');
    const chats = list.filter(x => x.kind === 'chat');
    let first = null;
    for (const v of viewers) if (!first || v.L < first.L) first = v;
    const screens = list.map(x => {
      if (x.kind === 'chat') return { id: x.id, L: x.L, kind: 'chat', spoilAt: null, by: null, lead: 0 };
      let at = Infinity, by = null;
      for (const y of viewers) if (y !== x && y.L < at) { at = y.L; by = y.id; }
      for (const y of chats) if (y.L < at) { at = y.L; by = y.id; }
      if (!(at < x.L)) return { id: x.id, L: x.L, kind: 'viewer', spoilAt: null, by: null, lead: 0 };
      return { id: x.id, L: x.L, kind: 'viewer', spoilAt: at, by, lead: x.L - at };
    });
    const ev = [0];
    for (const x of list) ev.push(x.L);
    ev.sort((a, b) => a - b);
    const events = ev.filter((e, i) => i === 0 || e - ev[i - 1] > 1e-9);
    return { screens, first: first ? { id: first.id, L: first.L } : null, events };
  }

  /* Ролик ускоряется между событиями: рядом с голом у кого-то из соседей
     время идёт 1:1, между событиями — ×ff с плавным переходом. До гола на
     стадионе — всегда 1:1. */
  const SPEED = { ff: 5, before: 1.5, after: 2.5, ramp: 0.8 };
  function speedAt(t, events, o) {
    o = o || SPEED;
    if (t < 0) return 1;
    let d = Infinity;
    for (let i = 0; i < events.length; i++) {
      const a = events[i] - o.before, b = events[i] + o.after;
      const dd = t < a ? a - t : t > b ? t - b : 0;
      if (dd < d) { d = dd; if (d === 0) return 1; }
    }
    const u = Math.min(1, d / o.ramp);
    return 1 + (o.ff - 1) * u * u * (3 - 2 * u);
  }
  function realDuration(T0, T1, events, o, dt) {
    dt = dt || 1 / 120;
    let t = T0, n = 0;
    while (t < T1 && n < 1e6) { t += speedAt(t, events, o) * dt; n++; }
    return n * dt;
  }

  const LiveModel = {
    COMPONENTS, ENV, PRESETS, ORDER, REFS, CHAT_DELAY, NEIGHBOURS, SPEED,
    cfgOf, budget, rules, requests, raceSetup, race, speedAt, realDuration,
  };
  FJ.liveModel = LiveModel;
  if (typeof module !== 'undefined' && module.exports) module.exports = LiveModel;
  if (typeof document === 'undefined') return;

  /* =================================================================
     Дальше — только браузер
     ================================================================= */
  const SRC = {
    'wwdc19': ['Apple. Introducing Low-Latency HLS. WWDC19, сессия 502', 'https://developer.apple.com/videos/play/wwdc2019/502/'],
    'dvb-ll': ['DASH-IF, DVB. Report on Low-Latency Live Service with DASH (2017): замер BBC, сценарии «спорт-бар» и «соцсети»', 'https://dash-industry-forum.github.io/docs/Report%20on%20Low%20Latency%20DASH.pdf'],
    'll-survey': ['A. Bentaleb et al. Toward One-Second Latency: Evolution of Live Media Streaming. IEEE Communications Surveys & Tutorials, 2025', 'https://arxiv.org/pdf/2310.03256'],
    'cf-webrtc': ['Cloudflare Stream. WebRTC: WHIP и WHEP (бета)', 'https://developers.cloudflare.com/stream/webrtc-beta/'],
    'dashjs-l2a': ['dash.js. L2A Rule (Learn2Adapt-LowLatency)', 'https://dashif.org/dash.js/pages/usage/abr/l2a.html'],
    'dashjs-lolp': ['dash.js. LoL+ Rule: оценка сети без пауз между чанками', 'https://dashif.org/dash.js/pages/usage/abr/lol_plus.html'],
  };
  if (FJ.sources) for (const k in SRC) if (!FJ.sources[k]) FJ.sources[k] = SRC[k];

  const M = LiveModel;
  const fmt = FJ.fmt, el = FJ.h, NB = fmt.NB;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mod = (a, n) => ((a % n) + n) % n;
  const TAU = Math.PI * 2, DEG = Math.PI / 180;
  const RM = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------- форматирование ---------- */
  function fs(v) {
    if (Math.abs(v) < 1e-9) return '0' + NB + 'с';
    const a = Math.abs(v);
    let d = a >= 100 ? 0 : a >= 1 ? 1 : 2;
    if (d === 2 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-6) d = 1;
    if (a >= 1 && Math.abs(v - Math.round(v)) < 1e-6) d = 0;
    return fmt.num(v, d) + NB + 'с';
  }
  function fmtTc(t) {
    const a = Math.round(Math.abs(t) * 10) / 10;
    const sg = t < -0.05 ? fmt.MINUS : '+';
    const m = Math.floor(a / 60), s = a - m * 60;
    return sg + String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1).replace('.', ',');
  }
  function fmtCount(n) {
    if (n >= 1e6) { const v = n / 1e6; return fmt.num(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1) + NB + 'млн'; }
    if (n >= 1e3) return fmt.num(n / 1e3, 0) + NB + 'тыс.';
    return fmt.num(n, 0);
  }
  const ms = s => fmt.ms(s);
  const cssCol = id => 'var(--' + M.COMPONENTS.find(c => c.id === id).color + ')';
  /* Неразрывный пробел после коротких предлогов и союзов в динамических подписях */
  const TY = /(^|[\s(«>])(в|к|с|и|а|но|на|по|за|от|до|из|не|о|у|В|К|С|И|А|Но|На|По|За|От|До|Из|Не|О|У) /g;
  const ty = s => s.replace(TY, '$1$2' + NB).replace(TY, '$1$2' + NB).replace(/ — /g, NB + '— ');

  const ICON = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor"/></svg>',
    replay: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.3 8.6a4.8 4.8 0 1 0 1.5-4.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.6 1.9v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ff: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5v9L7.5 8zM8.5 3.5v9L14.5 8z" fill="currentColor"/></svg>',
    sound: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h2.6L8 3.2v9.6L4.6 10H2z" fill="currentColor"/><path d="M10.6 5.4a3.6 3.6 0 0 1 0 5.2M12.6 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    chat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h11v7.5H8L4.5 13v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l6.3 11.3H1.7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.4v3.4M8 11.6v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4M8 4.9v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  /* =================================================================
     Матч: хореография. Время s отсчитывается от гола (s = 0 — мяч
     в сетке). Мир в метрах: X — вдоль поля к воротам (линия ворот
     52,5), Y — поперёк поля, к камере «+», Z — вверх.
     ================================================================= */
  function Track(keys, period) {
    const n = keys.length;
    this.n = n; this.T = new Float64Array(n); this.X = new Float64Array(n); this.Y = new Float64Array(n);
    this.MX = new Float64Array(n); this.MY = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.T[i] = keys[i][0]; this.X[i] = keys[i][1]; this.Y[i] = keys[i][2] || 0; }
    for (let i = 0; i < n; i++) {
      let a = i - 1, b = i + 1, ta, tb;
      if (period) {
        if (a < 0) { a = n - 2; ta = this.T[a] - period; } else ta = this.T[a];
        if (b > n - 1) { b = 1; tb = this.T[b] + period; } else tb = this.T[b];
      } else {
        if (a < 0) a = i;
        if (b > n - 1) b = i;
        ta = this.T[a]; tb = this.T[b];
      }
      const dt = tb - ta;
      this.MX[i] = dt > 0 ? (this.X[b] - this.X[a]) / dt : 0;
      this.MY[i] = dt > 0 ? (this.Y[b] - this.Y[a]) / dt : 0;
    }
  }
  /* Кубический Эрмит с касательными Катмулла — Рома */
  Track.prototype.at = function (s, out) {
    const T = this.T, n = this.n;
    if (s <= T[0]) { out[0] = this.X[0]; out[1] = this.Y[0]; return out; }
    if (s >= T[n - 1]) { out[0] = this.X[n - 1]; out[1] = this.Y[n - 1]; return out; }
    let i = 0;
    while (i < n - 2 && s >= T[i + 1]) i++;
    const hh = T[i + 1] - T[i], u = (s - T[i]) / hh, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out[0] = h00 * this.X[i] + h10 * hh * this.MX[i] + h01 * this.X[i + 1] + h11 * hh * this.MX[i + 1];
    out[1] = h00 * this.Y[i] + h10 * hh * this.MY[i] + h01 * this.Y[i + 1] + h11 * hh * this.MY[i + 1];
    return out;
  };

  const LOOP = 8;     // до атаки — розыгрыш в центре поля, по кругу каждые 8 с
  const ATT0 = -6;    // начало атаки
  /* team: 0 — «Север» (атакует, белые), 1 — «Юг» (синие), 2 — вратарь «Юга» */
  const CAST = [
    { team: 0, loop: [[0, 26, 15], [1.6, 24, 14], [3.2, 23, 15.5], [4.8, 25, 16.5], [6.4, 26.5, 15.5], [8, 26, 15]],
      att: [[-6, 26, 15], [-4.9, 29, 16], [-3.8, 33.5, 15.5], [-2.35, 39.2, 13.5], [-1.2, 41.5, 12.5], [0, 44, 12.5], [1.5, 47, 13.5], [3, 48.6, 14.5], [6, 49, 15]] },
    { team: 0, loop: [[0, 35, -2], [2, 33, 0], [4, 34, -3], [6, 36, -1], [8, 35, -2]],
      att: [[-6, 35, -2], [-4, 37, -1], [-2.4, 39.5, 0.5], [-1.05, 42.9, 1.5], [-0.5, 43.6, 1.3], [0, 44.3, 1.8], [1, 46.5, 5.5], [2.5, 49.2, 11.5], [3.8, 50, 14.5], [6, 50.2, 15]] },
    { team: 0, loop: [[0, 18, -4], [1.6, 16, -2], [3.2, 17, -6], [4.8, 19.5, -7], [6.4, 18.5, -5], [8, 18, -4]],
      att: [[-6, 18, -4], [-4.5, 21, -3], [-3, 25, -1.5], [-1.5, 29, 0], [0, 31, 1], [1.5, 35, 5], [3.5, 40.5, 10.5], [6, 44.5, 12.5]] },
    { team: 0, loop: [[0, 30, -17], [1.6, 28, -18], [3.2, 25, -16], [4.8, 24.5, -15], [6.4, 27.5, -16.5], [8, 30, -17]],
      att: [[-6, 30, -17], [-3, 37, -13], [-1, 42, -9], [0, 44, -8], [2, 45, 1], [4, 47.5, 11.5], [6, 48.2, 14]] },
    { team: 0, loop: [[0, 10, 5], [1.6, 12, 3.5], [3.2, 11, 2], [4.8, 9.5, 4], [6.4, 10, 5.5], [8, 10, 5]],
      att: [[-6, 10, 5], [-3, 14, 4], [0, 19, 3], [3, 22, 5], [6, 24, 6]] },
    { team: 1, loop: [[0, 31, 12.5], [2, 29, 12], [4, 28.5, 11], [6, 30, 12], [8, 31, 12.5]],
      att: [[-6, 31, 12.5], [-4.9, 32, 13.5], [-3.8, 35, 14], [-2.35, 38.5, 12.8], [-1.2, 40, 11.5], [0, 41, 11], [2, 41.5, 10.5], [6, 41, 10]] },
    { team: 1, loop: [[0, 40, 3], [2, 39, 2], [4, 39.5, 0], [6, 40.5, 2], [8, 40, 3]],
      att: [[-6, 40, 3], [-3, 42, 2.2], [-1.5, 43.5, 2.8], [-0.5, 44.8, 2.6], [0, 45.3, 2.4], [2, 45.8, 2], [6, 46, 2]] },
    { team: 1, loop: [[0, 41, -5], [2, 40, -6], [4, 39, -7], [6, 40.5, -6], [8, 41, -5]],
      att: [[-6, 41, -5], [-3, 43, -4], [-1, 45, -3], [0, 46.3, -2.6], [3, 47, -2.5], [6, 47, -2.5]] },
    { team: 1, loop: [[0, 36, -15], [2, 34, -16], [4, 33, -15.5], [6, 35, -15], [8, 36, -15]],
      att: [[-6, 36, -15], [-3, 40, -12], [0, 43, -10], [3, 44, -8], [6, 44, -8]] },
    { team: 1, loop: [[0, 27, -7], [2, 24, -5], [4, 23.5, -8], [6, 25.5, -8.5], [8, 27, -7]],
      att: [[-6, 27, -7], [-3, 30, -4.5], [-1, 33.5, -2], [0, 35, -1], [3, 36, 0], [6, 36, 0]] },
    { team: 2, gk: true, loop: [[0, 51.3, 0], [4, 51.4, -0.8], [8, 51.3, 0]],
      att: [[-6, 51.3, 0], [-2.3, 51.2, 1.2], [-1.05, 51.1, 1.1], [-0.45, 51.1, 0.7], [-0.1, 51.4, -1.9], [0.5, 51.5, -2.4], [6, 51.5, -2.4]] },
  ];
  for (const c of CAST) { c.loopT = new Track(c.loop, LOOP); c.attT = new Track(c.att); }
  const NCAST = CAST.length;

  /* Мяч: у ног (hold), пас (pass, h — высота навеса), удар, падение в сетке */
  const BALL_LOOP = [
    { a: 0, b: 1.2, type: 'hold', p: 2 }, { a: 1.2, b: 2.0, type: 'pass', p: 2, q: 4, h: 0 },
    { a: 2.0, b: 3.3, type: 'hold', p: 4 }, { a: 3.3, b: 4.5, type: 'pass', p: 4, q: 3, h: 2.6 },
    { a: 4.5, b: 5.6, type: 'hold', p: 3 }, { a: 5.6, b: 6.5, type: 'pass', p: 3, q: 2, h: 0 },
    { a: 6.5, b: 8.01, type: 'hold', p: 2 },
  ];
  const BALL_ATT = [
    { a: -6, b: -5.8, type: 'hold', p: 2 }, { a: -5.8, b: -4.9, type: 'pass', p: 2, q: 0, h: 0 },
    { a: -4.9, b: -2.35, type: 'hold', p: 0 }, { a: -2.35, b: -1.05, type: 'pass', p: 0, q: 1, h: 0.9 },
    { a: -1.05, b: -0.5, type: 'hold', p: 1 }, { a: -0.5, b: 0, type: 'shot', p: 1 },
    { a: 0, b: 0.75, type: 'fall' }, { a: 0.75, b: 1e9, type: 'rest' },
  ];
  const IMP = { x: 54.15, y: -3.05, z: 1.85 };   // куда мяч влетает в сетку
  const REST = { x: 53.85, y: -3.0 };
  const GW = 3.66, GH = 2.44, NB_BOT = 54.4, NB_TOP = 54.15;   // ворота: полуширина, высота, глубина сетки
  const backX = z => NB_BOT + (NB_TOP - NB_BOT) * (z / 2.3);

  const P0 = new Float64Array(2), P1 = new Float64Array(2), CAMV = new Float64Array(2), POSE = new Float64Array(2);
  function holderAt(i, loop, t, out) { return loop ? CAST[i].loopT.at(mod(t, LOOP), out) : CAST[i].attT.at(t, out); }
  function castPos(i, s, out) { return s < ATT0 ? CAST[i].loopT.at(mod(s - ATT0, LOOP), out) : CAST[i].attT.at(s, out); }

  /* Прогиб сетки после удара (м, наружу по X): выпуклость + бегущая волна */
  function netDisp(y, z, tau) {
    if (tau <= 0 || tau > 3.5) return 0;
    const dy = y - IMP.y, dz = z - IMP.z, d2 = dy * dy + dz * dz, d = Math.sqrt(d2);
    const push = tau < 0.08 ? tau / 0.08 : Math.exp(-(tau - 0.08) * 4.2);
    let v = 0.6 * Math.exp(-d2 / 0.5) * push;
    if (d < tau * 7) v += 0.13 * Math.sin(tau * 21 - d * 6.5) * Math.exp(-tau * 2.1) * Math.exp(-d * 0.45);
    return RM ? v * 0.4 : v;
  }

  function ballAt(s, out) {
    const loop = s < ATT0;
    const t = loop ? mod(s - ATT0, LOOP) : s;
    const ph = loop ? BALL_LOOP : BALL_ATT;
    let f = ph[ph.length - 1];
    for (let i = 0; i < ph.length; i++) if (t < ph[i].b) { f = ph[i]; break; }
    if (f.type === 'hold') {
      holderAt(f.p, loop, t, P0);
      holderAt(f.p, loop, t + 0.1, P1);
      let vx = (P1[0] - P0[0]) / 0.1, vy = (P1[1] - P0[1]) / 0.1;
      const sp = Math.hypot(vx, vy);
      if (sp > 0.3) { vx /= sp; vy /= sp; } else { vx = 0.8; vy = 0.3; }
      const lead = 0.45 + 0.1 * Math.sin(t * 9);
      out[0] = P0[0] + vx * lead; out[1] = P0[1] + vy * lead; out[2] = 0.11;
    } else if (f.type === 'pass') {
      holderAt(f.p, loop, f.a, P0);
      holderAt(f.q, loop, f.b, P1);
      const u = clamp((t - f.a) / (f.b - f.a), 0, 1), e = 1 - Math.pow(1 - u, 1.6);
      out[0] = P0[0] + (P1[0] - P0[0]) * e; out[1] = P0[1] + (P1[1] - P0[1]) * e;
      out[2] = 0.11 + f.h * 4 * u * (1 - u);
    } else if (f.type === 'shot') {
      holderAt(f.p, false, f.a, P0);
      const u = clamp((t - f.a) / (f.b - f.a), 0, 1), e = 1 - Math.pow(1 - u, 1.25);
      const x0 = P0[0] + 0.4;
      out[0] = x0 + (IMP.x - x0) * e;
      out[1] = P0[1] + (IMP.y - P0[1]) * e + 0.45 * Math.sin(Math.PI * e);
      out[2] = 0.15 + (IMP.z - 0.15) * e + 1.4 * e * (1 - e);
    } else if (f.type === 'fall') {
      const u = clamp(t / 0.75, 0, 1);
      out[0] = IMP.x + (REST.x - IMP.x) * u + netDisp(IMP.y, IMP.z, t) * (1 - u);
      out[1] = IMP.y + (REST.y - IMP.y) * u;
      out[2] = Math.max(0.11, IMP.z - (IMP.z - 0.11) * u * u);
    } else { out[0] = REST.x; out[1] = REST.y; out[2] = 0.11; }
    return out;
  }

  /* Оператор трансляции: панорама вслед за игрой и наезд к воротам */
  const CAM_LOOP = new Track([[0, 21], [2, 22.2], [4, 21], [6, 19.8], [8, 21]], LOOP);
  const CAM_ATT = new Track([[-6, 21], [-4.5, 24.5], [-3, 31], [-1.8, 38.5], [-0.7, 45], [0, 47], [1.5, 47.5], [3.5, 46.5], [8, 46]]);
  const FOV_ATT = new Track([[-6, 30], [-4, 28], [-2.5, 25], [-1.2, 21], [-0.3, 19.5], [0.6, 19.5], [2.5, 23], [5, 25], [8, 25]]);
  const camAt = s => (s < ATT0 ? CAM_LOOP.at(mod(s - ATT0, LOOP), CAMV) : CAM_ATT.at(s, CAMV))[0];
  const fovAt = s => (s < ATT0 ? 30 : FOV_ATT.at(s, CAMV)[0]);

  /* Вратарь: бросок к дальней штанге (в кадре она правее и выше), лежит, садится.
     Наклон положительный — голова уходит вправо, к мячу. */
  function gkPose(s, out) {
    if (s < -0.45) { out[0] = 0; out[1] = 0; }
    else if (s < -0.1) { const u = (s + 0.45) / 0.35; out[0] = 1.25 * (1 - Math.pow(1 - u, 3)); out[1] = 0.55 * Math.sin(Math.PI * u); }
    else if (s < 2.5) { out[0] = 1.4; out[1] = 0; }
    else { out[0] = 1.4 - 0.9 * clamp((s - 2.5) / 0.8, 0, 1); out[1] = 0; }
    return out;
  }

  /* Вспышки фотокамер на трибуне: доля ширины фона, доля высоты трибуны, время */
  const FLASH = (function () {
    const r = FJ.rng ? FJ.rng(2605) : Math.random;
    const a = [];
    for (let i = 0; i < 28; i++) a.push({ x: r(), y: 0.12 + 0.8 * r(), t: 0.15 + 4.6 * r(), t0: 9 * r() });
    return a;
  })();

  /* =================================================================
     Сцена: картинка трансляции, s → кадр. Камера — точка-обскура
     без поворота вбок: линии вдоль X остаются горизонтальными, панорама —
     сдвиг, наезд — масштаб вокруг центра кадра.
     ================================================================= */
  const CAM_Y = 42, CAM_Z = 12;
  const FLEN = Math.hypot(CAM_Y, CAM_Z), FY = -CAM_Y / FLEN, FZ = -CAM_Z / FLEN;
  const Z_STANDS = 89;   // глубина трибуны — для параллакса
  const PAL = {
    pitchA: '#1a4b30', pitchB: '#1f5838', runoff: '#163f28', line: 'rgba(236,240,230,0.8)',
    board: '#0c0e12', boards: ['#162438', '#22252b', '#2b1d1b'],
    net: 'rgba(232,234,228,0.46)', post: '#f3f2ec', ball: '#f7f6f1', red: '#ff4d3d',
    skin: '#c69f86', hair: '#2a2320',
    kit: [
      { shirt: '#f2f0ea', shorts: '#1a1c21', socks: '#e9e7e1' },
      { shirt: '#3463b5', shorts: '#e9e7e1', socks: '#1d2f57' },
      { shirt: '#ffb02e', shorts: '#1a1c21', socks: '#ffb02e' },
    ],
  };
  const SHADOWS = [[-0.3, 0.02, -0.25], [0.3, 0.02, 0.25], [-0.14, -0.04, 0.5], [0.14, -0.04, -0.5]];
  let PX = 0, PY = 0, PK = 0;
  const ACT_X = new Float64Array(NCAST + 1), ACT_Y = new Float64Array(NCAST + 1);
  const ORD = new Int8Array(NCAST + 1);
  const BALL = new Float64Array(3), B2 = new Float64Array(3);
  const byY = (a, b) => ACT_Y[a] - ACT_Y[b];

  function Scene(host, hi) {
    this.hi = hi;
    this.w = 1; this.h = 1; this.dpr = 1; this.F = 1; this.F0 = 1; this.cx = 30;
    this.bgW = 1; this.bgH = 1;
    this.bg = document.createElement('canvas');
    this.grade = hi ? document.createElement('canvas') : null;
    this.dirty = true; this.lastS = NaN;
    this.cv = FJ.canvas(host, { maxDpr: hi ? 2 : 1.5, onResize: st => this.layout(st) });
  }
  Scene.prototype.proj = function (X, Y, Z) {
    const dx = X - this.cx, dy = Y - CAM_Y, dz = Z - CAM_Z;
    const zc = dy * FY + dz * FZ, yc = dy * FZ - dz * FY;
    const k = this.F / zc;
    PX = this.w * 0.5 + dx * k; PY = this.h * 0.5 - yc * k; PK = k;
  };
  Scene.prototype.layout = function (st) {
    this.w = st.w; this.h = st.h; this.dpr = st.dpr;
    this.F0 = this.F = (st.h / 2) / Math.tan(15 * DEG);
    this.proj(0, -36, 0.9);
    this.bgW = Math.ceil(st.w * 1.6); this.bgH = Math.max(2, Math.ceil(PY) + 2);
    this.buildBg();
    if (this.grade) this.buildGrade();
    this.dirty = true;
  };
  /* Трибуна: зрители точками по рядам, ярус, свет прожекторов сверху */
  Scene.prototype.buildBg = function () {
    const dpr = this.dpr, W = Math.max(1, Math.round(this.bgW * dpr)), H = Math.max(1, Math.round(this.bgH * dpr));
    const cv = this.bg; cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    // пиксели собираем сами (createImageData, без чтения холста): фон-градиент и зрители
    const img = g.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) {
      const f = y / Math.max(1, H - 1), u = f < 0.5 ? f / 0.5 : (f - 0.5) / 0.5;
      const R0 = f < 0.5 ? 5 + (13 - 5) * u : 13 + (26 - 13) * u;
      const G0 = f < 0.5 ? 6 + (15 - 6) * u : 15 + (29 - 15) * u;
      const B0 = f < 0.5 ? 8 + (19 - 8) * u : 19 + (35 - 19) * u;
      for (let x = 0, i = y * W * 4; x < W; x++, i += 4) { d[i] = R0; d[i + 1] = G0; d[i + 2] = B0; d[i + 3] = 255; }
    }
    const r = FJ.rng(0x5eed + W);
    const cell = Math.max(2, Math.round(dpr * (this.hi ? 1.7 : 1.4)));
    const rowH = cell * 3;
    for (let y = 0; y < H; y += cell) {
      const f = y / H;
      if (y % rowH < cell) continue;                 // проход между рядами
      const dens = 0.32 + 0.5 * f;
      for (let x = 0; x < W; x += cell) {
        if (r() > dens) continue;
        const k = r();
        let R, G, B;
        if (k < 0.1) { R = 214; G = 216; B = 220; }
        else if (k < 0.19) { R = 158; G = 46; B = 40; }
        else if (k < 0.28) { R = 58; G = 96; B = 172; }
        else { const v = 64 + 72 * r(); R = v; G = v * 0.97; B = v * 0.93; }
        const a = (0.16 + 0.44 * f) * (0.6 + 0.4 * r());
        const yEnd = Math.min(H, y + cell - 1), xEnd = Math.min(W, x + cell - 1);
        for (let yy = y; yy < yEnd; yy++) {
          let i = (yy * W + x) * 4;
          for (let xx = x; xx < xEnd; xx++, i += 4) {
            d[i] += (R - d[i]) * a; d[i + 1] += (G - d[i + 1]) * a; d[i + 2] += (B - d[i + 2]) * a;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    // козырёк между ярусами
    g.fillStyle = '#08090b'; g.fillRect(0, H * 0.46, W, Math.max(1, H * 0.05));
    g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(0, H * 0.51, W, Math.max(1, dpr));
    // свет прожекторов с крыши (сами мачты выше кадра)
    g.globalCompositeOperation = 'lighter';
    for (const fx of [0.12, 0.38, 0.62, 0.88]) {
      const cx = fx * W, cy = -H * 0.25, R = H * 1.5;
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      rg.addColorStop(0, 'rgba(255,247,228,0.34)'); rg.addColorStop(0.3, 'rgba(255,243,220,0.1)'); rg.addColorStop(1, 'rgba(255,240,210,0)');
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,250,236,0.9)';
      for (let q = -3; q <= 3; q++) g.fillRect(cx + q * 3.2 * dpr - dpr, 0, 2 * dpr, 1.4 * dpr);
    }
    g.globalCompositeOperation = 'source-over';
  };
  Scene.prototype.buildGrade = function () {
    const dpr = this.dpr, W = Math.max(1, Math.round(this.w * dpr)), H = Math.max(1, Math.round(this.h * dpr));
    const cv = this.grade; cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const rg = g.createRadialGradient(W * 0.55, H * 0.52, Math.min(W, H) * 0.3, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
    const lg = g.createLinearGradient(0, 0, 0, H * 0.55);
    lg.addColorStop(0, 'rgba(255,240,214,0.08)'); lg.addColorStop(1, 'rgba(255,240,214,0)');
    g.fillStyle = lg; g.fillRect(0, 0, W, H * 0.55);
  };

  Scene.prototype.draw = function (s) {
    const c = this.cv.ctx, w = this.w, h = this.h;
    this.lastS = s; this.dirty = false;
    if (w < 8 || h < 8) return;
    const cam = camAt(s);
    this.cx = cam;
    this.F = (h / 2) / Math.tan(fovAt(s) * DEG / 2);
    const z = this.F / this.F0, cx = w / 2, cy = h / 2;
    let ox = -(this.bgW - w) / 2 - (cam - 31) * this.F0 / Z_STANDS;
    if (ox > 0) ox = 0; else if (ox < w - this.bgW) ox = w - this.bgW;
    c.drawImage(this.bg, cx + (ox - cx) * z, cy - cy * z, this.bgW * z, this.bgH * z);
    this.flashes(c, s, ox, z);
    this.proj(0, -36, 0);
    const yb = PY;
    c.fillStyle = PAL.pitchA; c.fillRect(0, yb, w, h - yb + 1);
    this.stripes(c, cam);
    this.boards(c, s, cam, yb);
    this.lines(c, cam);
    this.goalBack(c, s);
    this.actors(c, s);
    this.goalFront(c, s);
    if (this.grade) c.drawImage(this.grade, 0, 0, w, h);
    this.gfx(c, s);
  };
  Scene.prototype.flashes = function (c, s, ox, z) {
    const n = this.hi ? FLASH.length : 9, cx = this.w / 2, cy = this.h / 2;
    const after = s > 0 && s < 6;
    c.fillStyle = '#fff';
    for (let i = 0; i < n; i++) {
      const f = FLASH[i];
      let age;
      if (after) age = s - f.t;
      else { if (i % 4) continue; age = mod(s, 9) - f.t0; }
      if (age < 0 || age > 0.1) continue;
      const X = cx + (ox + f.x * this.bgW - cx) * z, Y = cy + (f.y * (this.bgH - 2) - cy) * z;
      if (X < -6 || X > this.w + 6 || Y < 0) continue;
      const a = 1 - age / 0.1;
      c.globalAlpha = 0.95 * a; c.beginPath(); c.arc(X, Y, this.hi ? 1.3 : 1, 0, TAU); c.fill();
      if (this.hi) { c.globalAlpha = 0.16 * a; c.beginPath(); c.arc(X, Y, 5.5, 0, TAU); c.fill(); }
    }
    c.globalAlpha = 1;
  };
  Scene.prototype.quad = function (c, a, b, y0, y1) {
    this.proj(a, y0, 0); c.moveTo(PX, PY);
    this.proj(b, y0, 0); c.lineTo(PX, PY);
    this.proj(b, y1, 0); c.lineTo(PX, PY);
    this.proj(a, y1, 0); c.lineTo(PX, PY);
    c.closePath();
  };
  /* Газон: полосы стрижки по 5,5 м, за линией ворот — темнее */
  Scene.prototype.stripes = function (c, cam) {
    const k0 = Math.floor((cam - 55) / 5.5), k1 = Math.ceil((cam + 55) / 5.5);
    c.fillStyle = PAL.pitchB;
    c.beginPath();
    for (let k = k0; k < k1; k++) {
      if (k & 1) continue;
      const a = k * 5.5;
      if (a >= 52.5) break;
      this.quad(c, a, Math.min(52.5, a + 5.5), -34, 33);
    }
    c.fill();
    c.fillStyle = PAL.runoff;
    c.beginPath(); this.quad(c, 52.5, 80, -36, 33); c.fill();
  };
  /* Рекламные щиты у дальней бровки; после гола мигают */
  Scene.prototype.boards = function (c, s, cam, yb) {
    this.proj(0, -36, 0.9);
    const yt = PY, w = this.w;
    c.fillStyle = PAL.board; c.fillRect(0, yt, w, yb - yt);
    const pulse = s > 0.3 && s < 4.5 && !RM ? 0.5 + 0.5 * Math.sin(s * 11) : -1;
    const k0 = Math.floor((cam - 60) / 10), k1 = Math.ceil((cam + 60) / 10);
    for (let k = k0; k < k1; k++) {
      this.proj(k * 10 + 0.25, -36, 0); const a = PX;
      this.proj(k * 10 + 9.75, -36, 0); const b = PX;
      if (b < 0 || a > w) continue;
      if (pulse >= 0 && (k & 1)) { c.globalAlpha = 0.45 + 0.45 * pulse; c.fillStyle = PAL.red; }
      else c.fillStyle = PAL.boards[mod(k, 3)];
      c.fillRect(a, yt + 0.5, b - a, yb - yt - 1);
      c.globalAlpha = 1;
    }
    c.fillStyle = 'rgba(255,255,255,0.09)'; c.fillRect(0, yt, w, 1);
  };
  Scene.prototype.seg = function (c, x1, y1, x2, y2) {
    this.proj(x1, y1, 0); c.moveTo(PX, PY);
    this.proj(x2, y2, 0); c.lineTo(PX, PY);
  };
  Scene.prototype.arc = function (c, cx, cy, r, a0, a1, n) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n;
      this.proj(cx + r * Math.cos(a), cy + r * Math.sin(a), 0);
      if (i) c.lineTo(PX, PY); else c.moveTo(PX, PY);
    }
  };
  Scene.prototype.lines = function (c, cam) {
    c.strokeStyle = PAL.line; c.lineWidth = clamp(0.12 * this.F / FLEN, 0.6, 2.4); c.lineCap = 'butt';
    c.beginPath();
    this.seg(c, cam - 70, -34, 52.5, -34);
    this.seg(c, 52.5, -34, 52.5, 33);
    this.seg(c, 36, -20.16, 36, 20.16); this.seg(c, 36, -20.16, 52.5, -20.16); this.seg(c, 36, 20.16, 52.5, 20.16);
    this.seg(c, 47, -9.16, 47, 9.16); this.seg(c, 47, -9.16, 52.5, -9.16); this.seg(c, 47, 9.16, 52.5, 9.16);
    this.arc(c, 41.5, 0, 9.15, 2.2155, 4.0677, 10);
    if (cam < 36) { this.seg(c, 0, -34, 0, 33); this.arc(c, 0, 0, 9.15, 0, TAU, this.hi ? 32 : 18); }
    c.stroke();
    this.proj(41.5, 0, 0);
    c.fillStyle = PAL.line; c.beginPath(); c.ellipse(PX, PY, Math.max(0.8, 0.2 * PK), Math.max(0.5, 0.07 * PK), 0, 0, TAU); c.fill();
  };
  /* Ворота: тень внутри, задняя сетка, дальняя боковина, дальняя стойка и перекладина */
  Scene.prototype.goalBack = function (c, tau) {
    const hi = this.hi;
    c.fillStyle = 'rgba(0,0,0,0.26)';
    c.beginPath();
    this.proj(52.5, -GW, 0); c.moveTo(PX, PY);
    this.proj(52.5, -GW, GH); c.lineTo(PX, PY);
    this.proj(backX(2.3), -GW, 2.3); c.lineTo(PX, PY);
    this.proj(backX(2.3), GW, 2.3); c.lineTo(PX, PY);
    this.proj(backX(0), GW, 0); c.lineTo(PX, PY);
    this.proj(52.5, GW, 0); c.lineTo(PX, PY);
    c.closePath(); c.fill();
    // пока сетка не колышется, нити прямые — хватает двух точек
    const rip = tau > 0 && tau < 3.5;
    const NY = hi ? 14 : 7, NZ = hi ? 6 : 3, M = rip ? (hi ? 7 : 4) : 1, MH = rip ? 12 : 1;
    c.strokeStyle = PAL.net; c.lineWidth = hi ? 0.8 : 0.6;
    c.beginPath();
    for (let j = 0; j <= NY; j++) {
      const y = -GW + 2 * GW * j / NY;
      for (let m = 0; m <= M; m++) {
        const zz = 2.3 * m / M;
        this.proj(backX(zz) + netDisp(y, zz, tau), y, zz);
        if (m) c.lineTo(PX, PY); else c.moveTo(PX, PY);
      }
    }
    for (let q = 1; q <= NZ; q++) {
      const zz = 2.3 * q / NZ;
      for (let m = 0; m <= MH; m++) {
        const y = -GW + 2 * GW * m / MH;
        this.proj(backX(zz) + netDisp(y, zz, tau), y, zz);
        if (m) c.lineTo(PX, PY); else c.moveTo(PX, PY);
      }
    }
    const NS = hi ? 4 : 2;
    for (let q = 0; q <= NS; q++) {
      const zz = 2.3 * q / NS;
      this.proj(52.5, -GW, Math.min(GH, zz)); c.moveTo(PX, PY);
      this.proj(backX(zz), -GW, zz); c.lineTo(PX, PY);
    }
    c.stroke();
    c.strokeStyle = PAL.post; c.lineWidth = Math.max(1, 0.12 * this.F / FLEN); c.lineCap = 'round';
    c.beginPath();
    this.proj(52.5, -GW, 0); c.moveTo(PX, PY);
    this.proj(52.5, -GW, GH); c.lineTo(PX, PY);
    this.proj(52.5, GW, GH); c.lineTo(PX, PY);
    c.stroke();
  };
  /* Ближе к камере, чем мяч: крыша сетки, ближняя боковина, ближняя стойка */
  Scene.prototype.goalFront = function (c, tau) {
    const hi = this.hi, NY = hi ? 14 : 7;
    c.strokeStyle = PAL.net; c.lineWidth = hi ? 0.8 : 0.6;
    c.beginPath();
    for (let j = 0; j <= NY; j++) {
      const y = -GW + 2 * GW * j / NY;
      this.proj(52.5, y, GH); c.moveTo(PX, PY);
      this.proj(backX(2.3) + netDisp(y, 2.3, tau) * 0.7, y, 2.3); c.lineTo(PX, PY);
    }
    const NS = hi ? 4 : 2;
    for (let q = 0; q <= NS; q++) {
      const zz = 2.3 * q / NS;
      this.proj(52.5, GW, Math.min(GH, zz)); c.moveTo(PX, PY);
      this.proj(backX(zz), GW, zz); c.lineTo(PX, PY);
    }
    for (let q = 1; q < NS; q++) {
      const xx = 52.5 + (NB_BOT - 52.5) * q / NS;
      this.proj(xx, GW, 0); c.moveTo(PX, PY);
      this.proj(xx - 0.1, GW, 2.35); c.lineTo(PX, PY);
    }
    c.stroke();
    c.strokeStyle = PAL.post; c.lineWidth = Math.max(1, 0.12 * this.F / FLEN); c.lineCap = 'round';
    c.beginPath();
    this.proj(52.5, GW, 0); c.moveTo(PX, PY);
    this.proj(52.5, GW, GH); c.lineTo(PX, PY);
    c.stroke();
  };
  Scene.prototype.actors = function (c, s) {
    for (let i = 0; i < NCAST; i++) { castPos(i, s, P0); ACT_X[i] = P0[0]; ACT_Y[i] = P0[1]; }
    ballAt(s, BALL);
    ACT_X[NCAST] = BALL[0]; ACT_Y[NCAST] = BALL[1];
    for (let i = 0; i <= NCAST; i++) ORD[i] = i;
    ORD.sort(byY);
    for (let j = 0; j <= NCAST; j++) {
      const i = ORD[j];
      if (i === NCAST) this.ball(c, s); else this.player(c, i, s);
    }
  };
  Scene.prototype.player = function (c, i, s) {
    const p = CAST[i], x = ACT_X[i], y = ACT_Y[i];
    castPos(i, s - 0.1, P1);
    const sp = Math.hypot(x - P1[0], y - P1[1]) / 0.1;
    this.proj(x, y, 0);
    const fx = PX, fy = PY, k = PK, H = 1.8 * k;
    if (H < 2 || fx < -H || fx > this.w + H) return;
    const kit = PAL.kit[p.team];
    let tilt = 0, lift = 0, arms = false;
    if (p.gk) { gkPose(s, POSE); tilt = POSE[0]; lift = POSE[1]; }
    else if (p.team === 0 && s > 0.5 && s < 9) arms = true;
    const amp = Math.min(1, sp / 6), ph = s * 10.5 + i * 1.7;
    if (this.hi && H > 9) {
      c.fillStyle = 'rgba(0,0,0,0.18)';
      for (let q = 0; q < 4; q++) {
        const sh = SHADOWS[q];
        c.beginPath(); c.ellipse(fx + sh[0] * H, fy + sh[1] * H, 0.26 * H, 0.06 * H, sh[2], 0, TAU); c.fill();
      }
    }
    c.save();
    c.translate(fx, fy - lift * k);
    if (tilt) c.rotate(tilt);
    if (arms && s > 2.6 && !RM) c.translate(0, -Math.abs(Math.sin(s * 5.2 + i)) * 0.08 * H);
    c.lineCap = 'round';
    if (H >= 9) {
      const sw = Math.sin(ph) * amp * 0.17 * H;
      c.strokeStyle = kit.socks; c.lineWidth = Math.max(1, 0.085 * H);
      c.beginPath();
      c.moveTo(-0.04 * H, -0.47 * H); c.lineTo(sw - 0.02 * H, 0);
      c.moveTo(0.04 * H, -0.47 * H); c.lineTo(-sw + 0.02 * H, 0);
      c.stroke();
      c.fillStyle = kit.shorts; c.fillRect(-0.12 * H, -0.57 * H, 0.24 * H, 0.14 * H);
      c.strokeStyle = kit.shirt; c.lineWidth = Math.max(1, 0.07 * H);
      c.beginPath();
      if (arms) {
        c.moveTo(-0.11 * H, -0.8 * H); c.lineTo(-0.23 * H, -1.03 * H);
        c.moveTo(0.11 * H, -0.8 * H); c.lineTo(0.23 * H, -1.03 * H);
      } else {
        const a = Math.sin(ph) * amp * 0.12 * H;
        c.moveTo(-0.12 * H, -0.8 * H); c.lineTo(-0.15 * H - a, -0.56 * H);
        c.moveTo(0.12 * H, -0.8 * H); c.lineTo(0.15 * H + a, -0.56 * H);
      }
      c.stroke();
      c.fillStyle = kit.shirt;
      FJ.rrect(c, -0.13 * H, -0.87 * H, 0.26 * H, 0.33 * H, 0.06 * H); c.fill();
      c.fillStyle = PAL.skin; c.beginPath(); c.arc(0, -0.94 * H, 0.075 * H, 0, TAU); c.fill();
      if (this.hi) { c.fillStyle = PAL.hair; c.beginPath(); c.arc(0, -0.955 * H, 0.075 * H, Math.PI * 1.05, Math.PI * 1.95); c.fill(); }
    } else {
      c.strokeStyle = kit.socks; c.lineWidth = Math.max(0.8, 0.12 * H);
      c.beginPath(); c.moveTo(0, -0.3 * H); c.lineTo(0, 0); c.stroke();
      c.strokeStyle = kit.shirt; c.lineWidth = Math.max(1.2, 0.3 * H);
      c.beginPath(); c.moveTo(0, -0.34 * H); c.lineTo(0, -0.74 * H); c.stroke();
      c.fillStyle = PAL.skin; c.beginPath(); c.arc(0, -0.92 * H, Math.max(0.7, 0.09 * H), 0, TAU); c.fill();
    }
    c.restore();
  };
  Scene.prototype.ball = function (c, s) {
    const x = BALL[0], y = BALL[1], zb = BALL[2];
    this.proj(x, y, 0);
    const gk = PK;
    c.globalAlpha = 0.42 * (1 - Math.min(1, zb / 7));
    c.fillStyle = '#000';
    c.beginPath(); c.ellipse(PX, PY, Math.max(1, 0.2 * gk), Math.max(0.5, 0.07 * gk), 0, 0, TAU); c.fill();
    this.proj(x, y, zb);
    const r = Math.max(this.hi ? 1.9 : 1.3, 0.13 * PK);
    if (s > -0.5 && s < 0.02 && !RM) {
      c.fillStyle = PAL.ball;
      for (let j = 4; j >= 1; j--) {
        ballAt(s - 0.03 * j, B2);
        this.proj(B2[0], B2[1], B2[2]);
        c.globalAlpha = 0.3 * (1 - j / 5);
        c.beginPath(); c.arc(PX, PY, r * (1 - j * 0.08), 0, TAU); c.fill();
      }
      this.proj(x, y, zb);
    }
    c.globalAlpha = 1;
    c.fillStyle = PAL.ball; c.beginPath(); c.arc(PX, PY, r, 0, TAU); c.fill();
    if (this.hi && r > 2.6) { c.fillStyle = '#2b2b2e'; c.beginPath(); c.arc(PX - r * 0.18, PY - r * 0.12, r * 0.3, 0, TAU); c.fill(); }
  };
  /* Графика трансляции: плашка «ГОЛ!», счёт и хронометр, метка эфира */
  Scene.prototype.gfx = function (c, s) {
    const w = this.w, h = this.h, hi = this.hi;
    if (s > 0.35 && s < 4.4) {
      const u = clamp((s - 0.35) / 0.28, 0, 1), e = 1 - Math.pow(1 - u, 3);
      const out = clamp((4.4 - s) / 0.4, 0, 1);
      const size = Math.round(Math.min(h * (hi ? 0.2 : 0.3), w * 0.17));
      const cy = h * (hi ? 0.72 : 0.64);
      c.font = FJ.font.display(size, 800);
      const tw = c.measureText('ГОЛ!').width;
      const bw = (tw + size * 0.6) * e, bh = size * 0.98;
      c.globalAlpha = out;
      c.fillStyle = PAL.red; c.fillRect(w / 2 - bw / 2, cy - bh / 2, bw, bh);
      c.globalAlpha = out * clamp((s - 0.5) / 0.15, 0, 1);
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('ГОЛ!', w / 2, cy + size * 0.06);
      if (hi && h > 220) {
        const fs2 = Math.max(13, Math.round(h * 0.05));
        c.font = FJ.font.mono(fs2, 500);
        c.fillStyle = 'rgba(10,11,13,0.8)';
        const t2 = 'СЕВЕР 1:0 · 89′', w2 = c.measureText(t2).width + 16;
        c.fillRect(w / 2 - w2 / 2, cy + bh / 2, w2, fs2 + 10);
        c.fillStyle = '#ecebe6'; c.fillText(t2, w / 2, cy + bh / 2 + fs2 / 2 + 5);
      }
      c.globalAlpha = 1;
    }
    if (!hi || h < 170) return;
    // счёт и время матча
    const clock = 89 * 60 + 20 + s, mm = Math.floor(clock / 60), ss = Math.floor(clock - mm * 60);
    const goal = s >= 1.1, flash = goal && s < 2.8 && Math.floor((s - 1.1) * 3) % 2 === 0;
    const x0 = 12, y0 = 12, bh = 22;
    c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = FJ.font.display(16, 700);
    const wA = c.measureText('СЕВ').width + 14, wB = c.measureText('ЮГ').width + 14;
    c.font = FJ.font.display(17, 800);
    const sc = (goal ? '1' : '0') + ' : 0', wS = c.measureText(sc).width + 14;
    c.font = FJ.font.mono(12, 500);
    const clk = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0'), wC = c.measureText(clk).width + 14;
    c.fillStyle = 'rgba(10,11,13,0.84)'; c.fillRect(x0, y0, wA + wS + wB + wC, bh);
    c.fillStyle = flash ? PAL.red : '#ecebe6'; c.fillRect(x0 + wA, y0, wS, bh);
    c.font = FJ.font.display(16, 700); c.fillStyle = '#ecebe6';
    c.fillText('СЕВ', x0 + 7, y0 + bh / 2 + 1); c.fillText('ЮГ', x0 + wA + wS + 7, y0 + bh / 2 + 1);
    c.font = FJ.font.display(17, 800); c.fillStyle = flash ? '#fff' : '#121315';
    c.fillText(sc, x0 + wA + 7, y0 + bh / 2 + 1);
    c.font = FJ.font.mono(12, 500); c.fillStyle = '#bfc0c3';
    c.fillText(clk, x0 + wA + wS + wB + 7, y0 + bh / 2 + 1);
    // метка эфира
    c.font = FJ.font.mono(12, 500);
    const lt = 'ЭФИР', lw = c.measureText(lt).width + 24;
    c.fillStyle = 'rgba(10,11,13,0.84)'; c.fillRect(w - 12 - lw, y0, lw, bh);
    c.fillStyle = PAL.red; c.beginPath(); c.arc(w - 12 - lw + 9, y0 + bh / 2, 3.5, 0, TAU); c.fill();
    c.fillStyle = '#ecebe6'; c.fillText(lt, w - 12 - lw + 17, y0 + bh / 2 + 1);
  };

  /* =================================================================
     Глава: состояние, мультивьюер, бюджет, сравнение
     ================================================================= */
  const SEG_LABEL = { tv: 'Эфирное ТВ', hls6: 'HLS · 6' + NB + 'с', hls2: 'HLS/DASH · 2' + NB + 'с', llhls: 'LL‑HLS', lldash: 'LL‑DASH (чанки)', webrtc: 'WebRTC', moq: 'MoQ · эксп.' };
  const SHORT = { tv: 'Антенна', hls6: 'HLS 6' + NB + 'с', hls2: 'DASH 2' + NB + 'с', llhls: 'LL‑HLS', lldash: 'LL‑DASH', webrtc: 'WebRTC', moq: 'MoQ' };
  const WHO = { webrtc: 'сосед с WebRTC', lldash: 'сосед с LL‑DASH', tv: 'сосед с антенной', llhls: 'сосед с LL‑HLS', hls2: 'сосед с DASH по 2' + NB + 'с', hls6: 'сосед с HLS по 6' + NB + 'с' };
  /* Где сейчас кадр гола — для подписи на полосе бюджета */
  const WHERE = {
    broadcast: { enc: 'кодируется', pack: 'мультиплексируется', cdn: 'летит через спутник', req: 'летит через спутник', hold: 'в буфере приёмника', dec: 'декодируется' },
    hls: { enc: 'кодируется', pack: 'ждёт конца сегмента', cdn: 'идёт по CDN', req: 'скачивается', hold: 'лежит в буфере плеера', dec: 'декодируется' },
    llhls: { enc: 'кодируется', pack: 'ждёт конца части', cdn: 'идёт по CDN', req: 'скачивается', hold: 'лежит в буфере плеера', dec: 'декодируется' },
    lldash: { enc: 'кодируется', pack: 'ждёт конца чанка', cdn: 'идёт по CDN', req: 'скачивается', hold: 'лежит в буфере плеера', dec: 'декодируется' },
    webrtc: { enc: 'кодируется', pack: 'режется на пакеты', cdn: 'на медиасервере', req: 'в пути к зрителю', hold: 'в джиттер-буфере', dec: 'декодируется' },
    moq: { enc: 'кодируется', pack: 'становится объектом', cdn: 'идёт через релеи', req: 'в пути к зрителю', hold: 'в буфере плеера', dec: 'декодируется' },
  };
  const CHAT = [
    { t: -1e9, who: 'кв. 41', text: 'кто смотрит финал?' },
    { t: -6, who: 'кв. 12', text: 'я, по антенне' },
    { t: -1.5, who: 'кв. 12', text: 'давай, давай…' },
    { t: 'goal', who: 'кв. 12', text: 'ГОООЛ!!! 1:0', hot: true },
    { t: 'after', who: 'кв. 30', text: 'не пиши! у меня ещё атака' },
  ];

  const st = {
    t: -4, T0: -4, T1: 30, playing: false, done: false, auto: false, drag: false, wasPlaying: false, speed: 1,
    tpl: 'hls6', cfg: M.cfgOf('hls6'), budget: null, list: null, res: null, L: {}, scr: {},
    frameNo: 0, domT: 0,
  };
  let prevT = st.t;
  const ui = {};
  const tiles = [];
  let pgm = null, tl = null, bar = null, cmp = null, COL = null;
  const vis = { wall: false, tl: false, bar: false, cmp: false };
  let dirtyTl = true, dirtyBar = true, dirtyCmp = true;
  let cmpRows = [];

  function readCols() {
    const c = FJ.colors;
    COL = {
      comp: { enc: c.violet, pack: c.q5, cdn: c.blue, req: c.q3, hold: c.amber, dec: c.q1 },
      red: c.red, amber: c.amber, text: c.text, text2: c['text-2'], muted: c.muted, line: c.line, line2: c['line-2'],
    };
  }

  function recompute() {
    st.budget = M.budget(st.cfg);
    st.list = M.raceSetup(st.cfg);
    st.res = M.race(st.list);
    st.L = {}; st.scr = {};
    let mx = 0;
    for (const x of st.list) { st.L[x.id] = x.L; if (x.L > mx) mx = x.L; }
    for (const x of st.res.screens) st.scr[x.id] = x;
    st.T1 = Math.max(12, mx + 3.5);
    if (st.t > st.T1) st.t = st.T1;
    dirtyTl = dirtyBar = dirtyCmp = true;
  }

  /* ---------- мультивьюер ---------- */
  function buildWall() {
    const wall = el('div', { class: 'live-wall' });
    const scr = el('div', { class: 'monitor__screen', role: 'img', 'aria-label': 'Стадион: момент гола в реальном времени' });
    ui.tc = el('span', { class: 'v', text: fmtTc(st.t) });
    ui.ff = el('span', { class: 'live-ff', html: ICON.ff + '×' + M.SPEED.ff });
    wall.append(el('div', { class: 'monitor live-mon live-mon--pgm' }, [
      scr,
      el('div', { class: 'umd' }, [el('span', { class: 'tally on' }), el('span', { class: 'lbl', text: 'Стадион' }), el('span', { class: 'live-umd-note', text: 'реальное время' }), ui.ff, ui.tc]),
    ]));
    pgm = new Scene(scr, true);
    for (const nb of M.NEIGHBOURS) {
      const isChat = nb.kind === 'chat', isYou = nb.id === 'you';
      const scr2 = el('div', { class: 'monitor__screen' });
      const tile = { id: nb.id, nb, scene: null, state: '', chat: null };
      if (isChat) {
        tile.msgs = CHAT.map(m => el('div', { class: 'live-msg' + (m.hot ? ' is-hot' : ''), html: '<b>' + m.who.replace(' ', NB) + '</b> ' + ty(m.text) }));
        tile.typing = el('div', { class: 'live-typing', html: 'кв.' + NB + '12 печатает<i></i><i></i><i></i>' });
        scr2.append(el('div', { class: 'live-chat' }, [
          el('div', { class: 'live-chat__head' }, [el('span', { text: 'Чат дома' }), el('span', { text: '38' + NB + 'участников' })]),
          el('div', { class: 'live-chat__list' }, tile.msgs),
          tile.typing,
        ]));
        scr2.setAttribute('role', 'img');
        scr2.setAttribute('aria-label', 'Чат дома: сосед пишет о голе через ' + fs(M.CHAT_DELAY) + ' после того, как увидел его по антенне');
      } else {
        tile.scene = new Scene(scr2, false);
        tile.spoilHead = el('span', { class: 'live-spoil__h' });
        tile.spoilTxt = el('span', { class: 'live-spoil__t' });
        tile.res = el('span', { class: 'live-res' });
        scr2.append(el('div', { class: 'live-spoil', 'aria-hidden': 'true' }, [tile.spoilHead, tile.spoilTxt]), tile.res);
        scr2.setAttribute('role', 'img');
      }
      tile.scr = scr2;
      tile.tally = el('span', { class: 'tally' });
      tile.lbl = el('span', { class: 'lbl', text: nb.label });
      tile.v = el('span', { class: 'v' });
      tile.mon = el('div', { class: 'monitor live-mon' + (isYou ? ' live-mon--you' : '') + (isChat ? ' live-mon--chat' : '') }, [
        scr2, el('div', { class: 'umd' }, [tile.tally, tile.lbl, tile.v]),
      ]);
      wall.append(tile.mon);
      tiles.push(tile);
    }
    ui.waves = el('div', { class: 'live-waves', 'aria-hidden': 'true' });
    wall.append(ui.waves);
    ui.wall = wall;
    return wall;
  }

  /* Подписи плиток, которые зависят от настроек (задержка «Вы», источник спойлера) */
  function paintTileLabels() {
    for (const tile of tiles) {
      const L = st.L[tile.id];
      tile.v.textContent = (tile.id === 'chat' ? '+' : '') + fs(L);
      if (tile.id === 'you') tile.lbl.textContent = 'Вы: ' + SHORT[st.tpl];
      if (tile.scene) {
        tile.scr.setAttribute('aria-label', (tile.id === 'you' ? 'Ваш вариант, ' + SEG_LABEL[st.tpl] : 'Сосед: ' + tile.nb.label) + ', гол через ' + fs(L));
        const sc = st.scr[tile.id];
        tile.spoilHead.innerHTML = sc.by === 'chat' ? ICON.chat + '<b>«ГОЛ!» в' + NB + 'чате</b>' : ICON.sound + '<b>«ГОЛ!» из' + NB + 'окна</b>';
        tile.res.textContent = sc.spoilAt != null ? 'спойлер за ' + fs(sc.lead) : st.res.first && st.res.first.id === tile.id ? 'первым' : '';
        tile.res.classList.toggle('is-first', sc.spoilAt == null);
      }
      tile.state = '';
    }
  }

  function updateTiles(texts) {
    const t = st.t;
    for (const tile of tiles) {
      const L = st.L[tile.id];
      if (tile.id === 'chat') {
        const state = t >= L ? 'sent' : 'wait';
        for (let i = 0; i < CHAT.length; i++) {
          const m = CHAT[i], at = m.t === 'goal' ? L : m.t === 'after' ? L + 2.6 : m.t;
          tile.msgs[i].classList.toggle('is-on', t >= at);
        }
        tile.typing.classList.toggle('is-on', t >= st.L.tv + 0.3 && t < L);
        if (state !== tile.state) { tile.state = state; tile.tally.className = 'tally' + (state === 'sent' ? ' warn' : ''); tile.mon.classList.toggle('is-seen', state === 'sent'); }
        continue;
      }
      const sc = st.scr[tile.id];
      const state = t >= L ? 'seen' : sc.spoilAt != null && t >= sc.spoilAt ? 'spoiled' : 'wait';
      if (state !== tile.state) {
        tile.state = state;
        tile.mon.classList.toggle('is-seen', state === 'seen');
        tile.mon.classList.toggle('is-spoiled', state === 'spoiled');
        tile.tally.className = 'tally' + (state === 'seen' ? ' on' : state === 'spoiled' ? ' warn' : '');
      }
      if (texts && state === 'spoiled') tile.spoilTxt.textContent = 'до' + NB + 'гола ' + fs(Math.max(0, L - t));
    }
  }

  /* Волна звука от соседа, который увидел гол */
  function ring(tile, big) {
    if (RM || !ui.waves || !ui.wall.getBoundingClientRect) return;
    const wr = ui.wall.getBoundingClientRect(), r = tile.mon.getBoundingClientRect();
    const x = r.left + r.width / 2 - wr.left, y = r.top + r.height / 2 - wr.top;
    const n = big ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const e = el('i', { class: 'live-ring' + (big ? ' big' : ''), style: { left: x + 'px', top: y + 'px', animationDelay: (i * 0.22) + 's' } });
      e.addEventListener('animationend', () => e.remove());
      ui.waves.append(e);
    }
  }
  function stepEvents(a, b) {
    if (!(b > a) || b - a > 0.6) return;
    for (const tile of tiles) {
      if (tile.id === 'chat') continue;
      const L = st.L[tile.id];
      if (a < L && L <= b) ring(tile, !!(st.res.first && st.res.first.id === tile.id));
    }
    const Ly = st.L.you;
    if ((a < Ly && Ly <= b) || (a < st.T1 && st.T1 <= b)) paintSummary();
  }

  function paintSummary() {
    const L = st.L.you, you = st.scr.you, first = st.res.first;
    if (st.t < L && !st.done) {
      ui.sum.innerHTML = ty('У кого индикатор стал <b>красным</b> — тот увидел гол. <b>Янтарный</b> — о голе уже слышно, но на экране его ещё нет.');
      return;
    }
    let s;
    if (first && first.id === 'you') s = '<b>Вы увидели гол первым</b> — через ' + fs(L) + '. Теперь соседей спойлерите вы.';
    else if (first) {
      s = '<b>Первым гол увидел ' + (WHO[first.id] || first.id) + '</b> — через ' + fs(first.L) + '. Вы — через ' + fs(L);
      if (you.spoilAt == null) s += ', одновременно с ним.';
      else if (you.by === 'chat') s += ': сообщение в чате опередило вас на ' + fs(you.lead) + '.';
      else {
        s += ': шум из окна опередил вас на ' + fs(you.lead);
        const cl = L - st.L.chat;
        s += cl > 0 ? ', сообщение в чате — на ' + fs(cl) + '.' : '.';
      }
    }
    ui.sum.innerHTML = ty(s);
  }

  function paintUmd() {
    ui.tc.textContent = fmtTc(st.t);
    ui.ff.classList.toggle('is-on', st.playing && st.speed > 1.3);
  }
  function paintPlay() {
    ui.play.innerHTML = st.playing ? ICON.pause : ICON.play;
    ui.play.setAttribute('aria-label', st.playing ? 'Пауза' : 'Смотреть');
    ui.play.setAttribute('aria-pressed', String(st.playing));
  }
  function replay() {
    st.t = st.T0; prevT = st.t; st.done = false; st.playing = true;
    if (ui.waves) ui.waves.innerHTML = '';
    paintPlay(); paintSummary(); updateTiles(true);
    dirtyTl = dirtyBar = true;
  }
  function togglePlay() {
    if (st.playing) { st.playing = false; paintPlay(); return; }
    if (st.t >= st.T1 - 1e-6) { replay(); return; }
    st.playing = true; paintPlay();
  }
  function seek(t) {
    st.t = clamp(t, st.T0, st.T1);
    prevT = st.t;
    st.done = st.t >= st.T1 - 1e-6;
    dirtyTl = dirtyBar = true;
    updateTiles(true); paintSummary(); paintUmd();
  }

  /* ---------- шкала времени ---------- */
  function tlX(t, w) { return 10 + (t - st.T0) / (st.T1 - st.T0) * (w - 20); }
  function drawTimeline() {
    const c = tl.ctx, w = tl.w, h = tl.h;
    tl.clear();
    if (w < 40) return;
    const yT = h - 26;
    // ускоренные промежутки
    c.fillStyle = FJ.alpha(COL.amber, 0.16);
    let run = -1;
    const ev = st.res.events;
    for (let x = 10; x <= w - 10 + 3; x += 3) {
      const t = st.T0 + (x - 10) / (w - 20) * (st.T1 - st.T0);
      const fast = x <= w - 10 && M.speedAt(t, ev) > 1.6;
      if (fast && run < 0) run = x;
      if (!fast && run >= 0) {
        c.fillRect(run, yT - 5, x - run, 10);
        if (x - run > 44) { c.font = FJ.font.mono(12); c.fillStyle = FJ.alpha(COL.amber, 0.9); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('×' + M.SPEED.ff, (run + x) / 2, yT - 12); c.fillStyle = FJ.alpha(COL.amber, 0.16); }
        run = -1;
      }
    }
    // дорожка и пройденное
    c.fillStyle = COL.line2; c.fillRect(10, yT - 1, w - 20, 2);
    const xp = tlX(st.t, w);
    c.fillStyle = COL.text2; c.fillRect(10, yT - 1, Math.max(0, xp - 10), 2);
    // деления
    c.font = FJ.font.mono(12); c.fillStyle = COL.muted; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    const ticks = FJ.ticks(st.T0, st.T1, w < 480 ? 5 : 8);
    for (const v of ticks) {
      const X = tlX(v, w);
      c.fillRect(Math.round(X), yT + 4, 1, 4);
      c.fillText(v === 0 ? '0' : fmt.num(v, 0), X, h - 3);
    }
    c.textAlign = 'right'; c.fillText('с', w - 1, h - 3);
    // события: гол на стадионе, соседи, чат
    const items = [{ t: 0, label: 'Гол', kind: 'stadium' }];
    for (const tile of tiles) items.push({ t: st.L[tile.id], label: tile.id === 'you' ? 'Вы' : tile.id === 'chat' ? 'Чат' : tile.nb.label, kind: tile.id });
    items.sort((a, b) => a.t - b.t);
    const rows = [-1e9, -1e9, -1e9];
    c.font = FJ.font.mono(12); c.textBaseline = 'alphabetic';
    for (const it of items) {
      const X = tlX(it.t, w), seen = st.t >= it.t;
      const col = it.kind === 'chat' ? COL.amber : seen ? COL.red : it.kind === 'you' ? COL.text : COL.text2;
      c.fillStyle = col;
      if (it.kind === 'chat') { c.beginPath(); c.moveTo(X, yT - 5); c.lineTo(X + 4, yT); c.lineTo(X, yT + 5); c.lineTo(X - 4, yT); c.closePath(); c.fill(); }
      else c.fillRect(Math.round(X) - 1, yT - 6, 2, 12);
      const tw = c.measureText(it.label).width;
      let lx = clamp(X - tw / 2, 0, w - tw);
      let row = -1;
      for (let r = 0; r < 3; r++) if (lx > rows[r] + 6) { row = r; break; }
      if (row < 0) continue;
      rows[row] = lx + tw;
      const ly = 12 + row * 13;
      c.globalAlpha = 0.45; c.fillRect(Math.round(X), ly + 3, 1, yT - 7 - ly - 3); c.globalAlpha = 1;
      c.fillStyle = it.kind === 'you' ? COL.text : col;
      c.textAlign = 'left';
      c.fillText(it.label, lx, ly);
    }
    // плейхед
    c.fillStyle = COL.red;
    c.fillRect(Math.round(xp) - 1, 2, 2, yT + 6);
    c.beginPath(); c.arc(xp, yT, 5, 0, TAU); c.fill();
  }

  /* ---------- полоса бюджета «Вы» с кадром гола ---------- */
  function drawBar() {
    const c = bar.ctx, w = bar.w, h = bar.h, b = st.budget;
    bar.clear();
    if (w < 40) return;
    const top = 22, bh = 22, W = w - 2, sc = W / b.worst;
    let x = 1;
    c.textBaseline = 'middle';
    for (const p of b.parts) {
      const pw = p.v * sc;
      if (pw > 0.2) {
        c.fillStyle = COL.comp[p.id];
        c.fillRect(x, top, Math.max(0.6, pw - (pw > 3 ? 1 : 0)), bh);
        if (pw > 34) {
          const comp = M.COMPONENTS.find(q => q.id === p.id);
          c.font = FJ.font.mono(12, 500); c.fillStyle = '#121315'; c.textAlign = 'left';
          let txt = comp.short + ' ' + fs(p.v);
          if (c.measureText(txt).width > pw - 8) txt = fs(p.v);
          if (c.measureText(txt).width <= pw - 8) c.fillText(txt, x + 4, top + bh / 2 + 1);
        }
      }
      x += pw;
    }
    if (b.worst > b.total + 1e-6) {
      c.strokeStyle = COL.comp.pack; c.lineWidth = 1; c.setLineDash([3, 3]);
      c.strokeRect(x + 0.5, top + 0.5, Math.max(0, W + 1 - x - 1), bh - 1);
      c.setLineDash([]);
    }
    // шкала
    c.font = FJ.font.mono(12); c.fillStyle = COL.muted; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText('0', 1, h - 3);
    const xt = 1 + b.total * sc;
    c.fillStyle = COL.text2; c.fillRect(Math.round(xt), top + bh, 1, 5);
    const tTot = 'в' + NB + 'среднем ' + fs(b.total), tW = b.worst > b.total + 1e-6 ? 'худший ' + fs(b.worst) : '';
    c.textAlign = 'right';
    if (tW) {
      c.fillStyle = COL.muted; c.fillText(tW, w - 1, h - 3);
      const wW = c.measureText(tW).width, wT = c.measureText(tTot).width;
      c.fillStyle = COL.text2;
      c.fillText(tTot, Math.min(xt + wT / 2, w - 1 - wW - 12), h - 3);
    } else { c.fillStyle = COL.text2; c.fillText(tTot, w - 1, h - 3); }
    // кадр гола
    const t = st.t, tt = clamp(t, 0, b.total), mx = 1 + tt * sc;
    let label;
    if (t < 0) label = ty('гол ещё не забит');
    else if (t >= b.total) label = ty('кадр гола на экране');
    else {
      let acc = 0, where = b.parts[0].id;
      for (const p of b.parts) { if (tt < acc + p.v) { where = p.id; break; } acc += p.v; }
      label = ty('кадр гола ' + WHERE[b.kind][where]);
    }
    c.fillStyle = COL.red; c.fillRect(Math.round(mx) - 1, top - 5, 2, bh + 10);
    c.fillStyle = '#fff'; c.fillRect(Math.round(mx) - 3, top - 9, 6, 5);
    c.font = FJ.font.text(12, 500); c.fillStyle = COL.text; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    const lw = c.measureText(label).width;
    c.fillText(label, clamp(mx - lw / 2, 0, w - lw), 12);
  }

  /* ---------- сравнение режимов ---------- */
  function cmpLayout(w) {
    const narrow = w < 560;
    const ids = ['you'].concat(M.ORDER);
    let y = 4;
    const rows = ids.map(id => {
      const tpl = id === 'you' ? st.tpl : id;
      const refs = M.REFS[tpl] || [];
      const hRow = (narrow ? 38 : 26) + 11 * refs.length + (refs.length ? 4 : 0);
      const r = { id, tpl, refs, y, h: hRow };
      y += hRow;
      return r;
    });
    return { narrow, rows, hAxis: y + 6, height: y + 30 };
  }
  function drawCmp() {
    const c = cmp.ctx, w = cmp.w;
    const lay = cmpLayout(w);
    const need = Math.round(lay.height);
    if (Math.abs(ui.cmpHost.offsetHeight - need) > 1 && ui.cmpHost.style.height !== need + 'px') { ui.cmpHost.style.height = need + 'px'; dirtyCmp = true; return; }
    cmp.clear();
    if (w < 60) return;
    const narrow = lay.narrow;
    const x0 = narrow ? 0 : 150, x1 = w - (narrow ? 2 : 64);
    let max = 0;
    const B = {};
    for (const r of lay.rows) {
      const b = r.id === 'you' ? st.budget : M.budget(M.cfgOf(r.id));
      B[r.id] = b;
      max = Math.max(max, b.worst);
      for (const f of r.refs) max = Math.max(max, f.b);
    }
    const ticks = FJ.ticks(0, max * 1.04, narrow ? 4 : 6);
    const xmax = Math.max(ticks[ticks.length - 1], max * 1.04);
    const sx = v => x0 + v / xmax * (x1 - x0);
    // сетка и ось
    c.fillStyle = COL.line;
    for (const v of ticks) c.fillRect(Math.round(sx(v)), 0, 1, lay.hAxis);
    c.font = FJ.font.mono(12); c.fillStyle = COL.muted; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    for (const v of ticks) c.fillText(fmt.num(v, 0) + (v === ticks[ticks.length - 1] ? NB + 'с' : ''), clamp(sx(v), 12, w - 16), lay.hAxis + 18);
    cmpRows = [];
    for (const r of lay.rows) {
      const b = B[r.id], you = r.id === 'you';
      const exp = !you && M.PRESETS[r.id].exp;
      const barY = r.y + (narrow ? 18 : 5), bh = narrow ? 10 : 12;
      if (you) { c.fillStyle = 'rgba(255,255,255,0.04)'; c.fillRect(0, r.y, w, r.h - 2); c.fillStyle = COL.text; c.fillRect(0, r.y, 2, r.h - 2); }
      if (!you && r.id === st.tpl) { c.fillStyle = COL.text2; c.fillRect(0, r.y + 2, 2, r.h - 6); }
      // подпись
      c.textBaseline = 'middle'; c.textAlign = 'left';
      c.font = FJ.font.text(13, you ? 600 : 400); c.fillStyle = you ? COL.text : COL.text2;
      const label = you ? 'Вы: ' + SHORT[st.tpl] : exp ? 'MoQ · эксперимент' : M.PRESETS[r.id].name;
      c.fillText(label, 8, narrow ? r.y + 9 : barY + bh / 2 + 1);
      // полоса
      let acc = 0;
      c.globalAlpha = exp ? 0.55 : 1;
      for (const p of b.parts) {
        const a = sx(acc), e = sx(acc + p.v);
        if (e - a > 0.15) { c.fillStyle = COL.comp[p.id]; c.fillRect(a, barY, Math.max(0.6, e - a - (e - a > 3 ? 1 : 0)), bh); }
        acc += p.v;
      }
      c.globalAlpha = 1;
      if (exp) { c.strokeStyle = COL.text2; c.setLineDash([3, 3]); c.lineWidth = 1; c.strokeRect(x0 + 0.5, barY + 0.5, Math.max(1, sx(b.total) - x0 - 1), bh - 1); c.setLineDash([]); }
      if (b.worst > b.total + 1e-6) {
        c.strokeStyle = COL.comp.pack; c.setLineDash([2, 3]); c.lineWidth = 1;
        c.strokeRect(Math.round(sx(b.total)) + 0.5, barY + 0.5, Math.max(1, sx(b.worst) - sx(b.total) - 1), bh - 1);
        c.setLineDash([]);
      }
      // значение
      c.font = FJ.font.mono(12, 500); c.fillStyle = you ? COL.text : COL.text2;
      if (narrow) { c.textAlign = 'right'; c.fillText(fs(b.total), w - 2, r.y + 9); }
      else { c.textAlign = 'left'; c.fillText(fs(b.total), sx(b.worst) + 6, barY + bh / 2 + 1); }
      // скобки из источников
      c.font = FJ.font.mono(12); c.textBaseline = 'middle';
      r.refs.forEach((f, i) => {
        const y = barY + bh + 8 + i * 11 + 0.5, a = sx(f.a), e = sx(f.b);
        c.strokeStyle = FJ.alpha(COL.text2, 0.75); c.lineWidth = 1;
        c.beginPath(); c.moveTo(a, y - 3); c.lineTo(a, y); c.lineTo(e, y); c.lineTo(e, y - 3); c.stroke();
        if (f.mark != null) { const m = sx(f.mark); c.fillStyle = COL.text; c.fillRect(Math.round(m) - 1, y - 4, 2, 5); }
        const txt = f.label + ' ' + fmt.num(f.a, f.a % 1 ? 1 : 0) + '–' + fmt.num(f.b, f.b % 1 ? 1 : 0) + NB + 'с' + (f.mark != null ? ', ' + fmt.num(f.mark, 1) + NB + 'с по' + NB + 'умолч.' : '');
        const tw = c.measureText(txt).width;
        c.fillStyle = COL.muted;
        if (e + 6 + tw <= w) { c.textAlign = 'left'; c.fillText(txt, e + 6, y); }
        else if (a - 6 - tw >= x0) { c.textAlign = 'right'; c.fillText(txt, a - 6, y); }
        else { c.textAlign = 'right'; c.fillText(txt, w - 1, y - 6); }
      });
      cmpRows.push({ y0: r.y, y1: r.y + r.h, id: r.id });
    }
  }

  /* ---------- формула, правила, цена ---------- */
  function termHtml(term) { return term.replace(/t_([^\s+·/]+)/g, 't<sub>$1</sub>'); }
  function describe(p, b) {
    const c = b.cfg, k = fmt.num(c.k, c.k % 1 ? 1 : 0);
    const hops = c.hops + NB + '×' + NB + ms(c.hop);
    const T = {
      broadcast: {
        enc: 'кодер эфира: длинный просмотр вперёд и статистический мультиплекс',
        pack: 'сборка транспортного потока MPEG‑TS',
        cdn: 'спутник, кабель или наземный эфир',
        req: 'запросов нет: сигнал идёт всем сразу',
        hold: 'буфер приёмника',
        dec: 'декодер и обработка картинки в телевизоре',
      },
      hls: {
        enc: 'захват и кодирование: просмотр вперёд, GOP',
        pack: 'кадр ждёт, пока допишется сегмент; в худшем случае — весь TD' + NB + '=' + NB + fs(c.seg),
        cdn: 'ориджин → щит → край: ' + hops,
        req: 'запрос сегмента и загрузка: ' + ms(c.rtt) + ' + ' + fs(c.seg) + ' × ' + fmt.mbps(c.bitrate, 0) + ' / ' + fmt.mbps(c.bw, 0),
        hold: 'HOLD-BACK: плеер стартует в ' + k + ' сегментах от края плейлиста',
        dec: 'декодирование и вывод',
      },
      llhls: {
        enc: 'кодер с коротким просмотром вперёд',
        pack: 'кадр ждёт конца части; в худшем случае — всю часть ' + fs(c.part),
        cdn: 'ориджин → щит → край: ' + hops,
        req: 'запрос части уже ждёт на сервере (preload hint): RTT/2 и загрузка',
        hold: 'PART-HOLD-BACK' + NB + '=' + NB + k + NB + '×' + NB + 'часть',
        dec: 'декодирование и вывод',
      },
      lldash: {
        enc: 'кодер с коротким просмотром вперёд',
        pack: 'кадр ждёт конца чанка CMAF; в худшем случае — весь чанк ' + fs(c.part),
        cdn: 'ориджин → щит → край, чанки идут насквозь: ' + hops,
        req: 'сегмент уже запрошен, чанки приходят по мере готовности',
        hold: 'буфер плеера ' + k + NB + '×' + NB + 'чанк; цель задаёт ServiceDescription',
        dec: 'декодирование и вывод',
      },
      webrtc: {
        enc: 'кодер без B‑кадров и просмотра вперёд',
        pack: 'кадр сразу режется на RTP‑пакеты',
        cdn: 'медиасервер (SFU) пересылает пакеты',
        req: 'доставка до зрителя, без запросов',
        hold: 'джиттер-буфер выравнивает пакеты',
        dec: 'декодирование и вывод',
      },
      moq: {
        enc: 'кодер с коротким просмотром вперёд',
        pack: 'объект MoQ — один кадр: ждать сегмента не нужно',
        cdn: 'релеи пересылают объекты подписчикам: ' + hops,
        req: 'доставка по QUIC, без опроса',
        hold: 'буфер плеера',
        dec: 'декодирование и вывод',
      },
    };
    return T[b.kind][p.id];
  }
  function paramsLine(b) {
    const c = b.cfg, k = fmt.num(c.k, c.k % 1 ? 1 : 0);
    const net = 'n' + NB + '=' + NB + c.hops + ' · t<sub>хоп</sub>' + NB + '=' + NB + ms(c.hop) + ' · RTT' + NB + '=' + NB + ms(c.rtt) + ' · R' + NB + '=' + NB + fmt.mbps(c.bitrate, 0) + ' · B' + NB + '=' + NB + fmt.mbps(c.bw, 0);
    switch (b.kind) {
      case 'hls': return 'TD' + NB + '=' + NB + fs(c.seg) + ' · k' + NB + '=' + NB + k + ' · ' + net;
      case 'llhls': return 'p' + NB + '=' + NB + fs(c.part) + ' · k' + NB + '=' + NB + k + ' · ' + net;
      case 'lldash': return 'c' + NB + '=' + NB + fs(c.part) + ' · k' + NB + '=' + NB + k + ' · ' + net;
      case 'webrtc': case 'moq': return 'RTT' + NB + '=' + NB + ms(c.rtt) + ' · остальное — типичные значения';
      default: return 'этапы эфирной цепочки — модель; итог сверен с замером BBC';
    }
  }
  function paintFormula() {
    const b = st.budget;
    ui.eq.innerHTML = '<span class="k">L</span> = ' + b.parts.map(p => '<span class="t" style="--c:' + cssCol(p.id) + '">' + termHtml(p.term) + '</span>').join(' + ');
    ui.frows.innerHTML = b.parts.map(p => {
      const comp = M.COMPONENTS.find(q => q.id === p.id);
      return '<div class="live-fr"><i style="--c:' + cssCol(p.id) + '"></i><span class="n">' + termHtml(p.term) + '</span><span class="v">' + fs(p.v) + '</span><span class="d"><b>' + comp.name + '.</b> ' + ty(describe(p, b)) + '</span></div>';
    }).join('');
    const worst = b.worst > b.total + 1e-6 ? ' · <span class="w">' + fs(b.worst) + ' в' + NB + 'худшем случае</span>' : '';
    ui.fsum.innerHTML = 'L = <b>' + fs(b.total) + '</b> в' + NB + 'среднем' + worst;
    ui.fparams.innerHTML = paramsLine(b);
  }
  function ruleText(r, c) {
    const k = fmt.num(c.k, c.k % 1 ? 1 : 0), cite = FJ.cite;
    switch (r.id) {
      case 'hb-ok': return 'HOLD-BACK' + NB + '=' + NB + k + NB + '×' + NB + 'TD — не меньше 3' + NB + '×' + NB + 'TD, как требует спецификация' + cite('hls');
      case 'hb-must': return 'HOLD-BACK' + NB + '=' + NB + k + NB + '×' + NB + 'TD — меньше 3' + NB + '×' + NB + 'TD: нарушено MUST спецификации' + cite('hls');
      case 'phb-ok': return 'PART-HOLD-BACK' + NB + '=' + NB + k + NB + '×' + NB + 'часть — норма и для спецификации, и для Apple' + cite('apple-auth');
      case 'phb-should': return 'PART-HOLD-BACK меньше 3' + NB + 'частей: ниже SHOULD спецификации и MUST Apple' + cite('apple-auth');
      case 'phb-must': return 'PART-HOLD-BACK меньше 2' + NB + 'частей: нарушено MUST спецификации' + cite('hls');
      case 'rtt-ok': return 'часть ≥ 3' + NB + '×' + NB + 'RTT — как советует Apple' + cite('apple-auth');
      case 'rtt-should': return 'часть < 3' + NB + '×' + NB + 'RTT: ниже SHOULD Apple' + cite('apple-auth');
      case 'rtt-must': return 'часть короче P95 RTT: нарушено MUST Apple' + cite('apple-auth');
      case 'cte': return 'загрузка идёт со скоростью кодировщика: «байты / время» мерит поток, а не сеть';
      case 'sfu': return 'нет HTTP-кэша: каждый зритель — сессия на медиасервере';
      case 'moq': return 'эксперимент: черновик IETF, цифры — ориентир, а не замер';
      default: return 'ни запросов, ни буфера плеера: сигнал идёт всем сразу';
    }
  }
  function paintRules() {
    const rs = M.rules(st.cfg);
    ui.rules.innerHTML = rs.map(r => '<span class="live-rule ' + r.level + '">' + (r.level === 'ok' ? ICON.ok : r.level === 'info' ? ICON.info : ICON.warn) + '<span>' + ty(ruleText(r, st.cfg)) + '</span></span>').join('');
  }
  function paintStats() {
    const b = st.budget, rq = M.requests(st.cfg, 1e6), you = st.scr.you;
    let reqV, reqL;
    switch (rq.kind) {
      case 'http':
        reqV = fmtCount(rq.total) + '/с';
        reqL = b.kind === 'hls' ? 'запросов к CDN на 1' + NB + 'млн зрителей: плейлист и сегмент раз в TD'
          : b.kind === 'llhls' ? 'запросов к CDN на 1' + NB + 'млн зрителей: плейлист и часть раз в часть'
            : 'запросов к CDN на 1' + NB + 'млн зрителей: один долгий запрос на сегмент';
        break;
      case 'sessions': reqV = '1' + NB + 'млн'; reqL = 'сессий на медиасерверах вместо HTTP-запросов'; break;
      case 'subs': reqV = '1' + NB + 'млн'; reqL = 'подписок на релеях вместо опроса'; break;
      default: reqV = '0'; reqL = 'запросов нет: эфир идёт всем сразу';
    }
    const cells = [
      [fs(b.total), 'задержка в среднем' + (b.worst > b.total + 1e-6 ? ', в худшем случае ' + fs(b.worst) : '')],
      [fs(b.buffer), b.kind === 'broadcast' ? 'буфер приёмника: запросов и сети нет' : 'запас буфера: столько сеть может молчать без остановки'],
      [reqV, reqL],
      [you.spoilAt == null ? '0' + NB + 'с' : fs(you.lead), you.spoilAt == null ? 'вы увидите гол раньше соседей или вместе с ними' : 'на столько ' + (you.by === 'chat' ? 'чат' : 'шум из окна') + ' опережает ваш гол'],
    ];
    ui.stats.innerHTML = cells.map(([v, l]) => '<div class="stat"><b>' + v + '</b><span>' + ty(l) + '</span></div>').join('');
  }

  /* ---------- ползунки ---------- */
  function kFmt(v) {
    const c = st.cfg, k = fmt.num(v, v % 1 ? 1 : 0);
    if (c.kind === 'hls') return k + NB + '×' + NB + 'TD' + NB + '=' + NB + fs(v * c.seg);
    return k + NB + '×' + NB + (c.kind === 'llhls' ? 'p' : 'c') + NB + '=' + NB + fs(v * c.part);
  }
  function syncSliders() {
    const kind = st.cfg.kind;
    const setLabel = (s, txt) => { const l = s.host.querySelector('label'); if (l) l.textContent = txt; };
    ui.sSeg.host.hidden = kind !== 'hls';
    ui.sPart.host.hidden = kind !== 'llhls' && kind !== 'lldash';
    ui.sK.host.hidden = !(kind === 'hls' || kind === 'llhls' || kind === 'lldash');
    ui.sRtt.host.hidden = kind === 'broadcast';
    ui.sHops.host.hidden = !(kind === 'hls' || kind === 'llhls' || kind === 'lldash' || kind === 'moq');
    setLabel(ui.sHops, kind === 'moq' ? 'Релеи MoQ, n' : 'Уровни CDN, n');
    ui.note.hidden = kind !== 'broadcast';
    setLabel(ui.sPart, kind === 'lldash' ? 'Чанк CMAF, c' : 'Часть, PART-TARGET');
    setLabel(ui.sK, kind === 'hls' ? 'HOLD-BACK' : kind === 'llhls' ? 'PART-HOLD-BACK' : 'Буфер плеера');
    if (st.cfg.seg != null) ui.sSeg.set(st.cfg.seg);
    if (st.cfg.part != null) ui.sPart.set(st.cfg.part);
    if (st.cfg.k != null) ui.sK.set(st.cfg.k);
    ui.sRtt.set(Math.round(st.cfg.rtt * 1000));
    ui.sHops.set(st.cfg.hops);
  }
  function changed() {
    recompute();
    paintFormula(); paintRules(); paintStats(); paintTileLabels(); updateTiles(true); paintSummary();
    if (ui.sK && st.cfg.k != null) ui.sK.set(st.cfg.k);
  }
  function selectTpl(v) {
    st.tpl = v;
    st.cfg = M.cfgOf(v, { rtt: st.cfg.rtt, hops: st.cfg.hops });
    ui.seg.set(v);
    syncSliders();
    changed();
  }

  function buildCfg() {
    const box = el('div', { class: 'panel live-cfg' });
    const segHost = el('div', { class: 'live-modes' });
    ui.seg = FJ.seg(segHost, M.ORDER.map(id => ({ v: id, label: SEG_LABEL[id] })), st.tpl, selectTpl);
    const sl = el('div', { class: 'live-sliders' });
    const mk = o => { const host = el('div'); sl.append(host); const s = FJ.slider(host, o); s.host = host; return s; };
    ui.sSeg = mk({ id: 'liveSeg', label: 'Сегмент, TARGETDURATION', min: 1, max: 10, step: 0.5, value: 6, fmt: v => fs(v), onInput: v => { st.cfg.seg = v; changed(); } });
    ui.sPart = mk({ id: 'livePart', label: 'Часть, PART-TARGET', min: 0.2, max: 2, step: 0.05, value: 1, fmt: v => fs(v), onInput: v => { st.cfg.part = v; changed(); } });
    ui.sK = mk({ id: 'liveK', label: 'HOLD-BACK', min: 2, max: 4, step: 0.5, value: 3, fmt: kFmt, onInput: v => { st.cfg.k = v; changed(); } });
    ui.sHops = mk({ id: 'liveHops', label: 'Уровни CDN, n', min: 1, max: 4, step: 1, value: 2, fmt: v => v + NB + '×' + NB + ms(st.cfg.hop), onInput: v => { st.cfg.hops = v; changed(); } });
    ui.sRtt = mk({ id: 'liveRtt', label: 'RTT до' + NB + 'края CDN (P95)', min: 10, max: 200, step: 5, value: 40, fmt: v => v + NB + 'мс', onInput: v => { st.cfg.rtt = v / 1000; changed(); } });
    ui.note = el('p', { class: 'live-note', text: ty('В эфирной цепочке крутить нечего: ни сегментов, ни запросов, ни буфера плеера.') });
    sl.append(ui.note);
    ui.rules = el('div', { class: 'live-rules', 'aria-live': 'polite' });
    const barHost = el('div', { class: 'fig__canvas live-bar', role: 'img', 'aria-label': 'Бюджет задержки вашего варианта по этапам и положение кадра гола' });
    ui.eq = el('div', { class: 'live-eq' });
    ui.frows = el('div', { class: 'live-frows' });
    ui.fsum = el('div', { class: 'live-fsum' });
    ui.fparams = el('div', { class: 'live-fparams' });
    const shoot = el('button', { class: 'btn', type: 'button', html: ICON.replay + 'Пустить кадр гола', onclick: () => { replay(); } });
    ui.stats = el('div', { class: 'stat-row live-stats' });
    box.append(
      el('div', { class: 'live-cfg__top' }, [el('span', { class: 'ctl-label', text: 'Основа' }), segHost]),
      sl, ui.rules,
      el('div', { class: 'live-cfg__bar' }, [barHost, el('div', { class: 'row' }, [shoot, el('span', { class: 'caption', text: ty('Красная метка — кадр гола: где он сейчас на пути к вашему экрану.') })])]),
      el('div', { class: 'live-formula', role: 'group', 'aria-label': 'Формула задержки' }, [ui.eq, ui.frows, ui.fsum, ui.fparams]),
      ui.stats,
    );
    return { box, barHost };
  }

  /* ---------- текст главы ---------- */
  function chapterText() {
    const c = FJ.cite;
    return [
      '<p><strong>Фильм каждый включает, когда захочет, матч&nbsp;— все сразу.</strong> К&nbsp;началу финала Лиги чемпионов 30&nbsp;мая 2026&nbsp;года Okko обслуживал больше 1&nbsp;млн авторизаций; пик раздачи&nbsp;— 7,8&nbsp;Тбит/с на&nbsp;собственной CDN и&nbsp;больше 10&nbsp;Тбит/с вместе с&nbsp;внешними' + c('okko-ucl') + '.</p>',
      '<p><strong>И&nbsp;все просят один файл</strong>&nbsp;— свежий сегмент, которого секунду назад не&nbsp;было. В&nbsp;кэшах его нет, и&nbsp;CDN должна склеить тысячи одинаковых промахов в&nbsp;один запрос к&nbsp;ориджину. В&nbsp;nginx такая склейка (<code>proxy_cache_lock</code>) по&nbsp;умолчанию выключена' + c('nginx-lock') + ', а&nbsp;Netflix держит запрос ещё не&nbsp;вышедшего сегмента открытым до&nbsp;публикации' + c('nf-origin') + '.</p>',
      '<p><strong>Задержка&nbsp;— решение продукта.</strong> Большой буфер спасает от&nbsp;сбоев сети, но&nbsp;тогда гол раньше приходит из&nbsp;чата или из‑за стены. Отчёт DVB и&nbsp;DASH‑IF описывает ровно это: в&nbsp;спорт‑баре с&nbsp;большой задержкой гости слышат, как радуются соседи, раньше, чем видят гол. Планка&nbsp;— эфир: у&nbsp;BBC от&nbsp;входа кодера до&nbsp;экрана 3–6&nbsp;с' + c('dvb-ll') + '.</p>',
      '<p><strong>В&nbsp;обычном HLS задержку задаёт буфер.</strong> Плееру не&nbsp;следует стартовать ближе к&nbsp;концу плейлиста, чем HOLD-BACK, а&nbsp;он не&nbsp;меньше 3&nbsp;×&nbsp;TD, трёх длительностей сегмента' + c('hls') + ': при сегментах по&nbsp;6&nbsp;с это 18&nbsp;с ещё до&nbsp;кодирования и&nbsp;сети. Обзор IEEE даёт для классического HLS 12–30&nbsp;с' + c('ll-survey') + '. Netflix режет эфир на&nbsp;2‑секундные сегменты и&nbsp;A/B‑тестами сократил задержку примерно на&nbsp;10&nbsp;с' + c('nf-live') + '.</p>',
      '<p><strong>LL‑HLS делит сегмент на&nbsp;части</strong> (<code>EXT-X-PART</code>) и&nbsp;убирает опрос. Следующую часть плеер просит заранее по&nbsp;<code>EXT-X-PRELOAD-HINT</code>, а&nbsp;плейлист&nbsp;— блокирующим запросом <code>?_HLS_msn=M&amp;_HLS_part=N</code>, который сервер держит, пока часть не&nbsp;появится' + c('hls') + '. Запас PART-HOLD-BACK&nbsp;— от&nbsp;двух частей по&nbsp;спецификации и&nbsp;от&nbsp;трёх у&nbsp;Apple' + c('apple-auth') + '. Цель Apple&nbsp;— 1–2&nbsp;с «в&nbsp;масштабе»' + c('wwdc19') + '.</p>',
      '<p><strong>Цена&nbsp;— запросы.</strong> Плейлист перезапрашивают раз в&nbsp;часть. При частях по&nbsp;1&nbsp;с: 1&nbsp;млн зрителей × 1&nbsp;запрос/с = 1&nbsp;млн запросов плейлиста в&nbsp;секунду на&nbsp;каждую дорожку и&nbsp;ещё столько&nbsp;же за&nbsp;частями. Ориджин это выдержит, только если CDN склеит одинаковые запросы.</p>',
      '<p><strong>LL‑DASH идёт другим путём:</strong> сегмент один, но&nbsp;кодировщик пишет его чанками CMAF, а&nbsp;CDN отдаёт их по&nbsp;мере готовности' + c('dashif-ll') + '. Загрузка идёт со&nbsp;скоростью кодировщика, и&nbsp;«байты / время» мерит битрейт потока, а&nbsp;не&nbsp;ёмкость канала' + c('ll-survey') + '. Поэтому в&nbsp;dash.js есть свои алгоритмы: L2A‑LL' + c('dashjs-l2a') + ' и&nbsp;LoL+, который вырезает паузы между чанками' + c('dashjs-lolp') + '. В&nbsp;LL‑HLS этой беды нет: сервер не&nbsp;отдаёт ни&nbsp;байта части, пока не&nbsp;сможет отправить её целиком на&nbsp;полной скорости' + c('hls') + '.</p>',
      '<p><strong>Дальше&nbsp;— меньше секунды.</strong> WebRTC даёт меньше 0,5&nbsp;с' + c('cf-webrtc') + ', но&nbsp;без HTTP‑кэшей: каждый зритель&nbsp;— отдельная сессия. Media over QUIC строит раздачу на&nbsp;подписках: дорожки, группы от&nbsp;ключевого кадра, объекты поверх QUIC или WebTransport; черновик IETF дошёл до&nbsp;21‑й версии' + c('moq') + ', у&nbsp;Cloudflare релеи в&nbsp;330+&nbsp;городах' + c('cf-moq') + '. Мерить задержку у&nbsp;каждого зрителя поможет CMCD v2: ключ <code>ltc</code>&nbsp;— время от&nbsp;появления кадра на&nbsp;ориджине до&nbsp;показа' + c('cmcd-b') + '.</p>',
    ].join('');
  }

  /* ---------- стили главы ---------- */
  const CSS = `
#fig-live { gap: 16px; }
#fig-live .seg button { min-height: 40px; }
#fig-live input[type="range"] { height: 40px; }
#fig-live .btn { min-height: 40px; }
.live-sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-family: var(--f-mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-top: 18px; }
.live-sub:first-child { margin-top: 0; }
.live-sub .n { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px; border: 1px solid var(--line-2); border-radius: 2px; color: var(--text); letter-spacing: 0; }
.live-sub b { color: var(--text); font-weight: 500; letter-spacing: .08em; }

.live-wall { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.live-mon { position: relative; padding: 4px; gap: 4px; }
.live-mon .monitor__screen canvas { position: absolute; inset: 0; }
.live-mon .umd { font-size: 12px; padding: 2px 6px; min-height: 24px; gap: 6px; }
.live-mon .umd .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.live-mon .umd .v { color: var(--muted); }
.live-mon.is-seen .umd .v { color: var(--text); }
.live-mon--pgm { grid-column: 1 / 3; grid-row: 1 / 3; display: flex; flex-direction: column; }
.live-mon--pgm .monitor__screen { flex: 1 1 auto; aspect-ratio: auto; min-height: 150px; }
.live-mon--pgm .umd { min-height: 30px; }
.live-mon--pgm .umd .v { font-family: var(--f-led); font-size: 19px; letter-spacing: .04em; color: var(--text); }
.live-umd-note { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.live-ff { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; color: var(--amber); opacity: 0; transition: opacity .2s var(--ease); }
.live-ff.is-on { opacity: 1; }
.live-ff svg { width: 12px; height: 12px; }
.live-ff + .v { margin-left: 8px; }
.live-mon--you { border-color: #6a6d74; }
.live-mon--you .umd .lbl { font-weight: 600; }
.live-spoil { position: absolute; left: 4px; right: 4px; bottom: 4px; display: grid; gap: 1px; padding: 3px 6px; background: rgba(10,11,13,.88); border-left: 2px solid var(--amber); border-radius: 2px; font: 500 12px/1.3 var(--f-mono); color: var(--text-2); opacity: 0; transform: translateY(6px); transition: opacity .25s var(--ease), transform .25s var(--ease); pointer-events: none; }
.live-spoil__h { display: flex; align-items: center; gap: 5px; min-width: 0; white-space: nowrap; overflow: hidden; }
.live-spoil__h b { color: var(--amber); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.live-spoil__h svg { width: 12px; height: 12px; flex: none; color: var(--amber); }
.live-spoil__t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live-mon.is-spoiled .live-spoil { opacity: 1; transform: none; }
.live-res { position: absolute; left: 4px; top: 4px; font: 500 12px/1 var(--f-mono); padding: 3px 6px; border-radius: 2px; background: rgba(10,11,13,.84); color: var(--amber); opacity: 0; transition: opacity .3s var(--ease); pointer-events: none; }
.live-res:empty { display: none; }
.live-res.is-first { color: var(--text); }
.live-mon.is-seen .live-res { opacity: 1; }
.live-waves { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 3; border-radius: 6px; }
.live-ring { position: absolute; width: 380px; height: 380px; margin: -190px 0 0 -190px; border-radius: 50%; border: 2px solid var(--amber); opacity: 0; transform: scale(.06); animation: live-ring 1.2s var(--ease) forwards; }
.live-ring.big { width: 1500px; height: 1500px; margin: -750px 0 0 -750px; border-width: 3px; animation-duration: 2s; }
@keyframes live-ring { 0% { opacity: .9; transform: scale(.04); } 70% { opacity: .3; } 100% { opacity: 0; transform: scale(1); } }

.live-chat { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: #0e1013; font: 400 12px/1.3 var(--f-text); color: var(--text-2); }
.live-chat__head { display: flex; justify-content: space-between; gap: 6px; font: 500 12px/1 var(--f-mono); color: var(--muted); white-space: nowrap; overflow: hidden; }
.live-chat__list { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 3px; overflow: hidden; }
.live-msg { display: none; align-self: flex-start; max-width: 100%; padding: 2px 7px; border-radius: 2px 8px 8px 8px; background: #1d1f24; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
.live-msg b { font-weight: 600; color: var(--muted); margin-right: 3px; }
.live-msg.is-on { display: block; animation: live-pop .25s var(--ease) both; }
.live-msg.is-hot { background: #3b2a0e; color: #ffe0a8; }
.live-msg.is-hot b { color: var(--amber); }
.live-typing { display: none; align-items: center; gap: 3px; font: 400 12px/1 var(--f-text); color: var(--muted); }
.live-typing.is-on { display: flex; }
.live-typing i { width: 4px; height: 4px; border-radius: 50%; background: var(--muted); animation: live-dot 1s infinite; }
.live-typing i:nth-of-type(2) { animation-delay: .15s; }
.live-typing i:nth-of-type(3) { animation-delay: .3s; }
@keyframes live-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes live-dot { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }

.live-tl { position: relative; height: 74px; touch-action: pan-y; cursor: ew-resize; border-radius: 2px; }
.live-tl:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.live-ctl { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
.live-sum { flex: 1 1 260px; min-width: 0; margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-2); }
.live-sum b { color: var(--text); font-weight: 600; }

.live-cfg { display: grid; gap: 16px; padding: 16px; }
.live-cfg__top { display: grid; gap: 8px; }
.live-sliders { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 28px; }
.live-sliders > [hidden] { display: none !important; }
.live-sliders .slider { min-width: 0; }
.live-note { margin: 0; font-size: 14px; color: var(--muted); grid-column: 1 / -1; }
.live-rules { display: flex; flex-wrap: wrap; gap: 6px 8px; }
.live-rules:empty { display: none; }
.live-rule { display: inline-flex; align-items: flex-start; gap: 6px; max-width: 100%; font: 400 12px/1.4 var(--f-mono); color: var(--text-2); border: 1px solid var(--line-2); border-radius: 2px; padding: 5px 8px; }
.live-rule svg { width: 13px; height: 13px; flex: none; margin-top: 1px; }
.live-rule.ok svg { color: var(--q4); }
.live-rule.info svg { color: var(--muted); }
.live-rule.should { border-color: rgba(255,176,46,.65); color: #ffe3b3; }
.live-rule.should svg { color: var(--amber); }
.live-rule.must { border-color: rgba(255,77,61,.75); color: #ffd9d4; }
.live-rule.must svg { color: var(--red); }
.live-cfg__bar { display: grid; gap: 8px; }
.live-bar { height: 62px; }
.live-formula { display: grid; gap: 10px; padding: 12px 14px; background: #111214; border: 1px solid var(--line); border-radius: var(--r-m); font: 400 12.5px/1.6 var(--f-mono); color: var(--text-2); }
.live-formula sub { font-size: 12px; line-height: 0; vertical-align: -0.25em; }
.live-eq { color: var(--text); font-size: 14px; word-spacing: .02em; }
.live-eq .k { color: var(--text); font-weight: 600; }
.live-eq .t { color: var(--c); white-space: nowrap; }
.live-frows { display: grid; gap: 5px; }
.live-fr { display: grid; grid-template-columns: 10px minmax(0, 13ch) 7ch minmax(0, 1fr); gap: 2px 10px; align-items: baseline; }
.live-fr i { width: 10px; height: 10px; border-radius: 1px; background: var(--c); align-self: center; }
.live-fr .n { color: var(--text); white-space: nowrap; }
.live-fr .v { color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.live-fr .d { font: 400 13px/1.45 var(--f-text); color: var(--muted); }
.live-fr .d b { color: var(--text-2); font-weight: 500; }
.live-fsum { color: var(--text-2); border-top: 1px solid var(--line); padding-top: 8px; }
.live-fsum b { color: var(--text); font-weight: 600; }
.live-fsum .w { color: var(--q5); }
.live-fparams { font-size: 12px; color: var(--muted); }
.live-stats .stat b { font-size: 30px; }
.live-cmp { height: 380px; cursor: pointer; }
@media (max-width: 640px) {
  .live-wall { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .live-mon--pgm { grid-column: 1 / -1; grid-row: auto; }
  .live-mon--pgm .monitor__screen { flex: none; aspect-ratio: 16 / 9; min-height: 0; }
  .live-umd-note { display: none; }
  .live-sliders { grid-template-columns: minmax(0, 1fr); }
  .live-fr { grid-template-columns: 10px minmax(0, 1fr) auto; }
  .live-fr .d { grid-column: 2 / -1; }
}
@media (prefers-reduced-motion: reduce) {
  .live-ring { display: none; }
  .live-msg.is-on, .live-typing i { animation: none; }
}
`;

  /* ---------- сборка ---------- */
  function sub(n, text) { return el('div', { class: 'live-sub' }, [el('span', { class: 'n', text: n }), el('b', { text })]); }

  function mount(fig) {
    readCols();
    FJ.addStyle(CSS);
    const text = FJ.$('#liveText');
    if (text) text.innerHTML = chapterText();
    recompute();

    // А · мультивьюер
    const wall = buildWall();
    const tlHost = el('div', { class: 'fig__canvas live-tl', tabindex: '0', role: 'slider', 'aria-label': 'Время от гола на стадионе, секунды', 'aria-valuemin': String(st.T0), 'aria-valuemax': String(Math.round(st.T1)), 'aria-valuenow': String(st.t) });
    ui.tlHost = tlHost;
    ui.play = el('button', { class: 'iconbtn', type: 'button', onclick: togglePlay });
    const again = el('button', { class: 'btn', type: 'button', html: ICON.replay + 'Повторить гол', onclick: replay });
    ui.sum = el('p', { class: 'live-sum', 'aria-live': 'polite' });
    fig.append(
      sub('А', 'Соседи смотрят один матч'),
      wall, tlHost,
      el('div', { class: 'live-ctl' }, [ui.play, again, ui.sum]),
      el('p', { class: 'caption', html: ty('Задержки — типичные значения модели из&nbsp;блока «Б», а&nbsp;не&nbsp;замеры конкретных сервисов. Сосед в&nbsp;чате смотрит эфир по&nbsp;антенне и&nbsp;пишет через ' + fmt.num(M.CHAT_DELAY, 1) + '&nbsp;с после гола — иллюстративно. Между событиями ролик ускорен в&nbsp;' + M.SPEED.ff + '&nbsp;раз; шкалу можно тянуть.') }),
    );

    // Б · бюджет
    const cfg = buildCfg();
    fig.append(sub('Б', 'Куда уходят секунды: ваш вариант'), cfg.box);

    // В · сравнение
    const cmpHost = el('div', { class: 'fig__canvas live-cmp', role: 'img', 'aria-label': 'Задержка всех режимов по этапам и диапазоны из источников' });
    ui.cmpHost = cmpHost;
    const legend = el('div', { class: 'legend' }, M.COMPONENTS.map(cp => el('span', null, [el('i', { class: 'box', style: { '--c': cssCol(cp.id) } }), cp.name])));
    const c = FJ.cite;
    fig.append(
      sub('В', ty('Все режимы: модель и замеры')),
      cmpHost, legend,
      el('p', { class: 'caption', html: ty('Полосы — модель, пунктир — худший случай, когда кадр попал в&nbsp;начало сегмента или части. Скобки — диапазоны из&nbsp;источников: эфир 3–6&nbsp;с по&nbsp;замеру BBC' + c('dvb-ll') + ', большинство замеров&nbsp;— 3–10&nbsp;с' + c('dashif-ll') + '; обычный HLS 12–30&nbsp;с и&nbsp;LL‑HLS 2–6&nbsp;с' + c('ll-survey') + '; цель LL‑HLS 1–2&nbsp;с' + c('wwdc19') + '; LL‑DASH 2–10&nbsp;с, по&nbsp;умолчанию 3,5&nbsp;с' + c('dashif-ll') + '; WebRTC меньше 0,5&nbsp;с' + c('cf-webrtc') + '; MoQ — обещание Cloudflare «меньше секунды»' + c('cf-moq') + '. Нажмите на&nbsp;строку, чтобы взять режим за&nbsp;основу.') }),
    );

    // холсты
    tl = FJ.canvas(tlHost, { onResize: () => { dirtyTl = true; } });
    bar = FJ.canvas(cfg.barHost, { onResize: () => { dirtyBar = true; } });
    cmp = FJ.canvas(cmpHost, { onResize: () => { dirtyCmp = true; } });

    // шкала времени: тянуть и клавиши
    const pick = e => {
      const r = tl.cv.getBoundingClientRect();
      seek(st.T0 + clamp((e.clientX - r.left - 10) / Math.max(1, r.width - 20), 0, 1) * (st.T1 - st.T0));
    };
    tlHost.addEventListener('pointerdown', e => {
      st.drag = true; st.wasPlaying = st.playing;
      if (tlHost.setPointerCapture) try { tlHost.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      pick(e);
    });
    tlHost.addEventListener('pointermove', e => { if (st.drag) pick(e); });
    const endDrag = () => { if (!st.drag) return; st.drag = false; if (st.wasPlaying && st.t < st.T1) { st.playing = true; } paintPlay(); };
    tlHost.addEventListener('pointerup', endDrag);
    tlHost.addEventListener('pointercancel', endDrag);
    tlHost.addEventListener('keydown', e => {
      const step = e.shiftKey ? 5 : 0.5;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { seek(st.t - step); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { seek(st.t + step); e.preventDefault(); }
      else if (e.key === 'Home') { seek(st.T0); e.preventDefault(); }
      else if (e.key === 'End') { seek(st.T1); e.preventDefault(); }
      else if (e.key === ' ' || e.key === 'Enter') { togglePlay(); e.preventDefault(); }
    });
    // сравнение: строка — основа для «Вы»
    cmpHost.addEventListener('click', e => {
      const r = cmp.cv.getBoundingClientRect(), y = e.clientY - r.top;
      const row = cmpRows.find(q => y >= q.y0 && y < q.y1);
      if (row && row.id !== 'you') selectTpl(row.id);
    });

    // что видно: рисуем только видимое; ролик стартует, когда мультивьюер виден наполовину
    if (root.IntersectionObserver) {
      const io = new IntersectionObserver(es => {
        for (const e of es) {
          const key = e.target.__live;
          const was = vis[key];
          vis[key] = e.isIntersecting;
          if (e.isIntersecting && !was) {
            if (key === 'wall') { pgm.dirty = true; for (const t of tiles) if (t.scene) t.scene.dirty = true; }
            if (key === 'tl') dirtyTl = true;
            if (key === 'bar') dirtyBar = true;
            if (key === 'cmp') dirtyCmp = true;
          }
          if (key === 'wall' && e.intersectionRatio >= 0.45) autoplay();
        }
      }, { threshold: [0, 0.45] });
      wall.__live = 'wall'; tlHost.__live = 'tl'; cfg.barHost.__live = 'bar'; cmpHost.__live = 'cmp';
      [wall, tlHost, cfg.barHost, cmpHost].forEach(n => io.observe(n));
    } else { vis.wall = vis.tl = vis.bar = vis.cmp = true; }

    syncSliders();
    changed();
    paintPlay(); paintUmd();
  }

  function autoplay() {
    if (st.auto) return;
    st.auto = true;
    if (RM) { seek(st.T1); return; }
    st.t = st.T0; prevT = st.t; st.playing = true; paintPlay();
  }

  function drawWall() {
    const t = st.t;
    if (pgm.dirty || pgm.lastS !== t) pgm.draw(t);
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i], sc = tile.scene;
      if (!sc) continue;
      const s = t - st.L[tile.id];
      if (!sc.dirty && sc.lastS === s) continue;
      if (st.playing && !sc.dirty && (st.frameNo + i) % 3) continue;   // маленькие мониторы — 20 кадров/с, по очереди
      sc.draw(s);
    }
  }

  function frame(dt) {
    st.frameNo++;
    if (st.playing && !st.drag) {
      st.speed = M.speedAt(st.t, st.res.events);
      st.t = Math.min(st.T1, st.t + st.speed * dt);
      if (st.t >= st.T1) { st.playing = false; st.done = true; paintPlay(); }
    } else st.speed = 1;
    if (st.t !== prevT) {
      stepEvents(prevT, st.t);
      prevT = st.t;
      dirtyTl = dirtyBar = true;
      updateTiles(false);
    }
    if (vis.wall) drawWall();
    if (vis.tl && dirtyTl) { drawTimeline(); dirtyTl = false; }
    if (vis.bar && dirtyBar) { drawBar(); dirtyBar = false; }
    if (vis.cmp && dirtyCmp) { dirtyCmp = false; drawCmp(); }
    st.domT += dt;
    if (st.domT > 0.1) {
      st.domT = 0;
      updateTiles(true); paintUmd();
      ui.tlHost.setAttribute('aria-valuenow', String(Math.round(st.t * 10) / 10));
      ui.tlHost.setAttribute('aria-valuetext', fmtTc(st.t) + ' от гола на стадионе');
    }
  }

  FJ.figure({
    id: 'live', el: FJ.$('#fig-live'),
    mount,
    start() {
      pgm.dirty = true;
      for (const t of tiles) if (t.scene) t.scene.dirty = true;
      dirtyTl = dirtyBar = dirtyCmp = true;
    },
    stop() { /* цикл кадров снимается сам: ролик замирает и продолжится при возвращении */ },
    frame,
  });
})(typeof window !== 'undefined' ? window : globalThis);

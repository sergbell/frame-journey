// Тесты модели CDN: аппроксимация Че против прямой симуляции LRU,
// предзаливка, схлопывание запросов, премьера, отказ узла.
// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/00-util.js');
const cdn = require('../js/40-cdn.js');

const pp = x => (x * 100).toFixed(2) + ' п. п.';

test('Че против прямой симуляции LRU: N = 2000, α = 0,8, 300 тыс. запросов — в пределах ±2 п. п.', () => {
  for (const C of [100, 200, 400]) {
    const che = cdn.hitLRU(0.8, 2000, C);
    const sim = cdn.simulateLRU(0.8, 2000, C, 300000, 12345 + C);
    assert.ok(Math.abs(che - sim) <= 0.02, `C=${C}: Че ${pp(che)}, симуляция ${pp(sim)}`);
  }
});

test('Че держится и при другом α (0,6 и 1,2)', () => {
  for (const alpha of [0.6, 1.2]) {
    const che = cdn.hitLRU(alpha, 2000, 200);
    const sim = cdn.simulateLRU(alpha, 2000, 200, 300000, 777);
    assert.ok(Math.abs(che - sim) <= 0.02, `α=${alpha}: Че ${pp(che)}, симуляция ${pp(sim)}`);
  }
});

test('Корзины каталога не искажают ответ: N = 20 000, расхождение с точным расчётом < 0,3 п. п.', () => {
  for (const C of [200, 2000, 10000]) {
    const exact = cdn.lruStats(cdn.catalog(0.8, 20000, { exact: true }), C).hit;
    const binned = cdn.lruStats(cdn.catalog(0.8, 20000), C).hit;
    assert.ok(Math.abs(exact - binned) < 0.003, `C=${C}: ${pp(exact)} против ${pp(binned)}`);
    const pe = cdn.prefillStats(cdn.catalog(0.8, 20000, { exact: true }), C, 1).hit;
    const pb = cdn.prefillStats(cdn.catalog(0.8, 20000), C, 1).hit;
    assert.ok(Math.abs(pe - pb) < 0.003, `предзаливка C=${C}: ${pp(pe)} против ${pp(pb)}`);
  }
});

test('Предзаливка с точным прогнозом не хуже LRU при том же C', () => {
  for (const alpha of [0.6, 0.8, 1.0, 1.2]) {
    for (const C of [20, 200, 2000, 10000]) {
      const lru = cdn.hitLRU(alpha, 20000, C);
      const pre = cdn.hitPrefill(alpha, 20000, C, 0);
      assert.ok(pre >= lru - 1e-12, `α=${alpha}, C=${C}: предзаливка ${pp(pre)} < LRU ${pp(lru)}`);
    }
  }
  // и совпадает с долей C самых популярных (точно — на точном каталоге, в корзинах — до 0,1 п. п.)
  const p = cdn.zipf(0.8, 20000);
  let top = 0; for (let i = 0; i < 2000; i++) top += p[i];
  assert.ok(Math.abs(cdn.hitPrefill(0.8, 20000, 2000, 0, { exact: true }) - top) < 1e-9);
  assert.ok(Math.abs(cdn.hitPrefill(0.8, 20000, 2000, 0) - top) < 1e-3);
});

test('Шумный прогноз: аналитика совпадает с Монте-Карло, а большой шум проигрывает LRU', () => {
  for (const sigma of [0.5, 1, 2]) {
    const a = cdn.hitPrefill(0.8, 20000, 4000, sigma);
    const mc = cdn.simulatePrefill(0.8, 20000, 4000, sigma, 99);
    assert.ok(Math.abs(a - mc) < 0.01, `σ=${sigma}: ${pp(a)} против ${pp(mc)}`);
  }
  const lru = cdn.hitLRU(0.8, 20000, 4000);
  assert.ok(cdn.hitPrefill(0.8, 20000, 4000, 0.3) > lru, 'точный прогноз должен выигрывать');
  assert.ok(cdn.hitPrefill(0.8, 20000, 4000, 2.5) < lru, 'ошибка в e^2,5 ≈ 12 раз должна проигрывать');
});

test('Шилд за узлом: промахи до ориджина = (1 − h_узла)(1 − h_шилда), шилд видит хвост', () => {
  const t = cdn.tier({ alpha: 0.8, N: 20000, C: 10000, mode: 'lru' });
  assert.ok(Math.abs(t.fOrigin - (1 - t.hEdge) * (1 - t.hShield)) < 1e-12);
  // поток промахов площе исходного: тот же кэш на нём попадает хуже
  assert.ok(t.hShield < t.hShieldDirect, `${pp(t.hShield)} ≥ ${pp(t.hShieldDirect)}`);
  assert.ok(t.fOrigin > 0 && t.fOrigin < 0.05);
});

test('Схлопывание: один запрос наверх на объект, пока загрузка короче proxy_cache_lock_timeout', () => {
  // 1000 запросов к одному сегменту за 0,5 с, промах идёт 0,2 с
  const arr = Array.from({ length: 1000 }, (_, i) => i * 0.0005);
  assert.equal(cdn.upstreamRequests(arr, 0.2, { collapse: true }), 1);
  // без схлопывания наверх уходят все, кто пришёл до конца первой загрузки: 1 + λ·F
  const up = cdn.upstreamRequests(arr, 0.2, { collapse: false });
  assert.equal(up, 400);
  assert.ok(Math.abs(cdn.upstreamFluid(2000, 0.2, { collapse: false }) - 401) < 1e-9);
  assert.equal(cdn.upstreamFluid(2000, 0.2, { collapse: true }), 1);
});

test('Схлопывание на нескольких узлах: наверх ровно по одному запросу на объект с каждого узла', () => {
  const rnd = cdn.rng(5);
  let total = 0;
  const edges = 14, objects = 30;
  for (let e = 0; e < edges; e++) for (let o = 0; o < objects; o++) {
    const n = 50 + Math.floor(rnd() * 500);
    const arr = Array.from({ length: n }, () => o * 2 + rnd() * 1.5).sort((a, b) => a - b);
    total += cdn.upstreamRequests(arr, 0.3 + rnd() * 0.5, { collapse: true });
  }
  assert.equal(total, edges * objects);
});

test('Таймаут замка nginx (5 с): при медленном ориджине ждавшие дольше 5 с идут наверх сами', () => {
  const arr = Array.from({ length: 800 }, (_, i) => i * 0.01);   // 100 запросов/с в течение 8 с
  const up = cdn.upstreamRequests(arr, 7, { collapse: true });
  // пришедшие в [0; 2) с ждут дольше 5 с (200 шт.), и ещё один наполняющий через lock_age
  assert.ok(up > 150 && up < 260, 'up=' + up);
  assert.ok(up < cdn.upstreamRequests(arr, 7, { collapse: false }));
});

test('RTT по оптике: Москва — Владивосток ≈ 96 мс с маршрутом ×1,5 (минимум по прямой ≈ 64 мс)', () => {
  const d = cdn.km({ lat: 55.7558, lon: 37.6173 }, { lat: 43.1155, lon: 131.8855 });
  assert.ok(d > 6350 && d < 6480, 'd=' + d);
  const rtt = cdn.rttMs(d) - cdn.K.LOCAL_MS;
  assert.ok(rtt > 94 && rtt < 98, 'rtt=' + rtt);
  assert.ok(2 * d / cdn.K.FIBER > 63 && 2 * d / cdn.K.FIBER < 65);
});

test('Суточная кривая: пик около 21:00, ночной минимум, окно заливки 02–14', () => {
  let best = 0, arg = 0;
  for (let h = 0; h < 24; h += 0.05) { const v = cdn.dayShape(h); if (v > best) { best = v; arg = h; } }
  assert.ok(Math.abs(best - 1) < 1e-3 && Math.abs(arg - 21) < 0.25, `max ${best} в ${arg}`);
  assert.ok(cdn.dayShape(4) < 0.2);
  assert.ok(cdn.inFill(2) && cdn.inFill(13.9) && !cdn.inFill(14) && !cdn.inFill(21));
});

test('Сеть в 21:00: все живы, узлы не перегружены, ориджин с запасом', () => {
  const sim = new cdn.Sim();
  const m = sim.step(0);
  const peakG = cdn.K.PEAK_VIEWERS * cdn.K.BITRATE / 1e9;
  assert.ok(m.totalG <= peakG + 1 && m.totalG > 0.95 * peakG, 'totalG=' + m.totalG);
  for (const e of m.edges) assert.ok(e.util < 0.95, e.id + ' ' + e.util);
  assert.ok(m.originUtil < 1 && m.queueS === 0);
  assert.ok(Math.abs(m.offload - m.hitNominal) < 1e-9, 'без событий отдача с узлов = h узла');
  assert.ok(m.rtt50 < 1 && m.rtt95 < 15, `${m.rtt50} / ${m.rtt95}`);
});

test('Местное время: у каждого города свой вечерний пик, окно заливки — по местным часам', () => {
  // пик страны — около 21:00 по Москве и равен PEAK_VIEWERS
  let best = 0, arg = 0;
  for (let h = 0; h < 24; h += 0.05) { const v = cdn.nationShape(h); if (v > best) { best = v; arg = h; } }
  assert.ok(arg > 20 && arg < 21.5, 'пик в ' + arg);
  assert.ok(Math.abs(best * cdn.VIEW_SCALE - cdn.K.PEAK_VIEWERS) < 1e-3 * cdn.K.PEAK_VIEWERS);
  const sim = new cdn.Sim({ t: 14 * 3600 });                 // 14:00 МСК = 21:00 во Владивостоке
  const vvo = cdn.EDGES.findIndex(e => e.id === 'vvo'), spb = cdn.EDGES.findIndex(e => e.id === 'spb');
  const a = sim.step(0);
  const uVvo14 = a.edges[vvo].util, uSpb14 = a.edges[spb].util;
  sim.t = 21 * 3600;
  const b = sim.step(0);
  assert.ok(uVvo14 > 2 * b.edges[vvo].util, 'Владивосток: пик в 14:00 МСК');
  assert.ok(b.edges[spb].util > 2 * uSpb14, 'Петербург: пик в 21:00 МСК');
  // предзаливка: в 20:00 МСК (03:00 во Владивостоке) заливается только восток
  const pf = new cdn.Sim({ mode: 'prefill', t: 20 * 3600 });
  const c = pf.step(0);
  assert.ok(c.edges[vvo].fill > 0 && c.edges[spb].fill === 0);
});

test('Отказ узла: зрители уходят на соседей, RTT растёт, кэш сначала «холодный» и прогревается', () => {
  const sim = new cdn.Sim();
  const m0 = sim.step(0);
  const rtt95 = m0.rtt95;
  sim.fail('nsk', true);
  const m1 = sim.step(1);
  const nsk = cdn.EDGES.findIndex(e => e.id === 'nsk');
  assert.equal(m1.edges[nsk].load, 0);
  for (let r = 0; r < cdn.REGIONS.length; r++) assert.equal(sim.A[r * (cdn.EDGES.length + cdn.SHIELDS.length + 1) + nsk], 0);
  assert.ok(m1.rtt95 > rtt95, `p95 ${rtt95} → ${m1.rtt95}`);
  const krs = cdn.EDGES.findIndex(e => e.id === 'krs');
  const hCold = m1.edges[krs].hit;
  assert.ok(hCold < m1.hitNominal - 0.01, 'сосед должен попадать хуже');
  for (let i = 0; i < 60; i++) sim.step(60);                   // час модельного времени
  assert.ok(sim.m.edges[krs].hit > hCold + 0.01, 'LRU должен подстроиться');
  assert.ok(Math.abs(m1.totalG - m0.totalG) < 1e-6 * m0.totalG + 1, 'зрители не теряются');
});

function runPremiere(o, seconds) {
  const sim = new cdn.Sim(o);
  sim.premiere(5);
  const base = sim.step(0).originRps;
  let peakRps = 0, peakF = 0;
  for (let i = 0; i < seconds * 30; i++) {
    const m = sim.step(1 / 30);
    peakRps = Math.max(peakRps, m.originRps); peakF = Math.max(peakF, m.F);
  }
  return { sim, base, peakRps, peakF };
}

test('Премьера без предзаливки и без схлопывания кладёт ориджин, со схлопыванием — ровно', () => {
  const storm = runPremiere({ mode: 'lru', collapse: false }, 40);
  assert.ok(storm.peakRps > 10 * storm.base, `пик ${storm.peakRps} при фоне ${storm.base}`);
  assert.ok(storm.peakF > cdn.K.SEG_DUR, 'время промаха должно превысить длину сегмента: F=' + storm.peakF);
  assert.ok(storm.sim.m.queueS > 1, 'очередь ориджина должна стоять');
  const calm = runPremiere({ mode: 'lru', collapse: true }, 40);
  assert.ok(calm.peakRps < 1.1 * calm.base + 50, `пик ${calm.peakRps} при фоне ${calm.base}`);
  assert.ok(calm.peakF < 0.5);
  // включили схлопывание посреди лавины — ориджин отпускает
  const s = storm.sim;
  s.set({ collapse: true });
  for (let i = 0; i < 40 * 30; i++) s.step(1 / 30);
  assert.ok(s.m.queueS < 0.05 && s.m.F < 0.5, `очередь ${s.m.queueS}, F ${s.m.F}`);
});

test('Премьера с предзаливкой: серия уже на узлах, промахов нет', () => {
  const r = runPremiere({ mode: 'prefill', collapse: false }, 30);
  assert.equal(r.sim.m.stormRps, 0);
  assert.ok(r.peakRps <= r.base * 1.05 + 1);
  assert.ok(r.sim.m.premViewers > cdn.K.PREM_BURST * 0.9);
});

// Тесты чистой логики: сеть и ABR. Запуск: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/00-util.js');
const net = require('../js/30-net.js');
const abr = require('../js/31-abr.js');

const LADDER = [200, 400, 750, 1400, 2400].map(k => ({ kbps: k, avgKbps: k, peakKbps: k * 1.6 }));
const seg = (q) => LADDER[q].kbps * 1000 * 2 / 8; // байты 2-секундного сегмента

test('загрузка по ступенчатой трассе: RTT + интеграл ёмкости', () => {
  const tr = { rtt: 0.1, step: 0.5, bps: Float64Array.from([8e6, 8e6, 2e6, 2e6]), period: 2 };
  // 1 МБ = 8 Мбит: 0.1 с RTT, до t=1.0 при 8 Мбит/с уйдёт 7.2 Мбит, остаток 0.8 Мбит при 2 Мбит/с = 0.4 с
  const end = net.downloadEnd(tr, 0, 1e6);
  assert.ok(Math.abs(end - 1.4) < 1e-9, 'end=' + end);
  const x = new net.Transfer(tr, 0, 1e6);
  assert.equal(x.advance(1.0), false);
  assert.equal(x.advance(2.0), true);
  assert.ok(Math.abs(x.tEnd - 1.4) < 1e-9);
});

test('EWMA с поправкой на старт возвращает первое значение без смещения', () => {
  const e = new abr.Ewma(3);
  e.sample(1, 1000);
  assert.ok(Math.abs(e.get() - 1000) < 1e-9);
  const b = new abr.BwEstimator(3, 9, 5e5);
  assert.equal(b.estimate(), 5e5);
  b.sample(1, 250000); // 2 Мбит/с
  assert.ok(Math.abs(b.estimate() - 2e6) < 1);
});

test('BBA-0: в резервуаре — низ, за подушкой — верх, в середине — гистерезис', () => {
  const a = new abr.Bba(LADDER, { reservoir: 5, cushion: 16 });
  assert.equal(a.choose({ buffer: 3, lastQ: 3, segDur: 2 }), 0);
  assert.equal(a.choose({ buffer: 25, lastQ: 0, segDur: 2 }), 4);
  // f(13) = 200 + 2200 * 8/16 = 1300 кбит/с: с 750 вверх до max{R < 1300} = 750? нет — 750 < 1300, 1400 > 1300 → 750
  assert.equal(a.choose({ buffer: 13, lastQ: 1, segDur: 2 }), 2);
  // с 1400 f(13)=1300 ≤ Rate− (750)? нет; ≥ Rate+ (2400)? нет → держим 1400
  assert.equal(a.choose({ buffer: 13, lastQ: 3, segDur: 2 }), 3);
});

test('BOLA-O: параметры как в dash.js и выбор по буферу', () => {
  const a = new abr.Bola(LADDER);
  assert.equal(a.bufferTime, 20);
  assert.ok(Math.abs(a.gp - (Math.log(2400 / 200)) / 1) < 1e-9); // (u_max − 1)/(20/10 − 1)
  assert.ok(Math.abs(a.Vp - 10 / a.gp) < 1e-12);
  // сеть быстрая: подъём не ограничен
  a.sample({ transfer: 1, bytes: 5e6 / 8 * 10, ttfb: 0.02 });
  assert.equal(a.choose({ buffer: 3, lastQ: 0, segDur: 2 }), 0);   // мало буфера — низ
  assert.equal(a.choose({ buffer: 10, lastQ: 2, segDur: 2 }), 2);  // ~10 с — 750 кбит/с
  assert.equal(a.choose({ buffer: 16, lastQ: 4, segDur: 2 }), 4);  // много буфера — верх
});

test('BOLA-O: подъём ограничен выбором по сети, но не ниже текущего', () => {
  const a = new abr.Bola(LADDER);
  a.sample({ transfer: 1, bytes: 500e3 / 8, ttfb: 0.02 }); // сеть 500 кбит/с → по сети 400 (q=1)
  assert.equal(a.choose({ buffer: 18, lastQ: 2, segDur: 2 }), 2);
  assert.equal(a.choose({ buffer: 18, lastQ: 0, segDur: 2 }), 1);
});

test('RobustMPC: на стабильной сети не выбирает ступень, ведущую к остановке', () => {
  const a = new abr.Mpc(LADDER);
  for (let i = 0; i < 5; i++) a.sample({ transfer: 1, ttfb: 0, bytes: 1e6 / 8 }); // 1 Мбит/с стабильно
  const q = a.choose({ buffer: 4, lastQ: 2, segDur: 2, maxBuffer: 30, nextSize: (j, q) => seg(q) });
  assert.ok(LADDER[q].kbps <= 1000, 'выбрано ' + LADDER[q].kbps);
  assert.ok(a.brain.plan.length === 5);
});

test('Throughput: на старте с оценкой 500 кбит/с выбирает ступень, которая успеет за сегмент', () => {
  const a = new abr.Throughput(LADDER);
  const q = a.choose({ buffer: 0, lastQ: -1, segDur: 2 });
  // бюджет 0.95 × 500 = 475 кбит/с, пиковые битрейты 320/640/... → только 200 кбит/с (пик 320)
  assert.equal(q, 0);
  a.sample({ transfer: 1, bytes: 3e6 / 8, ttfb: 0.03 }); // 3 Мбит/с
  const q2 = a.choose({ buffer: 10, lastQ: 1, segDur: 2 });
  // вверх: 0.7 × 3000 = 2100 ≥ avg 1400 → q=3; 2400 не проходит
  assert.equal(q2, 3);
});

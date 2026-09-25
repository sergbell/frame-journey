// Тесты модели задержки «от камеры до экрана» (глава «Прямой эфир»). Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/59-live.js');

const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);
const part = (b, id) => b.parts.find(p => p.id === id);

test('модель — чистая: экспортируется в node и не требует DOM', () => {
  assert.equal(typeof M.budget, 'function');
  assert.equal(typeof M.race, 'function');
  assert.deepEqual(M.COMPONENTS.map(c => c.id), ['enc', 'pack', 'cdn', 'req', 'hold', 'dec']);
});

test('HLS · 6 с: HOLD-BACK = k × TD, упаковка — TD/2 в среднем и TD в худшем случае', () => {
  const b = M.budget(M.cfgOf('hls6'));
  assert.ok(near(part(b, 'hold').v, 18));
  assert.ok(near(part(b, 'pack').v, 3));
  assert.ok(near(part(b, 'pack').vw, 6));
  assert.ok(near(b.worst - b.total, 3));
  // загрузка: RTT + размер сегмента / пропускная способность = 0,04 + 6 Мбит/с × 6 с / 30 Мбит/с
  assert.ok(near(part(b, 'req').v, 0.04 + 1.2));
  // итог — ровно сумма этапов
  assert.ok(near(b.total, b.parts.reduce((s, p) => s + p.v, 0)));
  assert.ok(near(b.total, 1 + 3 + 0.1 + 1.24 + 18 + 0.1));
});

test('LL-HLS: буфер — k частей, запрос уже ждёт на сервере (RTT/2)', () => {
  const b = M.budget(M.cfgOf('llhls', { part: 0.5, k: 3, rtt: 0.06 }));
  assert.ok(near(part(b, 'hold').v, 1.5));
  assert.ok(near(part(b, 'pack').v, 0.25));
  assert.ok(near(part(b, 'req').v, 0.03 + 6e6 * 0.5 / 30e6));
});

test('типичные значения попадают в диапазоны из источников', () => {
  const cases = [['tv', 3, 6], ['hls6', 12, 30], ['llhls', 2, 6], ['lldash', 2, 10], ['webrtc', 0, 0.5], ['moq', 0, 1]];
  for (const [id, lo, hi] of cases) {
    const L = M.budget(M.cfgOf(id)).total;
    assert.ok(L >= lo && L <= hi, `${id}: ${L} вне [${lo}; ${hi}]`);
    // и те же диапазоны записаны в REFS, по которым рисуются скобки
    const r = M.REFS[id].find(x => x.a === lo && x.b === hi);
    assert.ok(r && r.src, id + ': нет скобки ' + lo + '–' + hi);
  }
});

test('LL-HLS с частями по 1/3 с укладывается в цель Apple 1–2 с', () => {
  const L = M.budget(M.cfgOf('llhls', { part: 1 / 3 })).total;
  assert.ok(L >= 1 && L <= 2, 'L = ' + L);
});

test('задержка монотонно растёт с сегментом, частью и множителем буфера', () => {
  let prev = -1;
  for (let seg = 1; seg <= 10; seg += 0.5) {
    const L = M.budget(M.cfgOf('hls6', { seg })).total;
    assert.ok(L > prev); prev = L;
  }
  prev = -1;
  for (let p = 0.2; p <= 2.001; p += 0.1) {
    const L = M.budget(M.cfgOf('llhls', { part: p })).total;
    assert.ok(L > prev); prev = L;
  }
  assert.ok(M.budget(M.cfgOf('hls2', { k: 4 })).total > M.budget(M.cfgOf('hls2', { k: 3 })).total);
});

test('правила HLS: HOLD-BACK < 3 × TD нарушает MUST', () => {
  const lv = cfg => M.rules(cfg).find(r => r.id.startsWith('hb')).level;
  assert.equal(lv(M.cfgOf('hls6', { k: 3 })), 'ok');
  assert.equal(lv(M.cfgOf('hls6', { k: 2.5 })), 'must');
});

test('правила LL-HLS: PART-HOLD-BACK ≥ 2 частей — MUST, ≥ 3 — SHOULD (у Apple MUST)', () => {
  const lv = k => M.rules(M.cfgOf('llhls', { k })).find(r => r.id.startsWith('phb')).level;
  assert.equal(lv(3), 'ok');
  assert.equal(lv(2.5), 'should');
  assert.equal(lv(2), 'should');
  assert.equal(lv(1.5), 'must');
});

test('правило Apple: часть не короче P95 RTT (MUST) и желательно ≥ 3 × RTT (SHOULD)', () => {
  const lv = (part, rtt) => M.rules(M.cfgOf('llhls', { part, rtt })).find(r => r.id.startsWith('rtt')).level;
  assert.equal(lv(1, 0.1), 'ok');
  assert.equal(lv(0.2, 0.1), 'should');
  assert.equal(lv(0.2, 0.25), 'must');
});

test('запросы: 1 млн зрителей и части по 1 с — 1 млн запросов плейлиста в секунду', () => {
  const r = M.requests(M.cfgOf('llhls', { part: 1 }), 1e6);
  assert.equal(r.playlist, 1e6);
  assert.equal(r.media, 1e6);
  assert.equal(r.total, 2e6);
  // обычный HLS с сегментами по 6 с — в 6 раз реже
  assert.ok(near(M.requests(M.cfgOf('hls6'), 1e6).playlist, 1e6 / 6, 1e-6));
  // LL-DASH: один долгий запрос на сегмент, MPD не перезапрашивается
  const d = M.requests(M.cfgOf('lldash'), 1e6);
  assert.equal(d.playlist, 0);
  assert.equal(d.media, 5e5);
});

test('гонка: спойлер приходит от самого быстрого соседа или из чата', () => {
  const list = M.raceSetup(M.cfgOf('hls6'));
  const res = M.race(list);
  const L = id => list.find(x => x.id === id).L;
  assert.equal(res.first.id, 'webrtc');
  const you = res.screens.find(x => x.id === 'you');
  assert.equal(you.by, 'webrtc');
  assert.ok(near(you.spoilAt, L('webrtc')));
  assert.ok(near(you.lead, L('you') - L('webrtc')));
  // чат: сосед увидел гол по антенне и написал через CHAT_DELAY
  assert.ok(near(L('chat'), L('tv') + M.CHAT_DELAY));
  // самого быстрого никто не опережает
  assert.equal(res.screens.find(x => x.id === 'webrtc').spoilAt, null);
  // равные задержки не спойлерят друг друга
  const tie = M.race([{ id: 'a', L: 2, kind: 'viewer' }, { id: 'b', L: 2, kind: 'viewer' }]);
  assert.equal(tie.screens[0].spoilAt, null);
  assert.equal(tie.screens[1].spoilAt, null);
  // чат опережает, если он раньше всех соседей
  const c = M.race([{ id: 'x', L: 9, kind: 'viewer' }, { id: 'm', L: 5, kind: 'chat' }]);
  assert.equal(c.screens[0].by, 'm');
  // события отсортированы и начинаются с гола на стадионе
  assert.equal(res.events[0], 0);
  for (let i = 1; i < res.events.length; i++) assert.ok(res.events[i] > res.events[i - 1]);
});

test('ускорение ролика: у событий скорость 1, между ними — ×ff, до гола — всегда 1', () => {
  const ev = [0, 4, 23];
  assert.equal(M.speedAt(-3, ev), 1);
  assert.equal(M.speedAt(4, ev), 1);
  assert.equal(M.speedAt(21.8, ev), 1);           // за 1,2 с до события
  assert.equal(M.speedAt(14, ev), M.SPEED.ff);      // далеко от событий
  const mid = M.speedAt(4 + M.SPEED.after + M.SPEED.ramp / 2, ev);
  assert.ok(mid > 1 && mid < M.SPEED.ff);
  // ролик заметно короче медиавремени
  const real = M.realDuration(-4, 27, ev);
  assert.ok(real < 31 * 0.8 && real > 12, 'real = ' + real);
});

test('уровни CDN: каждый уровень добавляет t_хоп; для MoQ — релеи', () => {
  const a = M.budget(M.cfgOf('hls2', { hops: 1 })).total, b = M.budget(M.cfgOf('hls2', { hops: 3 })).total;
  assert.ok(near(b - a, 2 * M.ENV.hop));
  const m1 = M.budget(M.cfgOf('moq', { hops: 1 })).total, m4 = M.budget(M.cfgOf('moq', { hops: 4 })).total;
  assert.ok(near(m4 - m1, 3 * M.ENV.hop));
  // WebRTC: медиасервер один, от уровней CDN не зависит
  assert.ok(near(M.budget(M.cfgOf('webrtc', { hops: 4 })).total, M.budget(M.cfgOf('webrtc')).total));
});

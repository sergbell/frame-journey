// Тесты разбора H.264: avcC, NAL, RBSP, Exp-Golomb, SPS/PPS, заголовок слайса, карта cbcs.
// Эталон — ffmpeg -bsf:v trace_headers (если ffmpeg есть): сверяем КАЖДОЕ поле,
// его позицию и длину в битах для всех слайсов всех фикстур и синтетических потоков.
// Запуск: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h264 = require('../js/23-h264.js');
const H = require('./fixtures/helpers.js');

const STREAMS = {
  'high.h264': { width: 640, height: 360, profile: 100, cabac: 1, frames: 48 },
  'baseline.h264': { width: 640, height: 360, profile: 66, cabac: 0, frames: 48 },
  'bframes.h264': { width: 640, height: 360, profile: 100, cabac: 1, frames: 48 },
  'mbaff.h264': { width: 320, height: 180, profile: 100, cabac: 1, frames: 12 },
  'hi444.h264': { width: 64, height: 64, profile: 244, cabac: 1, frames: 4 },
  'lossless.h264': { width: 48, height: 48, profile: 244, cabac: 1, frames: 2 },
};
const SKIP_NO_FFMPEG = H.HAS_FFMPEG ? false : 'ffmpeg/ffprobe не найдены';

/* ------------------------------------------------------------------ */

test('фикстуры: суммарно < 300 КБ, каждая режется на ожидаемое число кадров', () => {
  let total = 0;
  for (const [name, exp] of Object.entries(STREAMS)) {
    total += fs.statSync(path.join(H.FIXTURES, name)).size;
    const s = H.loadStream(name);
    assert.equal(s.samples.length, exp.frames, name);
    assert.ok(s.samples[0].key, name + ': первый кадр — IDR');
    assert.equal(s.samples.filter(x => x.key).length, 1, name + ': один IDR на поток');
  }
  assert.ok(total < 300 * 1024, 'фикстуры весят ' + total);
});

test('parseAvcC: SPS/PPS, lengthSize, расширение High-профиля и строка кодека', () => {
  const s = H.loadStream('high.h264');
  const rec = h264.parseAvcC(s.avcC);
  assert.equal(rec.version, 1);
  assert.equal(rec.profile, 100);
  assert.equal(rec.lengthSize, 4);
  assert.deepEqual(rec.sps.map(x => [...x]), s.sps.map(x => [...x]));
  assert.deepEqual(rec.pps.map(x => [...x]), s.pps.map(x => [...x]));
  assert.deepEqual(rec.ext, { chromaFormat: 1, bitDepthLuma: 8, bitDepthChroma: 8, spsExt: [] });
  assert.equal(rec.codec, 'avc1.64' + rec.compat.toString(16).padStart(2, '0') + rec.level.toString(16).padStart(2, '0'));
  // Baseline: расширения нет; запись без расширения у High тоже читается
  const b = h264.parseAvcC(H.loadStream('baseline.h264').avcC);
  assert.equal(b.profile, 66);
  assert.equal(b.ext, null);
  const noExt = s.avcC.subarray(0, s.avcC.length - 4);
  assert.equal(h264.parseAvcC(noExt).ext, null);
  // 10-бит 4:4:4
  const x = h264.parseAvcC(H.loadStream('hi444.h264').avcC);
  assert.deepEqual([x.ext.chromaFormat, x.ext.bitDepthLuma, x.ext.bitDepthChroma], [3, 10, 10]);
  // Ошибки
  assert.throws(() => h264.parseAvcC(Uint8Array.from([2, 100, 0, 30, 0xff, 0xe1])), /configurationVersion/);
  assert.throws(() => h264.parseAvcC(s.avcC.subarray(0, 12)), RangeError);
});

test('nals: длины, типы, имена, ошибки на битых длинах', () => {
  const s = H.loadStream('high.h264', { keep: [7, 8] });
  const list = h264.nals(s.samples[0].data);
  assert.deepEqual(list.map(n => n.name), ['SPS', 'PPS', 'SEI', 'IDR']);
  assert.deepEqual(list.map(n => n.refIdc), [3, 3, 0, 3]);
  const last = list[list.length - 1];
  assert.equal(last.end, s.samples[0].data.length);
  assert.equal(list[1].offset, list[0].end);
  assert.equal(list[0].start, 4);
  // AUD + два слайса у baseline
  const b = H.loadStream('baseline.h264', { keep: [9] });
  assert.deepEqual(h264.nals(b.samples[1].data).map(n => n.name), ['AUD', 'non-IDR', 'non-IDR']);
  // Длина 2 байта
  const two = Uint8Array.from([0, 3, 0x09, 0xf0, 0x80, 0, 2, 0x0c, 0x80]);
  assert.deepEqual(h264.nals(two, 2).map(n => [n.type, n.size]), [[9, 3], [12, 2]]);
  assert.throws(() => h264.nals(Uint8Array.from([0, 0, 0, 9, 0x65, 1])), /выходит за конец/);
  assert.throws(() => h264.nals(Uint8Array.from([0, 0, 0, 0])), /нулевая длина/);
  assert.throws(() => h264.nals(Uint8Array.from([0, 0])), /поле длины/);
});

test('rbsp: убирает 00 00 03, помнит позиции, rbspToNal отображает обратно', () => {
  const nal = Uint8Array.from([0x65, 0x11, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x03, 0x42]);
  const rb = h264.rbsp(nal);
  assert.deepEqual([...rb.bytes], [0x11, 0, 0, 1, 0, 0, 0, 0, 3, 0x42]);
  assert.deepEqual(rb.epbPositions, [4, 8, 11]);
  // Каждый байт RBSP должен находиться по отображённому адресу
  for (let i = 0; i < rb.bytes.length; i++) assert.equal(nal[h264.rbspToNal(rb, i)], rb.bytes[i], 'байт ' + i);
  assert.equal(h264.rbspToNal(rb, rb.bytes.length), nal.length);
  assert.deepEqual(h264.rbspBitToNal(rb, 8 * 3 + 5), { byte: 5, bit: 5 });
  // Случайные RBSP с кучей нулей: экранирование ↔ разэкранирование
  const r = H.prng(7);
  for (let k = 0; k < 300; k++) {
    const raw = Array.from({ length: r.int(1, 60) }, () => (r.bit(0.6) ? 0 : r.int(0, 4)));
    raw.push(0x80);                                     // RBSP кончается стоп-битом
    const n = H.makeNal(0x41, raw);
    const back = h264.rbsp(n);
    assert.deepEqual([...back.bytes], raw);
    for (let i = 0; i < raw.length; i++) assert.equal(n[h264.rbspToNal(back, i)], raw[i]);
    assert.equal(n.length - 1 - back.epbPositions.length, raw.length);
  }
  // Префикс: limit
  const pre = h264.rbsp(nal, 4);
  assert.deepEqual([...pre.bytes], [0x11, 0, 0, 1]);
  assert.equal(pre.truncated, true);
});

test('BitReader: Exp-Golomb по таблице 9-2, se(v), u(32), more_rbsp_data', () => {
  // codeNum 0..8: 1, 010, 011, 00100, 00101, 00110, 00111, 0001000, 0001001
  const w = new H.BitWriter();
  for (let k = 0; k <= 8; k++) w.ue(k);
  assert.equal(w.bits.join(''), '1' + '010' + '011' + '00100' + '00101' + '00110' + '00111' + '0001000' + '0001001');
  const br = new h264.BitReader(w.trailing().bytes());
  for (let k = 0; k <= 8; k++) assert.equal(br.ue(), k);
  // se: 0, 1, −1, 2, −2 … (Table 9-3)
  const s = new H.BitWriter();
  const vals = [0, 1, -1, 2, -2, 3, -3, 127, -128, 2 ** 30, -(2 ** 30)];
  vals.forEach(v => s.se(v));
  s.u(32, 0xdeadbeef).ue(2 ** 32 - 2).trailing();
  const r2 = new h264.BitReader(s.bytes());
  for (const v of vals) assert.equal(r2.se(), v);
  assert.equal(Object.is(new h264.BitReader(Uint8Array.from([0x80])).se(), 0), true, 'se(0) — не −0');
  assert.equal(r2.u(32), 0xdeadbeef);
  assert.equal(r2.ue(), 2 ** 32 - 2);
  assert.equal(r2.moreRbspData(), false);
  assert.equal(r2.u1(), 1);                                      // rbsp_stop_one_bit
  // more_rbsp_data: хвостовые нулевые байты после стоп-бита не считаются данными
  const t = new h264.BitReader(Uint8Array.from([0b10110000, 0, 0]));
  t.u(2);
  assert.equal(t.moreRbspData(), true);
  t.u(1);
  assert.equal(t.moreRbspData(), false);
  assert.throws(() => new h264.BitReader(Uint8Array.from([0])).ue(), RangeError);
  assert.throws(() => new h264.BitReader(new Uint8Array(8)).ue(), /32/);
});

test('parseSPS/parsePPS: размеры, профили, кроп, матрицы, VUI', () => {
  for (const [name, exp] of Object.entries(STREAMS)) {
    const s = H.loadStream(name);
    const sps = h264.parseSPS(s.sps[0]);
    assert.equal(sps.width, exp.width, name + ' ширина');
    assert.equal(sps.height, exp.height, name + ' высота');
    assert.equal(sps.profile_idc, exp.profile, name);
    const pps = h264.parsePPS(s.pps[0], { [sps.seq_parameter_set_id]: sps });
    assert.equal(pps.entropy_coding_mode_flag, exp.cabac, name);
  }
  const hi = h264.parseSPS(H.loadStream('high.h264').sps[0]);
  assert.equal(hi.frame_crop_bottom_offset, 4);            // 368 → 360
  assert.equal(hi.codedHeight, 368);
  assert.deepEqual(hi.sar, [1, 1]);
  assert.equal(hi.profileName, 'High');
  assert.equal(hi.vui.time_scale, 48);
  const mb = h264.parseSPS(H.loadStream('mbaff.h264').sps[0]);
  assert.deepEqual([mb.frame_mbs_only_flag, mb.mb_adaptive_frame_field_flag, mb.pic_height_in_map_units], [0, 1, 6]);
  assert.equal(mb.frame_height_in_mbs, 12);                // 192 строк − 3 × CropUnitY 4 = 180
  const x = h264.parseSPS(H.loadStream('hi444.h264').sps[0]);
  assert.deepEqual([x.chroma_format_idc, x.bit_depth_luma, x.bit_depth_chroma], [3, 10, 10]);
  const xp = h264.parsePPS(H.loadStream('hi444.h264').pps[0], { 0: x });
  assert.equal(xp.pic_scaling_lists.length, 12);           // 6 + 6 (4:4:4 с transform_8x8)
  assert.ok(xp.pic_scaling_lists.some(l => l && l.list.length === 64));
  assert.equal(h264.parseSPS(H.loadStream('lossless.h264').sps[0]).qpprime_y_zero_transform_bypass_flag, 1);
  // PPS без SPS там, где SPS нужен, и несколько групп слайсов
  assert.throws(() => h264.parsePPS(H.loadStream('hi444.h264').pps[0], {}), /нужен SPS/);
  const fmo = new H.BitWriter().ue(0).ue(0).f(0).f(0).ue(1).ue(0).trailing();
  assert.throws(() => h264.parsePPS(H.makeNal(0x68, fmo.bytes()), {}), /группы слайсов/);
  assert.throws(() => h264.parseSPS(Uint8Array.from([0x68, 0x80])), /ожидался 7/);
});

/* ---------- Сверка с ffmpeg trace_headers ---------- */

const ALIASES = { gaps_in_frame_num_allowed_flag: 'gaps_in_frame_num_value_allowed_flag' };
const TITLES = { 'Sequence Parameter Set': 7, 'Picture Parameter Set': 8, 'Slice Header': 'slice' };

// Поля trace (позиции с байтом заголовка NAL) → наш вид; биты выравнивания CABAC склеиваем
function normalizeTrace(fields) {
  const out = [];
  for (const f of fields) {
    if (f.pos < 8 || f.name === 'rbsp_stop_one_bit' || f.name === 'rbsp_alignment_zero_bit') continue;
    const name = ALIASES[f.name] || f.name;
    const prev = out[out.length - 1];
    if (name === 'cabac_alignment_one_bit' && prev && prev.name === name) {
      prev.bitLen += f.bits.length;
      prev.value = prev.value * 2 + f.value;
      continue;
    }
    out.push({ name, bitStart: f.pos - 8, bitLen: f.bits.length, value: f.value });
  }
  return out;
}

function assertSameFields(ours, trace, label) {
  const t = normalizeTrace(trace);
  const o = ours.map(f => ({ name: f.name, bitStart: f.bitStart, bitLen: f.bitLen, value: f.value }));
  const n = Math.min(o.length, t.length);
  for (let i = 0; i < n; i++) assert.deepEqual(o[i], t[i], `${label}: поле #${i}`);
  assert.equal(o.length, t.length, `${label}: число полей`);
}

// Все SPS/PPS/слайсы потока по порядку: наш разбор против trace_headers
function compareStream(nalList, sections, label) {
  const ours = nalList.filter(n => [1, 5, 7, 8].includes(n[0] & 31));
  const theirs = sections.filter(s => !s.extradata && TITLES[s.title]);
  assert.equal(ours.length, theirs.length, `${label}: число SPS/PPS/слайсов`);
  const ctx = { spsById: {}, ppsById: {} };
  const stats = { slices: 0, fields: 0, cabac: 0, epb: 0, names: new Set() };
  ours.forEach((nal, i) => {
    const type = nal[0] & 31;
    const sec = theirs[i];
    const where = `${label} NAL #${i} (тип ${type})`;
    if (type === 7) {
      assert.equal(sec.title, 'Sequence Parameter Set', where);
      const sps = h264.parseSPS(nal);
      ctx.spsById[sps.seq_parameter_set_id] = sps;
      assertSameFields(sps.fields, sec.fields, where);
      sps.fields.forEach(f => stats.names.add(f.name.replace(/\[.*$/, '')));
    } else if (type === 8) {
      assert.equal(sec.title, 'Picture Parameter Set', where);
      const pps = h264.parsePPS(nal, ctx.spsById);
      ctx.ppsById[pps.pic_parameter_set_id] = pps;
      assertSameFields(pps.fields, sec.fields, where);
    } else {
      assert.equal(sec.title, 'Slice Header', where);
      const sh = h264.sliceHeader(nal, ctx);
      assertSameFields(sh.fields, sec.fields, where);
      // Длина заголовка = конец последнего поля trace до выравнивания CABAC
      const body = normalizeTrace(sec.fields).filter(f => f.name !== 'cabac_alignment_one_bit');
      const last = body[body.length - 1];
      assert.equal(sh.headerBitsRbsp, last.bitStart + last.bitLen, where + ': длина заголовка');
      if (sh.pps.entropy_coding_mode_flag) { assert.equal(sh.cabacAlignOk, true, where); stats.cabac++; }
      assert.equal(sh.dataOffsetInNal, h264.rbspToNal(h264.rbsp(nal), Math.ceil(sh.headerBitsRbsp / 8)));
      stats.slices++;
      stats.fields += sh.fields.length;
      stats.epb += sh.epbInHeader;
      sh.fields.forEach(f => stats.names.add(f.name.replace(/\[.*$/, '')));
    }
  });
  return stats;
}

test('trace_headers: каждое поле SPS/PPS/заголовков слайсов во всех фикстурах', { skip: SKIP_NO_FFMPEG }, (t) => {
  const summary = {};
  for (const name of Object.keys(STREAMS)) {
    const s = H.loadStream(name);
    const sections = H.traceHeaders(path.join(H.FIXTURES, name));
    const st = compareStream(s.nals, sections, name);
    assert.ok(st.slices >= STREAMS[name].frames, name);
    summary[name] = `${st.slices} слайсов, ${st.fields} полей, CABAC ${st.cabac}`;
  }
  // Разнообразие синтаксиса, которое мы реально проверили
  const b = H.loadStream('bframes.h264');
  const names = new Set();
  const ctx = h264.makeContext(b.avcC);
  for (const smp of b.samples) for (const n of h264.parseSample(smp.data, ctx)) if (n.slice) n.slice.fields.forEach(f => names.add(f.name.replace(/\[.*$/, '')));
  for (const need of ['direct_spatial_mv_pred_flag', 'modification_of_pic_nums_idc', 'abs_diff_pic_num_minus1',
    'luma_weight_l0', 'chroma_offset_l0', 'memory_management_control_operation', 'num_ref_idx_l1_active_minus1', 'pic_order_cnt_lsb']) {
    assert.ok(names.has(need), 'в bframes.h264 нет ' + need);
  }
  t.diagnostic(JSON.stringify(summary));
});

test('trace_headers: синтетические SPS/PPS/слайсы (POC 1, SP/SI, 4:4:4 с отдельными плоскостями, MMCO, матрицы в SPS, HRD)', { skip: SKIP_NO_FFMPEG }, (t) => {
  const { nals, expectations } = buildSynthetic(11, 60);
  const dir = H.tmpDir();
  const file = path.join(dir, 'synthetic.h264');
  fs.writeFileSync(file, Buffer.concat(nals.map(n => Buffer.from([0, 0, 0, 1, ...n]))));
  const sections = H.traceHeaders(file, ['-f', 'h264']);
  const stats = compareStream(nals, sections, 'synthetic');
  assert.ok(stats.slices >= 100, 'слайсов ' + stats.slices);
  assert.ok(stats.epb > 0, 'нужны байты 0x03 внутри заголовков');
  assert.ok(expectations.length > 0);
  // Редкие ветки синтаксиса действительно встретились (и совпали с ffmpeg)
  for (const need of ['offset_for_ref_frame', 'delta_pic_order_cnt', 'delta_pic_order_cnt_bottom', 'sp_for_switch_flag',
    'slice_qs_delta', 'colour_plane_id', 'bottom_field_flag', 'redundant_pic_cnt', 'long_term_pic_num',
    'long_term_frame_idx', 'max_long_term_frame_idx_plus1', 'difference_of_pic_nums_minus1', 'seq_scaling_list_present_flag',
    'delta_scale', 'cpb_cnt_minus1', 'sar_width', 'luma_weight_l1', 'chroma_offset_l1', 'separate_colour_plane_flag']) {
    assert.ok(stats.names.has(need), 'синтетика не задела ' + need);
  }
  t.diagnostic(`синтетика: ${stats.slices} слайсов, ${stats.fields} полей, 0x03 в заголовках: ${stats.epb}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Синтетический поток: группы SPS → PPS → слайсы; ожидания — из генератора
function buildSynthetic(seed, groups) {
  const r = H.prng(seed);
  const nals = [], expectations = [];
  for (let g = 0; g < groups; g++) {
    const sps = H.synthSPS(r, g % 32);
    const pps = H.synthPPS(r, g % 256, sps.cfg);
    nals.push(sps.nal, pps.nal);
    for (let k = 0; k < 3; k++) {
      const sl = H.synthSlice(r, sps.cfg, pps.cfg, { bigZeros: k === 2 });
      nals.push(sl.nal);
      expectations.push({ index: nals.length - 1, headerBits: sl.headerBits, sps: sps.cfg, pps: pps.cfg });
    }
  }
  return { nals, expectations };
}

test('синтетика без ffmpeg: длина заголовка, смещение данных с учётом 0x03, выравнивание CABAC', () => {
  const { nals, expectations } = buildSynthetic(3, 80);
  const ctx = { spsById: new Map(), ppsById: new Map() };   // контекст может быть и Map
  let epb = 0, checked = 0;
  const exp = new Map(expectations.map(e => [e.index, e]));
  nals.forEach((nal, i) => {
    const type = nal[0] & 31;
    if (type === 7) { const s = h264.parseSPS(nal); ctx.spsById.set(s.seq_parameter_set_id, s); return; }
    if (type === 8) { const p = h264.parsePPS(nal, ctx.spsById); ctx.ppsById.set(p.pic_parameter_set_id, p); return; }
    const e = exp.get(i);
    const sh = h264.sliceHeader(nal, ctx);
    assert.equal(sh.headerBitsRbsp, e.headerBits, 'слайс ' + i);
    // Независимое отображение: экранируем RBSP заново и считаем, где окажется байт данных
    const rb = h264.rbsp(nal).bytes;
    const map = [];
    let zeros = 0, pos = 1;
    for (const b of rb) {
      if (zeros >= 2 && b <= 3) { pos++; zeros = 0; }
      map.push(pos++);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    assert.equal(sh.dataOffsetInNal, map[Math.ceil(e.headerBits / 8)], 'смещение данных, слайс ' + i);
    if (e.pps.entropy_coding_mode_flag) assert.equal(sh.cabacAlignOk, true);
    else assert.equal(sh.cabacAlignOk, null);
    epb += sh.epbInHeader;
    checked++;
  });
  assert.equal(checked, expectations.length);
  assert.ok(epb > 0, 'в синтетике должны быть 0x03 внутри заголовков');
});

test('sliceHeader: поля IDR/P/B, QP, имя типа, ошибки контекста', () => {
  const s = H.loadStream('bframes.h264');
  const ctx = h264.makeContext(s.avcC);
  const types = new Set();
  for (const smp of s.samples) {
    for (const n of h264.parseSample(smp.data, ctx)) {
      if (!n.slice) continue;
      types.add(n.slice.sliceTypeName);
      const v = n.slice.values;
      assert.equal(n.slice.qp, 26 + n.slice.pps.pic_init_qp_minus26 + v.slice_qp_delta);
      assert.ok(n.slice.dataOffsetInNal > 1 && n.slice.dataOffsetInNal < n.size);
      if (n.type === 5) assert.equal(v.idr_pic_id, 0);
    }
  }
  assert.deepEqual([...types].sort(), ['B', 'I', 'P']);
  const idr = h264.nals(s.samples[0].data).find(n => n.type === 5);
  const nal = s.samples[0].data.subarray(idr.start, idr.end);
  assert.throws(() => h264.sliceHeader(nal, { spsById: {}, ppsById: {} }), /PPS 0/);
  assert.throws(() => h264.sliceHeader(Uint8Array.from([0x06, 0x05]), ctx), /не слайс/);
});

/* ---------- Карта подвыборок cbcs ---------- */

function checkSubsampleMap(data, subs, ctx, label) {
  const total = subs.reduce((a, x) => a + x.clear + x.protected, 0);
  assert.equal(total, data.length, label + ': clear + protected = размер сэмпла');
  for (const x of subs) {
    assert.ok(Number.isInteger(x.clear) && x.clear >= 0 && x.clear <= 0xffff, label + ': uint16 clear');
    assert.ok(Number.isInteger(x.protected) && x.protected >= 0, label);
  }
  // Защищённые диапазоны = ровно данные слайсов (после заголовка) по порядку
  const ranges = [];
  let pos = 0;
  for (const x of subs) { pos += x.clear; if (x.protected) ranges.push([pos, pos + x.protected]); pos += x.protected; }
  const slices = h264.parseSample(data, ctx).filter(n => n.slice);
  assert.deepEqual(ranges, slices.map(n => [n.start + n.slice.dataOffsetInNal, n.end]), label + ': диапазоны');
}

test('cbcsSubsamples: сумма = размер сэмпла, открыты длина/заголовок NAL/заголовок слайса, SEI и AUD — открыты', () => {
  for (const name of Object.keys(STREAMS)) {
    for (const keep of [[], [7, 8, 9]]) {
      const s = H.loadStream(name, { keep });
      const ctx = h264.makeContext(s.avcC);
      s.samples.forEach((smp, i) => {
        const subs = h264.cbcsSubsamples(smp.data, ctx);
        checkSubsampleMap(smp.data, subs, ctx, `${name}[${i}] keep=${keep}`);
      });
    }
  }
  // Кадр с SEI перед IDR: первая подвыборка открывает SEI + длину + заголовок IDR-слайса
  const s = H.loadStream('high.h264');
  const ctx = h264.makeContext(s.avcC);
  const list = h264.nals(s.samples[0].data);
  assert.deepEqual(list.map(n => n.name), ['SEI', 'IDR']);
  const subs = h264.cbcsSubsamples(s.samples[0].data, ctx);
  const sh = h264.sliceHeader(s.samples[0].data.subarray(list[1].start, list[1].end), ctx);
  assert.deepEqual(subs, [{ clear: list[0].end + 4 + sh.dataOffsetInNal, protected: list[1].size - sh.dataOffsetInNal }]);
});

test('cbcsSubsamples: > 65535 открытых байт делятся, хвостовые не-VCL дают {clear, protected: 0}, SPS/PPS в сэмпле обновляют контекст', () => {
  const s = H.loadStream('baseline.h264');
  const ctx = h264.makeContext(s.avcC);
  const frame = s.samples[3].data;
  const sei = new Uint8Array(70000 + 1);
  sei[0] = 0x06; sei.fill(0x55, 1); sei[sei.length - 1] = 0x80;
  const eos = Uint8Array.from([0x0a]);
  const withLen = n => { const o = new Uint8Array(4 + n.length); new DataView(o.buffer).setUint32(0, n.length); o.set(n, 4); return o; };
  const data = new Uint8Array([...withLen(sei), ...frame, ...withLen(eos)]);
  const subs = h264.cbcsSubsamples(data, ctx);
  checkSubsampleMap(data, subs, ctx, 'big SEI');
  assert.deepEqual(subs[0], { clear: 65535, protected: 0 });
  assert.deepEqual(subs[subs.length - 1], { clear: 5, protected: 0 });
  assert.equal(subs.filter(x => x.protected).length, 2);           // два слайса в кадре
  // Пустой контекст + SPS/PPS внутри сэмпла
  const k = H.loadStream('high.h264', { keep: [7, 8] });
  const empty = { spsById: {}, ppsById: {} };
  const subs0 = h264.cbcsSubsamples(k.samples[0].data, empty);
  checkSubsampleMap(k.samples[0].data, subs0, empty, 'in-band SPS/PPS');
  assert.ok(empty.spsById[0] && empty.ppsById[0]);
  // Без контекста слайс не разобрать — понятная ошибка
  assert.throws(() => h264.cbcsSubsamples(s.samples[0].data, { spsById: {}, ppsById: {} }), /PPS 0/);
});

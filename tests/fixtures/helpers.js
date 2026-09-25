// Помощники тестов h264/mp4 (не тест: node --test его не подхватывает).
// - Annex B (00 00 01) → NAL-блоки → access units → сэмплы AVCC + avcC,
//   ровно как их отдаёт WebCodecs VideoEncoder с avc: {format: 'avc'};
// - POC (порядок показа) для composition offsets;
// - запуск ffmpeg/ffprobe и разбор вывода trace_headers;
// - генератор синтетических SPS/PPS/слайсов (BitWriter) для веток,
//   которых нет в потоках x264.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h264 = require('../../js/23-h264.js');

const FIXTURES = __dirname;
const readFixture = name => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

/* ---------------- Annex B → NAL → access units → сэмплы ---------------- */

// Разрезать поток по стартовым кодам; хвостовые нули (zero_byte, trailing_zero_8bits) отбросить
function splitAnnexB(buf) {
  const starts = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : buf.length;
    while (end > s && buf[end - 1] === 0) end--;
    return buf.subarray(s, end);
  });
}

// Границы access unit (упрощённый §7.4.1.2.3: без ASO и полей-пар):
// после VCL новый AU начинают AUD/SPS/PPS/SEI/14–18 или слайс с first_mb_in_slice = 0
function groupAccessUnits(nalList) {
  const aus = [];
  let cur = [], seenVcl = false;
  for (const nal of nalList) {
    const t = nal[0] & 31;
    const vcl = t >= 1 && t <= 5;
    const first = seenVcl && (t === 6 || t === 7 || t === 8 || t === 9 || (t >= 14 && t <= 18) ||
      (vcl && (nal[1] & 0x80) !== 0));   // ue(first_mb_in_slice) = 0 → первый бит «1»
    if (first) { aus.push(cur); cur = []; seenVcl = false; }
    cur.push(nal);
    if (vcl) seenVcl = true;
  }
  if (cur.length) aus.push(cur);
  return aus;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Сэмплы как у WebCodecs 'avc': SPS/PPS уходят в avcC, AUD выбрасывается,
// SEI и слайсы остаются. keep: какие ещё типы оставить в сэмплах (например [7, 8, 9]).
function toSamples(aus, { keep = [], lengthSize = 4 } = {}) {
  const sps = [], pps = [];
  const samples = aus.map(au => {
    const kept = [];
    for (const nal of au) {
      const t = nal[0] & 31;
      if (t === 7 && !sps.some(x => sameBytes(x, nal))) sps.push(nal.slice());
      if (t === 8 && !pps.some(x => sameBytes(x, nal))) pps.push(nal.slice());
      if ((t === 7 || t === 8 || t === 9) && !keep.includes(t)) continue;
      kept.push(nal);
    }
    const size = kept.reduce((a, n) => a + lengthSize + n.length, 0);
    const data = new Uint8Array(size);
    let o = 0;
    for (const n of kept) {
      for (let k = lengthSize - 1; k >= 0; k--) data[o++] = Math.floor(n.length / 256 ** k) % 256;
      data.set(n, o);
      o += n.length;
    }
    return { data, key: au.some(n => (n[0] & 31) === 5), nalTypes: kept.map(n => n[0] & 31) };
  });
  return { samples, sps, pps };
}

// AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1) с расширением High-профилей
function buildAvcC(spsList, ppsList, lengthSize = 4) {
  const s0 = h264.parseSPS(spsList[0]);
  const out = [1, spsList[0][1], spsList[0][2], spsList[0][3], 0xfc | (lengthSize - 1), 0xe0 | spsList.length];
  for (const s of spsList) out.push(s.length >> 8, s.length & 255, ...s);
  out.push(ppsList.length);
  for (const p of ppsList) out.push(p.length >> 8, p.length & 255, ...p);
  if (![66, 77, 88].includes(s0.profile_idc)) {
    out.push(0xfc | s0.chroma_format_idc, 0xf8 | s0.bit_depth_luma_minus8, 0xf8 | s0.bit_depth_chroma_minus8, 0);
  }
  return Uint8Array.from(out);
}

// Всё сразу: файл Annex B → {nals, aus, samples, avcC, ctx}
function loadStream(name, opts = {}) {
  const buf = readFixture(name);
  const nals = splitAnnexB(buf);
  const aus = groupAccessUnits(nals);
  const { samples, sps, pps } = toSamples(aus, opts);
  const avcC = buildAvcC(sps, pps, opts.lengthSize || 4);
  return { buf, nals, aus, samples, sps, pps, avcC, ctx: h264.makeContext(avcC) };
}

/* ---------------- Порядок показа (POC, §8.2.1) ---------------- */

// POC каждого сэмпла в порядке декодирования; поддержаны типы 0 и 2 (x264), без MMCO 5
function picOrderCounts(samples, avcC, lengthSize = 4) {
  const ctx = h264.makeContext(avcC);
  let prevMsb = 0, prevLsb = 0, prevOffset = 0, prevFrameNum = 0;
  return samples.map(s => {
    const sh = h264.parseSample(s.data, ctx, lengthSize).find(n => n.slice).slice;
    const v = sh.values, sps = sh.sps;
    if (sps.pic_order_cnt_type === 0) {
      if (sh.idr) { prevMsb = 0; prevLsb = 0; }
      const max = 2 ** sps.log2_max_pic_order_cnt_lsb;
      const lsb = v.pic_order_cnt_lsb;
      let msb = prevMsb;
      if (lsb < prevLsb && prevLsb - lsb >= max / 2) msb = prevMsb + max;
      else if (lsb > prevLsb && lsb - prevLsb > max / 2) msb = prevMsb - max;
      const top = msb + lsb;
      const bottom = top + (v.delta_pic_order_cnt_bottom || 0);
      if (sh.refIdc) { prevMsb = msb; prevLsb = lsb; }
      return Math.min(top, bottom);
    }
    if (sps.pic_order_cnt_type === 2) {
      const maxFrameNum = 2 ** sps.log2_max_frame_num;
      let offset = sh.idr ? 0 : prevOffset + (prevFrameNum > v.frame_num ? maxFrameNum : 0);
      const abs = offset + v.frame_num;
      const poc = sh.idr ? 0 : sh.refIdc ? 2 * abs : 2 * abs - 1;
      prevOffset = offset; prevFrameNum = v.frame_num;
      return poc;
    }
    throw new Error('POC type 1 не нужен для фикстур');
  });
}

// Длительности и composition offsets по POC: первый показанный кадр = decode time первого
function timing(samples, avcC, duration) {
  const pocs = picOrderCounts(samples, avcC);
  const order = pocs.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const rank = new Array(samples.length);
  order.forEach((decodeIdx, presentIdx) => { rank[decodeIdx] = presentIdx; });
  return samples.map((s, i) => ({ data: s.data, key: s.key, duration, cto: (rank[i] - i) * duration }));
}

/* ---------------- ffmpeg ---------------- */

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: opts.encoding || 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}
const hasTool = name => { const r = run(name, ['-hide_banner', '-version']); return !r.error && r.status === 0; };
const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fj-mp4-'));

// Вывод -bsf:v trace_headers → разделы {title, extradata, fields: [{pos, name, bits, value}]}
function parseTrace(text) {
  const sections = [];
  let cur = null, extradata = false;
  for (const line of text.split('\n')) {
    const m = /^\[trace_headers @ [^\]]+\] (.*)$/.exec(line);
    if (!m) continue;
    const body = m[1];
    const f = /^(\d+)\s+(\S+)\s+([01]+) = (-?\d+)$/.exec(body);
    if (f) {
      if (cur) cur.fields.push({ pos: +f[1], name: f[2], bits: f[3], value: +f[4] });
      continue;
    }
    if (body.startsWith('Extradata')) { extradata = true; continue; }
    if (body.startsWith('Packet:')) { extradata = false; continue; }
    cur = { title: body.trim(), extradata, fields: [] };
    sections.push(cur);
  }
  return sections;
}

// -copyinkf: не выбрасывать пакеты до первого ключевого кадра (в синтетике они есть)
function traceHeaders(file, inputOptions = []) {
  const r = run('ffmpeg', ['-hide_banner', ...inputOptions, '-i', file, '-c', 'copy', '-copyinkf',
    '-bsf:v', 'trace_headers', '-f', 'null', '-']);
  return parseTrace(r.stderr);
}

/* ---------------- Синтетические NAL: BitWriter + генератор ---------------- */

class BitWriter {
  constructor() { this.bits = []; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2); return this; }
  f(v) { this.bits.push(v ? 1 : 0); return this; }
  ue(v) {
    const x = v + 1;
    let len = 0;
    while (2 ** (len + 1) <= x) len++;
    return this.u(len, 0).u(len + 1, x);
  }
  se(v) { return this.ue(v <= 0 ? -2 * v : 2 * v - 1); }
  trailing() { this.bits.push(1); while (this.bits.length % 8) this.bits.push(0); return this; }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

// RBSP → полезная нагрузка NAL: вставить 0x03 после 00 00, если дальше 00..03
function escapeRbsp(rbspBytes) {
  const out = [];
  let zeros = 0;
  for (const b of rbspBytes) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}
const makeNal = (headerByte, rbspBytes) => Uint8Array.from([headerByte, ...escapeRbsp(rbspBytes)]);

// Детерминированный генератор (mulberry32)
function prng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.bit = (p = 0.5) => (r() < p ? 1 : 0);
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  return r;
}

// Случайный SPS: возвращает {nal, cfg}; cfg — ожидаемые значения
function synthSPS(r, id) {
  const w = new BitWriter();
  const c = { seq_parameter_set_id: id };
  c.profile_idc = r.pick([66, 77, 88, 100, 110, 122, 244, 44]);
  w.u(8, c.profile_idc);
  for (let i = 0; i < 6; i++) w.f(r.bit(0.3));
  w.u(2, 0).u(8, r.pick([10, 21, 30, 31, 40, 51])).ue(id);
  c.chroma_format_idc = 1; c.separate_colour_plane_flag = 0;
  if ([100, 110, 122, 244, 44].includes(c.profile_idc)) {
    c.chroma_format_idc = r.int(0, 3);
    w.ue(c.chroma_format_idc);
    if (c.chroma_format_idc === 3) { c.separate_colour_plane_flag = r.bit(); w.f(c.separate_colour_plane_flag); }
    w.ue(r.int(0, 6)).ue(r.int(0, 6)).f(r.bit(0.2));
    c.seq_scaling_matrix_present_flag = r.bit(0.6);
    w.f(c.seq_scaling_matrix_present_flag);
    if (c.seq_scaling_matrix_present_flag) {
      const n = c.chroma_format_idc !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) {
        const present = r.bit(0.6);
        w.f(present);
        if (present) synthScalingList(r, w, i < 6 ? 16 : 64);
      }
    }
  }
  c.log2_max_frame_num = r.int(4, 16);
  w.ue(c.log2_max_frame_num - 4);
  c.pic_order_cnt_type = r.int(0, 2);
  w.ue(c.pic_order_cnt_type);
  if (c.pic_order_cnt_type === 0) {
    c.log2_max_pic_order_cnt_lsb = r.int(4, 16);
    w.ue(c.log2_max_pic_order_cnt_lsb - 4);
  } else if (c.pic_order_cnt_type === 1) {
    c.delta_pic_order_always_zero_flag = r.bit(0.3);
    w.f(c.delta_pic_order_always_zero_flag).se(r.int(-300, 300)).se(r.int(-300, 300));
    const n = r.int(0, 5);
    w.ue(n);
    for (let i = 0; i < n; i++) w.se(r.int(-1000, 1000));
  }
  c.max_num_ref_frames = r.int(1, 16);
  w.ue(c.max_num_ref_frames).f(r.bit(0.1));
  c.pic_width_in_mbs = r.int(1, 120);
  c.pic_height_in_map_units = r.int(1, 68);
  w.ue(c.pic_width_in_mbs - 1).ue(c.pic_height_in_map_units - 1);
  c.frame_mbs_only_flag = r.bit(0.6);
  w.f(c.frame_mbs_only_flag);
  if (!c.frame_mbs_only_flag) w.f(r.bit());
  w.f(r.bit());
  const crop = r.bit(0.5);
  w.f(crop);
  if (crop) w.ue(r.int(0, 3)).ue(r.int(0, 3)).ue(r.int(0, 3)).ue(r.int(0, 3));
  const vui = r.bit(0.7);
  w.f(vui);
  if (vui) synthVui(r, w);
  w.trailing();
  return { nal: makeNal(0x67, w.bytes()), cfg: c };
}

function synthScalingList(r, w, size) {
  // Иногда «матрица по умолчанию» (nextScale = 0 сразу), иногда обрыв посередине
  let last = 8;
  const stopAt = r.bit(0.3) ? r.int(0, size - 1) : -1;
  for (let j = 0; j < size; j++) {
    let next;
    if (j === stopAt) next = 0;
    else next = r.int(1, 255);
    let delta = next - last;
    if (delta > 127) delta -= 256;
    if (delta < -128) delta += 256;
    w.se(delta);
    if (next === 0) return;
    last = next;
  }
}

function synthVui(r, w) {
  const ar = r.bit();
  w.f(ar);
  if (ar) {
    const idc = r.pick([0, 1, 2, 5, 14, 16, 255]);
    w.u(8, idc);
    if (idc === 255) w.u(16, r.int(1, 999)).u(16, r.int(1, 999));
  }
  const ov = r.bit();
  w.f(ov);
  if (ov) w.f(r.bit());
  const vs = r.bit();
  w.f(vs);
  if (vs) {
    w.u(3, r.int(0, 5)).f(r.bit());
    const cd = r.bit();
    w.f(cd);
    if (cd) w.u(8, r.int(1, 12)).u(8, r.int(1, 18)).u(8, r.int(0, 11));
  }
  const cl = r.bit();
  w.f(cl);
  if (cl) w.ue(r.int(0, 5)).ue(r.int(0, 5));
  const ti = r.bit();
  w.f(ti);
  if (ti) w.u(32, r.int(1, 1001)).u(32, r.int(1, 120000)).f(r.bit());
  const nal = r.bit(0.4), vcl = r.bit(0.4);
  w.f(nal);
  if (nal) synthHrd(r, w);
  w.f(vcl);
  if (vcl) synthHrd(r, w);
  if (nal || vcl) w.f(r.bit());
  w.f(r.bit());
  const bs = r.bit();
  w.f(bs);
  if (bs) w.f(r.bit()).ue(r.int(0, 16)).ue(r.int(0, 16)).ue(r.int(0, 16)).ue(r.int(0, 16)).ue(r.int(0, 4)).ue(r.int(0, 16));
}

function synthHrd(r, w) {
  const n = r.int(0, 3);
  w.ue(n).u(4, r.int(0, 15)).u(4, r.int(0, 15));
  for (let i = 0; i <= n; i++) w.ue(r.int(0, 100000)).ue(r.int(0, 100000)).f(r.bit());
  w.u(5, r.int(0, 31)).u(5, r.int(0, 31)).u(5, r.int(0, 31)).u(5, r.int(0, 31));
}

// Случайный PPS к данному SPS
function synthPPS(r, id, sps) {
  const w = new BitWriter();
  const c = { pic_parameter_set_id: id, seq_parameter_set_id: sps.seq_parameter_set_id };
  c.entropy_coding_mode_flag = r.bit();
  c.bottom_field_pic_order_in_frame_present_flag = r.bit();
  c.num_ref_idx_l0_default_active_minus1 = r.int(0, 3);
  c.num_ref_idx_l1_default_active_minus1 = r.int(0, 3);
  c.weighted_pred_flag = r.bit();
  c.weighted_bipred_idc = r.int(0, 2);
  c.deblocking_filter_control_present_flag = r.bit(0.7);
  c.redundant_pic_cnt_present_flag = r.bit(0.3);
  w.ue(id).ue(sps.seq_parameter_set_id).f(c.entropy_coding_mode_flag).f(c.bottom_field_pic_order_in_frame_present_flag)
    .ue(0).ue(c.num_ref_idx_l0_default_active_minus1).ue(c.num_ref_idx_l1_default_active_minus1)
    .f(c.weighted_pred_flag).u(2, c.weighted_bipred_idc).se(r.int(-26, 25)).se(r.int(-26, 25)).se(r.int(-12, 12))
    .f(c.deblocking_filter_control_present_flag).f(r.bit()).f(c.redundant_pic_cnt_present_flag);
  if (r.bit(0.6)) {
    const t8 = r.bit();
    w.f(t8);
    const sm = r.bit();
    w.f(sm);
    if (sm) {
      const n = 6 + (sps.chroma_format_idc !== 3 ? 2 : 6) * t8;
      for (let i = 0; i < n; i++) {
        const present = r.bit(0.5);
        w.f(present);
        if (present) synthScalingList(r, w, i < 6 ? 16 : 64);
      }
    }
    w.se(r.int(-12, 12));
  }
  w.trailing();
  return { nal: makeNal(0x68, w.bytes()), cfg: c };
}

// Случайный заголовок слайса (+ немного «данных») к SPS/PPS.
// opts.bigZeros — длинные коды из нулей, чтобы в заголовке появились байты 0x03.
function synthSlice(r, sps, pps, opts = {}) {
  const idr = r.bit(0.3);
  const refIdc = idr ? r.int(1, 3) : r.int(0, 3);
  const w = new BitWriter();
  const st = idr ? r.pick([2, 4]) : r.int(0, 4);
  const sliceType = st + (r.bit() ? 5 : 0);
  const chroma = !sps.separate_colour_plane_flag && sps.chroma_format_idc !== 0;
  w.ue(opts.bigZeros ? 65536 + r.int(0, 60000) : r.int(0, 2000)).ue(sliceType).ue(pps.pic_parameter_set_id);
  if (sps.separate_colour_plane_flag) w.u(2, r.int(0, 2));
  w.u(sps.log2_max_frame_num, opts.bigZeros ? 0 : r.int(0, 2 ** sps.log2_max_frame_num - 1));
  let field = 0;
  if (!sps.frame_mbs_only_flag) {
    field = r.bit();
    w.f(field);
    if (field) w.f(r.bit());
  }
  if (idr) w.ue(opts.bigZeros ? 65535 : r.int(0, 65535));
  if (sps.pic_order_cnt_type === 0) {
    w.u(sps.log2_max_pic_order_cnt_lsb, opts.bigZeros ? 0 : r.int(0, 2 ** sps.log2_max_pic_order_cnt_lsb - 1));
    if (pps.bottom_field_pic_order_in_frame_present_flag && !field) w.se(r.int(-1000, 1000));
  }
  if (sps.pic_order_cnt_type === 1 && !sps.delta_pic_order_always_zero_flag) {
    w.se(r.int(-1000, 1000));
    if (pps.bottom_field_pic_order_in_frame_present_flag && !field) w.se(r.int(-1000, 1000));
  }
  if (pps.redundant_pic_cnt_present_flag) w.ue(r.int(0, 127));
  if (st === 1) w.f(r.bit());
  let l0 = pps.num_ref_idx_l0_default_active_minus1, l1 = pps.num_ref_idx_l1_default_active_minus1;
  if (st === 0 || st === 3 || st === 1) {
    const ov = r.bit();
    w.f(ov);
    if (ov) {
      l0 = r.int(0, 5); w.ue(l0);
      if (st === 1) { l1 = r.int(0, 5); w.ue(l1); }
    }
  }
  const rplm = () => {
    const flag = r.bit();
    w.f(flag);
    if (!flag) return;
    const n = r.int(0, 3);
    for (let i = 0; i < n; i++) {
      const idc = r.int(0, 2);
      w.ue(idc);
      if (idc < 2) w.ue(r.int(0, 15));
      else w.ue(r.int(0, sps.max_num_ref_frames - 1));
    }
    w.ue(3);
  };
  if (st !== 2 && st !== 4) rplm();
  if (st === 1) rplm();
  if ((pps.weighted_pred_flag && (st === 0 || st === 3)) || (pps.weighted_bipred_idc === 1 && st === 1)) {
    w.ue(r.int(0, 7));
    if (chroma) w.ue(r.int(0, 7));
    const table = n => {
      for (let i = 0; i <= n; i++) {
        const lf = r.bit(); w.f(lf);
        if (lf) w.se(r.int(-128, 127)).se(r.int(-128, 127));
        if (chroma) {
          const cf = r.bit(); w.f(cf);
          if (cf) for (let j = 0; j < 2; j++) w.se(r.int(-128, 127)).se(r.int(-128, 127));
        }
      }
    };
    table(l0);
    if (st === 1) table(l1);
  }
  if (refIdc) {
    if (idr) w.f(r.bit()).f(r.bit());
    else {
      const ad = r.bit();
      w.f(ad);
      if (ad) {
        const n = r.int(0, 4);
        for (let i = 0; i < n; i++) {
          const op = r.int(1, 6);
          w.ue(op);
          if (op === 1 || op === 3) w.ue(r.int(0, 30));
          if (op === 2) w.ue(r.int(0, sps.max_num_ref_frames - 1));
          if (op === 3 || op === 6) w.ue(r.int(0, sps.max_num_ref_frames - 1));
          if (op === 4) w.ue(r.int(0, sps.max_num_ref_frames));
        }
        w.ue(0);
      }
    }
  }
  if (pps.entropy_coding_mode_flag && st !== 2 && st !== 4) w.ue(r.int(0, 2));
  w.se(r.int(-20, 20));
  if (st === 3 || st === 4) {
    if (st === 3) w.f(r.bit());
    w.se(r.int(-51, 51));
  }
  if (pps.deblocking_filter_control_present_flag) {
    const d = r.int(0, 2);
    w.ue(d);
    if (d !== 1) w.se(r.int(-6, 6)).se(r.int(-6, 6));
  }
  const headerBits = w.bits.length;
  if (pps.entropy_coding_mode_flag) while (w.bits.length % 8) w.f(1);   // cabac_alignment_one_bit
  for (let i = 0; i < 24; i++) w.u(8, r.int(1, 255));                 // «данные слайса»
  w.trailing();
  return { nal: makeNal((refIdc << 5) | (idr ? 5 : 1), w.bytes()), headerBits, idr, refIdc, sliceType };
}

module.exports = {
  FIXTURES, readFixture, splitAnnexB, groupAccessUnits, toSamples, buildAvcC, loadStream,
  picOrderCounts, timing, run, HAS_FFMPEG, tmpDir, parseTrace, traceHeaders,
  BitWriter, escapeRbsp, makeNal, prng, synthSPS, synthPPS, synthSlice,
};

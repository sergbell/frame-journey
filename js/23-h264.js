/* =====================================================================
   23-h264 — разбор H.264 (ITU-T H.264 | ISO/IEC 14496-10) для байтовой
   карты сегмента и шифрования cbcs.

   Вход — сэмплы WebCodecs VideoEncoder с avc: {format: 'avc'}: каждый
   сэмпл — NAL-блоки с 4-байтовой длиной (big-endian) перед каждым;
   описание декодера — AVCDecoderConfigurationRecord ('avcC',
   ISO/IEC 14496-15 §5.3.3.1).

   Что здесь есть:
   - avcC, NAL-блоки сэмпла, RBSP без байтов 0x03 защиты от эмуляции
     (и обратное отображение смещений RBSP → NAL);
   - битовый читатель: u(n), ue(v)/se(v) (Exp-Golomb, §9.1), more_rbsp_data;
   - SPS (§7.3.2.1.1, + VUI из Annex E), PPS (§7.3.2.2);
   - полный заголовок слайса (§7.3.3) с позицией каждого поля в битах;
   - карта подвыборок CENC 'cbcs': открыты длина, байт заголовка NAL и
     заголовок слайса, шифруются данные слайса (ISO/IEC 23001-7, CMAF).

   Позиции полей (bitStart) считаются в битах RBSP после байта заголовка
   NAL — так же, как у ffmpeg trace_headers, только без его 8 бит заголовка.
   Работает в браузере (FJ.h264) и в node (module.exports).
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};

  /* ------------------------------------------------------------------
     Общие мелочи
     ------------------------------------------------------------------ */
  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    throw new TypeError('ожидались байты (Uint8Array, ArrayBuffer или типизированный массив)');
  }
  const hex2 = v => v.toString(16).padStart(2, '0');
  // Контекст {spsById, ppsById} может быть и объектом, и Map
  const ctxGet = (m, k) => (m instanceof Map ? m.get(k) : m && m[k]);
  const ctxSet = (m, k, v) => { if (m instanceof Map) m.set(k, v); else m[k] = v; };

  /* ------------------------------------------------------------------
     Типы NAL-блоков (Table 7-1) и типы слайсов (Table 7-6)
     ------------------------------------------------------------------ */
  const NAL_NAMES = {
    1: 'non-IDR', 2: 'DPA', 3: 'DPB', 4: 'DPC', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS',
    9: 'AUD', 10: 'EOSeq', 11: 'EOStream', 12: 'Filler', 13: 'SPS-ext', 14: 'Prefix',
    15: 'Subset-SPS', 16: 'DPS', 19: 'Aux-slice', 20: 'Slice-ext', 21: 'Slice-ext-3D',
  };
  const nalName = t => NAL_NAMES[t] || (t === 0 || t >= 24 ? 'unspecified' : 'reserved');
  // Слайсы, которые мы умеем разбирать и шифровать: 1 (не-IDR) и 5 (IDR).
  // Разделы данных 2–4 (Extended profile) и MVC/SVC (20/21) остаются открытыми.
  const isSliceNal = t => t === 1 || t === 5;
  const SLICE_TYPE_NAMES = ['P', 'B', 'I', 'SP', 'SI']; // slice_type % 5
  const P = 0, B = 1, I = 2, SP = 3, SI = 4;

  /* ------------------------------------------------------------------
     AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1)
     ------------------------------------------------------------------ */
  function parseAvcC(input) {
    const u8 = toU8(input);
    let p = 0;
    const need = n => {
      if (p + n > u8.length) throw new RangeError(`avcC: запись обрывается на байте ${p} (нужно ещё ${n}, всего ${u8.length})`);
    };
    const readSets = count => {
      const list = [];
      for (let i = 0; i < count; i++) {
        need(2);
        const len = (u8[p] << 8) | u8[p + 1];
        p += 2;
        need(len);
        list.push(u8.slice(p, p + len));
        p += len;
      }
      return list;
    };
    need(6);
    const version = u8[0];
    if (version !== 1) throw new Error(`avcC: configurationVersion = ${version}, ожидалась 1`);
    const profile = u8[1], compat = u8[2], level = u8[3];
    const lengthSize = (u8[4] & 3) + 1;          // lengthSizeMinusOne + 1
    p = 6;
    const sps = readSets(u8[5] & 31);
    need(1);
    const pps = readSets(u8[p++]);
    // Расширение для High-профилей (есть, когда профиль не 66/77/88).
    // Старые упаковщики его не пишут — тогда просто нет байтов.
    let ext = null;
    if (profile !== 66 && profile !== 77 && profile !== 88 && p + 4 <= u8.length) {
      const head = p;
      try {
        ext = {
          chromaFormat: u8[p] & 3,
          bitDepthLuma: (u8[p + 1] & 7) + 8,
          bitDepthChroma: (u8[p + 2] & 7) + 8,
          spsExt: null,
        };
        const count = u8[p + 3];
        p += 4;
        ext.spsExt = readSets(count);
      } catch (e) {
        ext = null;          // битый хвост не портит главное — SPS и PPS уже прочитаны
        p = head;
      }
    }
    return {
      version, profile, compat, level, lengthSize, sps, pps, ext,
      codec: 'avc1.' + hex2(profile) + hex2(compat) + hex2(level),
    };
  }

  /* ------------------------------------------------------------------
     NAL-блоки сэмпла: [длина][заголовок NAL][полезная нагрузка]...
     ------------------------------------------------------------------ */
  function nals(sample, lengthSize = 4) {
    const u8 = toU8(sample);
    if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) throw new RangeError(`lengthSize = ${lengthSize}, допустимо 1–4`);
    const list = [];
    let offset = 0;
    while (offset < u8.length) {
      const i = list.length;
      if (offset + lengthSize > u8.length) throw new RangeError(`NAL #${i}: поле длины на байте ${offset} выходит за конец сэмпла (${u8.length})`);
      let size = 0;
      for (let k = 0; k < lengthSize; k++) size = size * 256 + u8[offset + k];
      const start = offset + lengthSize;
      if (size === 0) throw new RangeError(`NAL #${i} на байте ${offset}: нулевая длина`);
      if (start + size > u8.length) throw new RangeError(`NAL #${i} на байте ${offset}: длина ${size} выходит за конец сэмпла (${u8.length})`);
      const h = u8[start];
      const type = h & 31;
      list.push({
        offset, lengthSize, start, size, end: start + size,
        type, refIdc: (h >> 5) & 3, forbiddenBit: h >> 7, name: nalName(type),
      });
      offset = start + size;
    }
    return list;
  }

  /* ------------------------------------------------------------------
     RBSP: убираем emulation_prevention_three_byte (00 00 03 → 00 00),
     §7.3.1 / §7.4.1. epbPositions — индексы убранных 0x03 в исходном NAL.
     limit — сколько байт RBSP достаточно (заголовку слайса хватает начала).
     ------------------------------------------------------------------ */
  const nalHeaderBytes = type => (type === 14 || type === 20 || type === 21 ? 4 : 1);

  function rbsp(nal, limit = Infinity) {
    const u8 = toU8(nal);
    const headerBytes = u8.length ? nalHeaderBytes(u8[0] & 31) : 1;
    const cap = Math.max(0, Math.min(u8.length - headerBytes, limit));
    const bytes = new Uint8Array(cap);
    const epbPositions = [];
    let n = 0, zeros = 0, i = headerBytes;
    for (; i < u8.length && n < cap; i++) {
      const b = u8[i];
      if (zeros >= 2 && b === 3) { epbPositions.push(i); zeros = 0; continue; }
      bytes[n++] = b;
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return { bytes: bytes.subarray(0, n), epbPositions, headerBytes, truncated: i < u8.length };
  }

  // Байт RBSP № rbspByte → индекс того же байта в исходном NAL
  // (учитывая байт заголовка и все 0x03, стоящие раньше него).
  function rbspToNal(rb, rbspByte) {
    let pos = rb.headerBytes + rbspByte;
    for (const e of rb.epbPositions) {
      if (e <= pos) pos++;
      else break;
    }
    return pos;
  }
  // То же для бита: {byte, bit} в исходном NAL (bit — 0 = старший бит байта)
  function rbspBitToNal(rb, rbspBit) {
    return { byte: rbspToNal(rb, Math.floor(rbspBit / 8)), bit: rbspBit % 8 };
  }

  /* ------------------------------------------------------------------
     Битовый читатель: u(n), ue(v), se(v) — Exp-Golomb по §9.1
     ------------------------------------------------------------------ */
  class BitReader {
    constructor(bytes, bitPos = 0) {
      this.bytes = toU8(bytes);
      this.pos = bitPos;
      this.bitLength = this.bytes.length * 8;
      this._stopBit = undefined;
    }
    get bitsLeft() { return this.bitLength - this.pos; }
    u1() {
      if (this.pos >= this.bitLength) throw new RangeError(`битовый поток кончился на бите ${this.pos}`);
      const bit = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return bit;
    }
    // Беззнаковое целое из n бит (арифметика без побитовых операций: годится и для 32 бит)
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + this.u1();
      return v;
    }
    ue() {
      let zeros = 0;
      while (this.u1() === 0) {
        if (++zeros > 32) throw new RangeError(`код Exp-Golomb длиннее 32 нулей (бит ${this.pos})`);
      }
      return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
    }
    se() {
      const k = this.ue();
      if (k % 2) return (k + 1) / 2;
      return k === 0 ? 0 : -(k / 2);
    }
    byteAligned() { return (this.pos & 7) === 0; }
    // Позиция rbsp_stop_one_bit: последний единичный бит RBSP (нули после него — хвост)
    stopBitPos() {
      if (this._stopBit === undefined) {
        let i = this.bytes.length - 1;
        while (i >= 0 && this.bytes[i] === 0) i--;
        if (i < 0) this._stopBit = -1;
        else {
          let bit = 0;
          while (!((this.bytes[i] >> bit) & 1)) bit++;
          this._stopBit = i * 8 + 7 - bit;
        }
      }
      return this._stopBit;
    }
    moreRbspData() { return this.pos < this.stopBitPos(); }
  }

  // Чтение синтаксических элементов с записью {name, value, bitStart, bitLen}
  function syntax(br, fields) {
    const rec = (name, read) => {
      const bitStart = br.pos;
      const value = read();
      fields.push({ name, value, bitStart, bitLen: br.pos - bitStart });
      return value;
    };
    return {
      u: (name, n) => rec(name, () => br.u(n)),
      f: name => rec(name, () => br.u1()),
      ue: name => rec(name, () => br.ue()),
      se: name => rec(name, () => br.se()),
    };
  }

  /* ------------------------------------------------------------------
     Списки масштабирования (§7.3.2.1.1.1). Список может оборваться
     кодом nextScale = 0 — тогда остаток повторяет последнее значение,
     а nextScale = 0 на первом элементе значит «матрица по умолчанию».
     Значения — в порядке передачи (зигзаг).
     ------------------------------------------------------------------ */
  function scalingList(r, size) {
    let last = 8, next = 8, useDefault = false;
    const list = new Array(size);
    for (let j = 0; j < size; j++) {
      if (next !== 0) {
        const delta = r.se(`delta_scale[${j}]`);
        next = (last + delta + 256) % 256;
        useDefault = j === 0 && next === 0;
      }
      list[j] = next === 0 ? last : next;
      last = list[j];
    }
    return { useDefault, list };
  }
  function scalingLists(r, count, flagName) {
    const lists = [];
    for (let i = 0; i < count; i++) {
      const present = r.f(`${flagName}[${i}]`);
      lists.push(present ? scalingList(r, i < 6 ? 16 : 64) : null);
    }
    return lists;
  }

  /* ------------------------------------------------------------------
     SPS — seq_parameter_set_data() (§7.3.2.1.1)
     ------------------------------------------------------------------ */
  // Профили, у которых в SPS есть chroma_format_idc, битность и матрицы
  const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  // Table E-1: aspect_ratio_idc → соотношение сторон пикселя
  const SAR_TABLE = [null, [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11],
    [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];

  function profileName(s) {
    switch (s.profile_idc) {
      case 66: return s.constraint_set1_flag ? 'Constrained Baseline' : 'Baseline';
      case 77: return 'Main';
      case 88: return 'Extended';
      case 100: return s.constraint_set4_flag && s.constraint_set5_flag ? 'Constrained High' : 'High';
      case 110: return s.constraint_set3_flag ? 'High 10 Intra' : 'High 10';
      case 122: return s.constraint_set3_flag ? 'High 4:2:2 Intra' : 'High 4:2:2';
      case 244: return s.constraint_set3_flag ? 'High 4:4:4 Intra' : 'High 4:4:4 Predictive';
      case 44: return 'CAVLC 4:4:4 Intra';
      default: return 'profile ' + s.profile_idc;
    }
  }

  function parseSPS(nal) {
    const u8 = toU8(nal);
    const type = u8[0] & 31;
    if (type !== 7) throw new Error(`parseSPS: NAL типа ${type} (${nalName(type)}), ожидался 7 (SPS)`);
    const rb = rbsp(u8);
    const br = new BitReader(rb.bytes);
    const fields = [];
    const r = syntax(br, fields);
    const s = { nalType: type, fields };

    s.profile_idc = r.u('profile_idc', 8);
    for (let i = 0; i < 6; i++) s[`constraint_set${i}_flag`] = r.f(`constraint_set${i}_flag`);
    s.reserved_zero_2bits = r.u('reserved_zero_2bits', 2);
    s.level_idc = r.u('level_idc', 8);
    s.seq_parameter_set_id = r.ue('seq_parameter_set_id');

    // Значения по умолчанию для профилей без этих полей (§7.4.2.1.1;
    // профиль 183 — карта глубины, монохромная)
    s.chroma_format_idc = s.profile_idc === 183 ? 0 : 1;
    s.separate_colour_plane_flag = 0;
    s.bit_depth_luma_minus8 = 0;
    s.bit_depth_chroma_minus8 = 0;
    s.qpprime_y_zero_transform_bypass_flag = 0;
    s.seq_scaling_matrix_present_flag = 0;
    s.seq_scaling_lists = null;
    if (HIGH_PROFILES.includes(s.profile_idc)) {
      s.chroma_format_idc = r.ue('chroma_format_idc');
      if (s.chroma_format_idc === 3) s.separate_colour_plane_flag = r.f('separate_colour_plane_flag');
      s.bit_depth_luma_minus8 = r.ue('bit_depth_luma_minus8');
      s.bit_depth_chroma_minus8 = r.ue('bit_depth_chroma_minus8');
      s.qpprime_y_zero_transform_bypass_flag = r.f('qpprime_y_zero_transform_bypass_flag');
      s.seq_scaling_matrix_present_flag = r.f('seq_scaling_matrix_present_flag');
      if (s.seq_scaling_matrix_present_flag) {
        s.seq_scaling_lists = scalingLists(r, s.chroma_format_idc !== 3 ? 8 : 12, 'seq_scaling_list_present_flag');
      }
    }
    s.bit_depth_luma = 8 + s.bit_depth_luma_minus8;
    s.bit_depth_chroma = 8 + s.bit_depth_chroma_minus8;

    s.log2_max_frame_num_minus4 = r.ue('log2_max_frame_num_minus4');
    s.log2_max_frame_num = s.log2_max_frame_num_minus4 + 4;
    s.pic_order_cnt_type = r.ue('pic_order_cnt_type');
    if (s.pic_order_cnt_type === 0) {
      s.log2_max_pic_order_cnt_lsb_minus4 = r.ue('log2_max_pic_order_cnt_lsb_minus4');
      s.log2_max_pic_order_cnt_lsb = s.log2_max_pic_order_cnt_lsb_minus4 + 4;
    } else if (s.pic_order_cnt_type === 1) {
      s.delta_pic_order_always_zero_flag = r.f('delta_pic_order_always_zero_flag');
      s.offset_for_non_ref_pic = r.se('offset_for_non_ref_pic');
      s.offset_for_top_to_bottom_field = r.se('offset_for_top_to_bottom_field');
      s.num_ref_frames_in_pic_order_cnt_cycle = r.ue('num_ref_frames_in_pic_order_cnt_cycle');
      s.offset_for_ref_frame = [];
      for (let i = 0; i < s.num_ref_frames_in_pic_order_cnt_cycle; i++) {
        s.offset_for_ref_frame.push(r.se(`offset_for_ref_frame[${i}]`));
      }
    }
    s.max_num_ref_frames = r.ue('max_num_ref_frames');
    s.gaps_in_frame_num_value_allowed_flag = r.f('gaps_in_frame_num_value_allowed_flag');
    s.pic_width_in_mbs_minus1 = r.ue('pic_width_in_mbs_minus1');
    s.pic_height_in_map_units_minus1 = r.ue('pic_height_in_map_units_minus1');
    s.frame_mbs_only_flag = r.f('frame_mbs_only_flag');
    s.mb_adaptive_frame_field_flag = s.frame_mbs_only_flag ? 0 : r.f('mb_adaptive_frame_field_flag');
    s.direct_8x8_inference_flag = r.f('direct_8x8_inference_flag');
    s.frame_cropping_flag = r.f('frame_cropping_flag');
    s.frame_crop_left_offset = s.frame_crop_right_offset = s.frame_crop_top_offset = s.frame_crop_bottom_offset = 0;
    if (s.frame_cropping_flag) {
      s.frame_crop_left_offset = r.ue('frame_crop_left_offset');
      s.frame_crop_right_offset = r.ue('frame_crop_right_offset');
      s.frame_crop_top_offset = r.ue('frame_crop_top_offset');
      s.frame_crop_bottom_offset = r.ue('frame_crop_bottom_offset');
    }
    s.vui_parameters_present_flag = r.f('vui_parameters_present_flag');
    s.vui = null;
    if (s.vui_parameters_present_flag) {
      // Битый VUI не должен мешать размерам кадра — ошибку запоминаем
      try { s.vui = parseVui(r); } catch (e) { s.vui = { error: e.message }; }
    }

    // Производные величины (§7.4.2.1.1, Table 6-1)
    s.chromaArrayType = s.separate_colour_plane_flag ? 0 : s.chroma_format_idc;
    const subWidthC = s.chroma_format_idc === 3 ? 1 : 2;
    const subHeightC = s.chroma_format_idc === 1 ? 2 : 1;
    const cropUnitX = s.chromaArrayType === 0 ? 1 : subWidthC;
    const cropUnitY = (s.chromaArrayType === 0 ? 1 : subHeightC) * (2 - s.frame_mbs_only_flag);
    s.pic_width_in_mbs = s.pic_width_in_mbs_minus1 + 1;
    s.pic_height_in_map_units = s.pic_height_in_map_units_minus1 + 1;
    s.frame_height_in_mbs = (2 - s.frame_mbs_only_flag) * s.pic_height_in_map_units;
    s.codedWidth = s.pic_width_in_mbs * 16;
    s.codedHeight = s.frame_height_in_mbs * 16;
    s.width = s.codedWidth - cropUnitX * (s.frame_crop_left_offset + s.frame_crop_right_offset);
    s.height = s.codedHeight - cropUnitY * (s.frame_crop_top_offset + s.frame_crop_bottom_offset);
    s.sar = s.vui && s.vui.sar ? s.vui.sar : null;
    s.profileName = profileName(s);
    s.codec = 'avc1.' + hex2(s.profile_idc) + hex2(rb.bytes[1]) + hex2(s.level_idc);
    s.bitLength = br.pos;
    return s;
  }

  /* VUI (Annex E.1.1) — нужен ради SAR, цвета и тайминга */
  function parseVui(r) {
    const v = {};
    v.aspect_ratio_info_present_flag = r.f('aspect_ratio_info_present_flag');
    if (v.aspect_ratio_info_present_flag) {
      v.aspect_ratio_idc = r.u('aspect_ratio_idc', 8);
      if (v.aspect_ratio_idc === 255) {          // Extended_SAR
        v.sar_width = r.u('sar_width', 16);
        v.sar_height = r.u('sar_height', 16);
        if (v.sar_width && v.sar_height) v.sar = [v.sar_width, v.sar_height];
      } else if (SAR_TABLE[v.aspect_ratio_idc]) {
        v.sar = SAR_TABLE[v.aspect_ratio_idc].slice();
      }
    }
    v.overscan_info_present_flag = r.f('overscan_info_present_flag');
    if (v.overscan_info_present_flag) v.overscan_appropriate_flag = r.f('overscan_appropriate_flag');
    v.video_signal_type_present_flag = r.f('video_signal_type_present_flag');
    if (v.video_signal_type_present_flag) {
      v.video_format = r.u('video_format', 3);
      v.video_full_range_flag = r.f('video_full_range_flag');
      v.colour_description_present_flag = r.f('colour_description_present_flag');
      if (v.colour_description_present_flag) {
        v.colour_primaries = r.u('colour_primaries', 8);
        v.transfer_characteristics = r.u('transfer_characteristics', 8);
        v.matrix_coefficients = r.u('matrix_coefficients', 8);
      }
    }
    v.chroma_loc_info_present_flag = r.f('chroma_loc_info_present_flag');
    if (v.chroma_loc_info_present_flag) {
      v.chroma_sample_loc_type_top_field = r.ue('chroma_sample_loc_type_top_field');
      v.chroma_sample_loc_type_bottom_field = r.ue('chroma_sample_loc_type_bottom_field');
    }
    v.timing_info_present_flag = r.f('timing_info_present_flag');
    if (v.timing_info_present_flag) {
      v.num_units_in_tick = r.u('num_units_in_tick', 32);
      v.time_scale = r.u('time_scale', 32);
      v.fixed_frame_rate_flag = r.f('fixed_frame_rate_flag');
    }
    v.nal_hrd_parameters_present_flag = r.f('nal_hrd_parameters_present_flag');
    if (v.nal_hrd_parameters_present_flag) v.nal_hrd = parseHrd(r);
    v.vcl_hrd_parameters_present_flag = r.f('vcl_hrd_parameters_present_flag');
    if (v.vcl_hrd_parameters_present_flag) v.vcl_hrd = parseHrd(r);
    if (v.nal_hrd_parameters_present_flag || v.vcl_hrd_parameters_present_flag) {
      v.low_delay_hrd_flag = r.f('low_delay_hrd_flag');
    }
    v.pic_struct_present_flag = r.f('pic_struct_present_flag');
    v.bitstream_restriction_flag = r.f('bitstream_restriction_flag');
    if (v.bitstream_restriction_flag) {
      v.motion_vectors_over_pic_boundaries_flag = r.f('motion_vectors_over_pic_boundaries_flag');
      v.max_bytes_per_pic_denom = r.ue('max_bytes_per_pic_denom');
      v.max_bits_per_mb_denom = r.ue('max_bits_per_mb_denom');
      v.log2_max_mv_length_horizontal = r.ue('log2_max_mv_length_horizontal');
      v.log2_max_mv_length_vertical = r.ue('log2_max_mv_length_vertical');
      v.max_num_reorder_frames = r.ue('max_num_reorder_frames');
      v.max_dec_frame_buffering = r.ue('max_dec_frame_buffering');
    }
    return v;
  }

  function parseHrd(r) {  // hrd_parameters() — Annex E.1.2
    const h = { cpb: [] };
    h.cpb_cnt_minus1 = r.ue('cpb_cnt_minus1');
    h.bit_rate_scale = r.u('bit_rate_scale', 4);
    h.cpb_size_scale = r.u('cpb_size_scale', 4);
    for (let i = 0; i <= h.cpb_cnt_minus1; i++) {
      h.cpb.push({
        bit_rate_value_minus1: r.ue(`bit_rate_value_minus1[${i}]`),
        cpb_size_value_minus1: r.ue(`cpb_size_value_minus1[${i}]`),
        cbr_flag: r.f(`cbr_flag[${i}]`),
      });
    }
    h.initial_cpb_removal_delay_length_minus1 = r.u('initial_cpb_removal_delay_length_minus1', 5);
    h.cpb_removal_delay_length_minus1 = r.u('cpb_removal_delay_length_minus1', 5);
    h.dpb_output_delay_length_minus1 = r.u('dpb_output_delay_length_minus1', 5);
    h.time_offset_length = r.u('time_offset_length', 5);
    return h;
  }

  /* ------------------------------------------------------------------
     PPS — pic_parameter_set_rbsp() (§7.3.2.2)
     spsById нужен только для числа матриц при transform_8x8_mode_flag.
     ------------------------------------------------------------------ */
  function parsePPS(nal, spsById) {
    const u8 = toU8(nal);
    const type = u8[0] & 31;
    if (type !== 8) throw new Error(`parsePPS: NAL типа ${type} (${nalName(type)}), ожидался 8 (PPS)`);
    const rb = rbsp(u8);
    const br = new BitReader(rb.bytes);
    const fields = [];
    const r = syntax(br, fields);
    const p = { nalType: type, fields };

    p.pic_parameter_set_id = r.ue('pic_parameter_set_id');
    p.seq_parameter_set_id = r.ue('seq_parameter_set_id');
    p.entropy_coding_mode_flag = r.f('entropy_coding_mode_flag');
    p.bottom_field_pic_order_in_frame_present_flag = r.f('bottom_field_pic_order_in_frame_present_flag');
    p.num_slice_groups_minus1 = r.ue('num_slice_groups_minus1');
    if (p.num_slice_groups_minus1 > 0) {
      throw new Error(`PPS ${p.pic_parameter_set_id}: ${p.num_slice_groups_minus1 + 1} группы слайсов (FMO, только Baseline/Extended) не поддерживаются — нужна одна`);
    }
    p.num_slice_groups = 1;
    p.num_ref_idx_l0_default_active_minus1 = r.ue('num_ref_idx_l0_default_active_minus1');
    p.num_ref_idx_l1_default_active_minus1 = r.ue('num_ref_idx_l1_default_active_minus1');
    p.weighted_pred_flag = r.f('weighted_pred_flag');
    p.weighted_bipred_idc = r.u('weighted_bipred_idc', 2);
    p.pic_init_qp_minus26 = r.se('pic_init_qp_minus26');
    p.pic_init_qs_minus26 = r.se('pic_init_qs_minus26');
    p.chroma_qp_index_offset = r.se('chroma_qp_index_offset');
    p.deblocking_filter_control_present_flag = r.f('deblocking_filter_control_present_flag');
    p.constrained_intra_pred_flag = r.f('constrained_intra_pred_flag');
    p.redundant_pic_cnt_present_flag = r.f('redundant_pic_cnt_present_flag');
    p.pic_init_qp = 26 + p.pic_init_qp_minus26;
    p.pic_init_qs = 26 + p.pic_init_qs_minus26;

    // Необязательный хвост (High-профили)
    p.transform_8x8_mode_flag = 0;
    p.pic_scaling_matrix_present_flag = 0;
    p.pic_scaling_lists = null;
    p.second_chroma_qp_index_offset = p.chroma_qp_index_offset; // выводится так, если поля нет (§7.4.2.2)
    if (br.moreRbspData()) {
      p.transform_8x8_mode_flag = r.f('transform_8x8_mode_flag');
      p.pic_scaling_matrix_present_flag = r.f('pic_scaling_matrix_present_flag');
      if (p.pic_scaling_matrix_present_flag) {
        let count = 6;
        if (p.transform_8x8_mode_flag) {
          const sps = ctxGet(spsById, p.seq_parameter_set_id);
          if (!sps) throw new Error(`PPS ${p.pic_parameter_set_id}: нужен SPS ${p.seq_parameter_set_id}, чтобы узнать число матриц 8×8`);
          count += sps.chroma_format_idc !== 3 ? 2 : 6;
        }
        p.pic_scaling_lists = scalingLists(r, count, 'pic_scaling_list_present_flag');
      }
      p.second_chroma_qp_index_offset = r.se('second_chroma_qp_index_offset');
    }
    p.bitLength = br.pos;
    return p;
  }

  /* ------------------------------------------------------------------
     Заголовок слайса — slice_header() (§7.3.3)
     ctx = {spsById, ppsById}: разобранные parseSPS/parsePPS (объект или Map).
     ------------------------------------------------------------------ */
  function sliceHeader(nal, ctx) {
    const u8 = toU8(nal);
    const nalType = u8[0] & 31;
    const refIdc = (u8[0] >> 5) & 3;
    if (!isSliceNal(nalType)) {
      throw new Error(`sliceHeader: NAL типа ${nalType} (${nalName(nalType)}) — не слайс 1/5`);
    }
    // Заголовку хватает начала NAL: разбираем префикс, при нехватке — весь NAL
    const head = rbsp(u8, 512);
    try {
      return parseSliceHeader(head, nalType, refIdc, ctx);
    } catch (e) {
      if (!(e instanceof RangeError) || !head.truncated) throw e;
    }
    return parseSliceHeader(rbsp(u8), nalType, refIdc, ctx);
  }

  function parseSliceHeader(rb, nalType, refIdc, ctx) {
    const idr = nalType === 5;
    const br = new BitReader(rb.bytes);
    const fields = [];
    const r = syntax(br, fields);
    const v = {};

    v.first_mb_in_slice = r.ue('first_mb_in_slice');
    v.slice_type = r.ue('slice_type');
    if (v.slice_type > 9) throw new Error(`slice_type = ${v.slice_type} вне диапазона 0–9`);
    const st = v.slice_type % 5;
    v.pic_parameter_set_id = r.ue('pic_parameter_set_id');
    const pps = ctxGet(ctx && ctx.ppsById, v.pic_parameter_set_id);
    if (!pps) throw new Error(`слайс ссылается на PPS ${v.pic_parameter_set_id}, которого нет в контексте`);
    const sps = ctxGet(ctx && ctx.spsById, pps.seq_parameter_set_id);
    if (!sps) throw new Error(`PPS ${pps.pic_parameter_set_id} ссылается на SPS ${pps.seq_parameter_set_id}, которого нет в контексте`);

    if (sps.separate_colour_plane_flag) v.colour_plane_id = r.u('colour_plane_id', 2);
    v.frame_num = r.u('frame_num', sps.log2_max_frame_num);
    v.field_pic_flag = 0;
    v.bottom_field_flag = 0;
    if (!sps.frame_mbs_only_flag) {
      v.field_pic_flag = r.f('field_pic_flag');
      if (v.field_pic_flag) v.bottom_field_flag = r.f('bottom_field_flag');
    }
    if (idr) v.idr_pic_id = r.ue('idr_pic_id');
    if (sps.pic_order_cnt_type === 0) {
      v.pic_order_cnt_lsb = r.u('pic_order_cnt_lsb', sps.log2_max_pic_order_cnt_lsb);
      if (pps.bottom_field_pic_order_in_frame_present_flag && !v.field_pic_flag) {
        v.delta_pic_order_cnt_bottom = r.se('delta_pic_order_cnt_bottom');
      }
    }
    if (sps.pic_order_cnt_type === 1 && !sps.delta_pic_order_always_zero_flag) {
      v.delta_pic_order_cnt = [r.se('delta_pic_order_cnt[0]'), 0];
      if (pps.bottom_field_pic_order_in_frame_present_flag && !v.field_pic_flag) {
        v.delta_pic_order_cnt[1] = r.se('delta_pic_order_cnt[1]');
      }
    }
    if (pps.redundant_pic_cnt_present_flag) v.redundant_pic_cnt = r.ue('redundant_pic_cnt');
    if (st === B) v.direct_spatial_mv_pred_flag = r.f('direct_spatial_mv_pred_flag');

    // Число активных опорных (если не переопределено — из PPS)
    v.num_ref_idx_l0_active_minus1 = pps.num_ref_idx_l0_default_active_minus1;
    v.num_ref_idx_l1_active_minus1 = pps.num_ref_idx_l1_default_active_minus1;
    if (st === P || st === SP || st === B) {
      v.num_ref_idx_active_override_flag = r.f('num_ref_idx_active_override_flag');
      if (v.num_ref_idx_active_override_flag) {
        v.num_ref_idx_l0_active_minus1 = r.ue('num_ref_idx_l0_active_minus1');
        if (st === B) v.num_ref_idx_l1_active_minus1 = r.ue('num_ref_idx_l1_active_minus1');
      }
    }

    // ref_pic_list_modification() (§7.3.3.1); MVC-вариант (NAL 20/21) сюда не попадает
    const modification = list => {
      const flag = r.f(`ref_pic_list_modification_flag_l${list}`);
      const ops = [];
      if (flag) {
        let idc;
        do {
          if (ops.length > 100) throw new Error('ref_pic_list_modification: слишком много операций');
          idc = r.ue('modification_of_pic_nums_idc');
          const op = { modification_of_pic_nums_idc: idc };
          if (idc === 0 || idc === 1) op.abs_diff_pic_num_minus1 = r.ue('abs_diff_pic_num_minus1');
          else if (idc === 2) op.long_term_pic_num = r.ue('long_term_pic_num');
          else if (idc !== 3) throw new Error(`modification_of_pic_nums_idc = ${idc} вне диапазона 0–3`);
          ops.push(op);
        } while (idc !== 3);
      }
      return { flag, ops };
    };
    if (st !== I && st !== SI) v.ref_pic_list_modification_l0 = modification(0);
    if (st === B) v.ref_pic_list_modification_l1 = modification(1);

    // pred_weight_table() (§7.3.3.2)
    if ((pps.weighted_pred_flag && (st === P || st === SP)) || (pps.weighted_bipred_idc === 1 && st === B)) {
      const chroma = sps.chromaArrayType !== 0;
      const t = { luma_log2_weight_denom: r.ue('luma_log2_weight_denom') };
      if (chroma) t.chroma_log2_weight_denom = r.ue('chroma_log2_weight_denom');
      const weights = (list, count) => {
        const out = [];
        for (let i = 0; i <= count; i++) {
          const e = { luma_weight_flag: r.f(`luma_weight_l${list}_flag[${i}]`) };
          if (e.luma_weight_flag) {
            e.luma_weight = r.se(`luma_weight_l${list}[${i}]`);
            e.luma_offset = r.se(`luma_offset_l${list}[${i}]`);
          }
          if (chroma) {
            e.chroma_weight_flag = r.f(`chroma_weight_l${list}_flag[${i}]`);
            if (e.chroma_weight_flag) {
              e.chroma = [];
              for (let j = 0; j < 2; j++) {
                e.chroma.push({
                  weight: r.se(`chroma_weight_l${list}[${i}][${j}]`),
                  offset: r.se(`chroma_offset_l${list}[${i}][${j}]`),
                });
              }
            }
          }
          out.push(e);
        }
        return out;
      };
      t.l0 = weights(0, v.num_ref_idx_l0_active_minus1);
      if (st === B) t.l1 = weights(1, v.num_ref_idx_l1_active_minus1);
      v.pred_weight_table = t;
    }

    // dec_ref_pic_marking() (§7.3.3.3) — только у опорных картинок
    if (refIdc !== 0) {
      const m = {};
      if (idr) {
        m.no_output_of_prior_pics_flag = r.f('no_output_of_prior_pics_flag');
        m.long_term_reference_flag = r.f('long_term_reference_flag');
      } else {
        m.adaptive_ref_pic_marking_mode_flag = r.f('adaptive_ref_pic_marking_mode_flag');
        if (m.adaptive_ref_pic_marking_mode_flag) {
          m.ops = [];
          let mmco;
          do {
            if (m.ops.length > 100) throw new Error('dec_ref_pic_marking: слишком много операций MMCO');
            mmco = r.ue('memory_management_control_operation');
            if (mmco > 6) throw new Error(`memory_management_control_operation = ${mmco} вне диапазона 0–6`);
            const op = { memory_management_control_operation: mmco };
            if (mmco === 1 || mmco === 3) op.difference_of_pic_nums_minus1 = r.ue('difference_of_pic_nums_minus1');
            if (mmco === 2) op.long_term_pic_num = r.ue('long_term_pic_num');
            if (mmco === 3 || mmco === 6) op.long_term_frame_idx = r.ue('long_term_frame_idx');
            if (mmco === 4) op.max_long_term_frame_idx_plus1 = r.ue('max_long_term_frame_idx_plus1');
            m.ops.push(op);
          } while (mmco !== 0);
        }
      }
      v.dec_ref_pic_marking = m;
    }

    if (pps.entropy_coding_mode_flag && st !== I && st !== SI) v.cabac_init_idc = r.ue('cabac_init_idc');
    v.slice_qp_delta = r.se('slice_qp_delta');
    if (st === SP || st === SI) {
      if (st === SP) v.sp_for_switch_flag = r.f('sp_for_switch_flag');
      v.slice_qs_delta = r.se('slice_qs_delta');
    }
    if (pps.deblocking_filter_control_present_flag) {
      v.disable_deblocking_filter_idc = r.ue('disable_deblocking_filter_idc');
      if (v.disable_deblocking_filter_idc !== 1) {
        v.slice_alpha_c0_offset_div2 = r.se('slice_alpha_c0_offset_div2');
        v.slice_beta_offset_div2 = r.se('slice_beta_offset_div2');
      }
    }
    // slice_group_change_cycle бывает только при нескольких группах слайсов — их отвергает parsePPS

    const headerBitsRbsp = br.pos;
    // CABAC: slice_data() начинается с cabac_alignment_one_bit до границы байта;
    // CAVLC: данные идут сразу, но общий байт остаётся открытым — округляем вверх.
    let cabacAlignOk = null;
    const alignBits = (8 - (headerBitsRbsp % 8)) % 8;
    if (pps.entropy_coding_mode_flag && alignBits) {
      const bits = r.u('cabac_alignment_one_bit', alignBits);
      cabacAlignOk = bits === 2 ** alignBits - 1;
    } else if (pps.entropy_coding_mode_flag) {
      cabacAlignOk = true;
    }
    const dataOffsetRbsp = Math.ceil(headerBitsRbsp / 8);
    const dataOffsetInNal = rbspToNal(rb, dataOffsetRbsp);

    return {
      fields,
      values: v,
      nalType, refIdc, idr,
      sliceType: v.slice_type,
      sliceTypeName: SLICE_TYPE_NAMES[st],
      qp: 26 + pps.pic_init_qp_minus26 + v.slice_qp_delta,
      entropy: pps.entropy_coding_mode_flag ? 'CABAC' : 'CAVLC',
      headerBitsRbsp,          // биты заголовка после байта заголовка NAL (без выравнивания CABAC)
      cabacAlignOk,            // CABAC: все биты выравнивания — единицы (null для CAVLC)
      dataOffsetRbsp,          // первый байт slice_data() в RBSP
      dataOffsetInNal,         // он же в исходном NAL (с байтом заголовка и байтами 0x03)
      epbInHeader: rb.epbPositions.filter(e => e < dataOffsetInNal).length,
      sps, pps,
    };
  }

  /* ------------------------------------------------------------------
     Сводка для упаковщика: FJ.mp4.init({...videoInfo(avcC), timescale, avcC})
     colr — только если в VUI есть описание цвета (иначе decoder берёт его из SPS)
     ------------------------------------------------------------------ */
  function videoInfo(avcC) {
    const rec = avcC && avcC.sps && avcC.pps ? avcC : parseAvcC(avcC);
    const sps = parseSPS(rec.sps[0]);
    const v = sps.vui && !sps.vui.error ? sps.vui : {};
    return {
      codec: rec.codec,
      profile: sps.profileName,
      level: sps.level_idc,
      width: sps.width,
      height: sps.height,
      sar: sps.sar || [1, 1],
      colr: v.colour_description_present_flag ? {
        primaries: v.colour_primaries, transfer: v.transfer_characteristics,
        matrix: v.matrix_coefficients, fullRange: !!v.video_full_range_flag,
      } : null,
      fps: v.timing_info_present_flag && v.num_units_in_tick ? v.time_scale / (2 * v.num_units_in_tick) : null,
      lengthSize: rec.lengthSize,
    };
  }

  /* ------------------------------------------------------------------
     Контекст декодера из avcC: {spsById, ppsById}
     ------------------------------------------------------------------ */
  function makeContext(avcC) {
    const rec = avcC && avcC.sps && avcC.pps ? avcC : parseAvcC(avcC);
    const ctx = { spsById: {}, ppsById: {}, lengthSize: rec.lengthSize };
    for (const nal of rec.sps) { const s = parseSPS(nal); ctx.spsById[s.seq_parameter_set_id] = s; }
    for (const nal of rec.pps) { const p = parsePPS(nal, ctx.spsById); ctx.ppsById[p.pic_parameter_set_id] = p; }
    return ctx;
  }

  /* ------------------------------------------------------------------
     Сэмпл целиком: NAL-блоки + разбор слайсов и параметров.
     SPS/PPS внутри сэмпла обновляют ctx — как у настоящего декодера.
     ------------------------------------------------------------------ */
  function parseSample(sample, ctx, lengthSize = 4) {
    const u8 = toU8(sample);
    const list = nals(u8, lengthSize);
    for (const n of list) {
      const nal = u8.subarray(n.start, n.end);
      if (n.type === 7) {
        const s = parseSPS(nal);
        ctxSet(ctx.spsById, s.seq_parameter_set_id, s);
        n.sps = s;
      } else if (n.type === 8) {
        const p = parsePPS(nal, ctx.spsById);
        ctxSet(ctx.ppsById, p.pic_parameter_set_id, p);
        n.pps = p;
      } else if (isSliceNal(n.type)) {
        n.slice = sliceHeader(nal, ctx);
      }
    }
    return list;
  }

  /* ------------------------------------------------------------------
     Карта подвыборок 'cbcs' для одного сэмпла (access unit).
     Для слайсов (NAL 1, 5): clear = длина + заголовок NAL + заголовок
     слайса (до dataOffsetInNal), protected = остаток NAL. Остальные NAL
     целиком открыты и приклеиваются к clear следующей подвыборки (или
     к хвостовой {clear, protected: 0}). BytesOfClearData — uint16:
     больше 65535 открытых байт подряд делим на несколько записей.
     ------------------------------------------------------------------ */
  const MAX_CLEAR = 0xffff;
  const MAX_PROTECTED = 0xffffffff;

  function cbcsSubsamples(sample, ctx, lengthSize = 4) {
    const list = parseSample(sample, ctx, lengthSize);
    const out = [];
    const push = (clear, prot) => {
      while (clear > MAX_CLEAR) { out.push({ clear: MAX_CLEAR, protected: 0 }); clear -= MAX_CLEAR; }
      if (prot > MAX_PROTECTED) throw new RangeError(`BytesOfProtectedData ${prot} не помещается в uint32`);
      out.push({ clear, protected: prot });
    };
    let clear = 0;
    for (const n of list) {
      if (n.slice) {
        clear += n.lengthSize + n.slice.dataOffsetInNal;
        push(clear, n.size - n.slice.dataOffsetInNal);
        clear = 0;
      } else {
        clear += n.lengthSize + n.size;
      }
    }
    if (clear > 0 || out.length === 0) push(clear, 0);
    return out;
  }

  FJ.h264 = {
    NAL_NAMES, SLICE_TYPE_NAMES, nalName,
    parseAvcC, nals, rbsp, rbspToNal, rbspBitToNal, BitReader,
    parseSPS, parsePPS, sliceHeader, makeContext, videoInfo, parseSample, cbcsSubsamples,
  };
  if (typeof module !== 'undefined') module.exports = FJ.h264;
})(typeof window !== 'undefined' ? window : globalThis);

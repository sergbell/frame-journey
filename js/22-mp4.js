/* =====================================================================
   22-mp4 — CMAF / фрагментированный MP4 (ISO/IEC 14496-12, 23000-19)
   и Common Encryption 'cbcs' (ISO/IEC 23001-7).

   - init()       — заголовок CMAF: ftyp + moov (одна видеодорожка H.264);
                    с encryption — encv/sinf/tenc и pssh;
   - segment()    — медиасегмент: styp + moof(mfhd, traf(tfhd, tfdt, trun
                    [, saiz, saio, senc])) + mdat;
   - encryptCbcs()/decryptCbcs() — шаблон 1:9 через WebCrypto AES-CBC
                    и карта байтов для рисования;
   - parse()      — дерево боксов с разобранными полями.

   Бренды (почему именно такие):
   ftyp: major 'cmfc', minor_version 0, compatible ['cmfc', 'cmf2', 'iso6'].
     'cmfc' — структурный бренд CMAF; если CMAF-бренд — major, minor_version
       обязан быть 0 (23000-19 §7.2), а major дублируем в compatible
       (иначе валидатор DASH-IF предупреждает).
     'cmf2' — более строгий CMAF-бренд (23000-19 §7.7). Мы выполняем его
       условия: у видео нет EditListBox (§7.7.2), trun версии 1 (§7.7.3),
       длительность/размер/флаги каждого сэмпла — в trun, а
       sample_description_index — в tfhd каждого фрагмента (§7.7.3).
       Спецификация AV1-в-ISOBMFF советует при 'cmf2' писать и 'cmfc'.
     'iso6' — версия ISOBMFF: default-base-is-moof разрешён только с 'iso5'
       и новее (14496-12 §8.8.7.1); 'iso6' покрывает tfdt и знаковые
       composition offsets в trun v1 (так же делают ffmpeg -movflags cmaf
       и GPAC в режиме DASH).
     Не пишем: 'isom'/'mp41'/'avc1' (старые бренды, GPAC их убирает для
       фрагментов), 'dash'/'msix' (требуют sidx), медиапрофили CMAF
       ('cfsd', 'cfhd'), потому что их ограничения (уровень, VUI и т. п.)
       зависят от кодировщика — их можно добавить через opts.brands.
   styp: major 'cmfs', minor 0, compatible ['cmfs', 'cmff', 'msdh'].
     'cmfs' — сегмент CMAF; 'cmff' — фрагмент CMAF: наш сегмент состоит
       ровно из одного фрагмента (один moof + mdat, начинается с IDR), так
       что верны оба (CTA-WAVE «CMAF Byte Stream Format»: 'cmff'/'cmfs'
       в styp обещают соответствие фрагменту/сегменту CMAF);
     'msdh' — медиасегмент DASH общего вида (23009-1 §6.3.4.2), валидатор
       DASH-IF требует его в styp; 'msix' нельзя — он обещает sidx (§6.3.4.3).
   Источники: mp4ra.org/registered-types/brands; DASH-IF ISOSegmentValidator
   (github.com/Dash-Industry-Forum/DASH-IF-Conformance, цитаты CMAF §7.2,
   §7.5.16, §7.5.17, §7.7.3); GPAC src/filters/mux_isom.c (режим cmf2);
   ffmpeg libavformat/movenc.c (выбор iso5/iso6).
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};

  const INIT_BRANDS = { major: 'cmfc', compatible: ['cmfc', 'cmf2', 'iso6'] };
  const SEGMENT_BRANDS = { major: 'cmfs', compatible: ['cmfs', 'cmff', 'msdh'] };

  /* ------------------------------------------------------------------
     Идентификаторы DRM-систем для pssh. Сверено 2026-09-25 с реестром
     DASH-IF Content Protection: https://dashif.org/identifiers/content_protection/
     ------------------------------------------------------------------ */
  const SYSTEM_IDS = {
    widevine: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',  // «Widevine Content Protection»
    playready: '9a04f079-9840-4286-ab92-e65be0885f95', // «Microsoft PlayReady»
    fairplay: '94ce86fb-07ff-4f43-adb8-93d2fa968ca2',  // «Apple FairPlay»
    common: '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b',    // «W3C Common PSSH box»
    clearkey: 'e2719d58-a985-b3c9-781a-b030af78d30e',  // «Clear Key DASH-IF»
  };

  // Флаги сэмпла (14496-12 §8.8.3.1): sync — sample_depends_on = 2 (ни от кого),
  // остальные — depends_on = 1 и sample_is_non_sync_sample = 1
  const SAMPLE_FLAGS = { sync: 0x02000000, nonSync: 0x01010000 };
  // tf_flags: default-base-is-moof (0x020000) + sample-description-index-present (0x02)
  const TFHD_FLAGS = 0x020002;
  const TRUN = { dataOffset: 0x1, firstSampleFlags: 0x4, duration: 0x100, size: 0x200, flags: 0x400, cto: 0x800 };

  /* ------------------------------------------------------------------
     Запись байтов: box(type, ...части) → Uint8Array
     ------------------------------------------------------------------ */
  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    throw new TypeError('ожидались байты (Uint8Array, ArrayBuffer или типизированный массив)');
  }
  const u8 = v => [v & 255];
  const u16 = v => [(v >>> 8) & 255, v & 255];
  const u24 = v => [(v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; // и int32 (дополнительный код)
  const u64 = v => u32(Math.floor(v / 4294967296)).concat(u32(v % 4294967296));
  function fourcc(s) {
    if (typeof s !== 'string' || s.length !== 4) throw new Error(`4CC должен быть из 4 символов: ${s}`);
    return Array.from(s, c => c.charCodeAt(0) & 255);
  }
  // Строки в боксах — UTF-8 (hdlr name, compressorname)
  const utf8 = s => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(s, c => c.charCodeAt(0) & 127));
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function box(type, ...parts) {
    const body = concat(parts);
    const size = 8 + body.length;
    if (size > 0xffffffff) throw new RangeError(`бокс ${type} больше 4 ГБ`);
    return concat([u32(size), fourcc(type), body]);
  }
  const fullBox = (type, version, flags, ...parts) => box(type, [version & 255, ...u24(flags)], ...parts);

  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  function need(cond, msg) { if (!cond) throw new RangeError(msg); }

  function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
  function uuidString(bytes) {
    const h = hex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // 'edef8ba9-79d6-…', 32 hex-символа, имя из SYSTEM_IDS или Uint8Array(16) → 16 байт
  function uuidBytes(id) {
    if (typeof id === 'string') {
      const s = (SYSTEM_IDS[id.toLowerCase()] || id).replace(/-/g, '');
      if (!/^[0-9a-f]{32}$/i.test(s)) throw new Error(`systemId должен быть UUID: ${id}`);
      return Uint8Array.from(s.match(/../g), x => parseInt(x, 16));
    }
    const b = toU8(id);
    if (b.length !== 16) throw new Error('systemId: нужно 16 байт');
    return b;
  }
  const systemName = uuid => Object.keys(SYSTEM_IDS).find(k => SYSTEM_IDS[k] === uuid) || null;

  /* ------------------------------------------------------------------
     Заголовок CMAF: ftyp + moov
     ------------------------------------------------------------------ */
  const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

  function packLanguage(lang) {
    if (!/^[a-z]{3}$/.test(lang)) throw new Error(`language — три строчные буквы ISO 639-2/T, получено «${lang}»`);
    return [...lang].reduce((acc, c) => (acc << 5) | (c.charCodeAt(0) - 0x60), 0);
  }

  function checkEncryption(enc) {
    if (!enc) return null;
    const scheme = enc.scheme || 'cbcs';
    if (scheme !== 'cbcs') throw new Error(`поддерживается только схема 'cbcs', получено '${scheme}'`);
    const kid = toU8(enc.kid);
    const iv = toU8(enc.constantIV);
    need(kid.length === 16, 'encryption.kid: нужно 16 байт');
    need(iv.length === 16, 'encryption.constantIV: нужно 16 байт (AES-CBC)');
    const crypt = enc.cryptByteBlock === undefined ? 1 : enc.cryptByteBlock;
    const skip = enc.skipByteBlock === undefined ? 9 : enc.skipByteBlock;
    need(isInt(crypt, 1, 15) && isInt(skip, 0, 15), 'cryptByteBlock 1–15, skipByteBlock 0–15');
    return { scheme, kid, iv, crypt, skip, pssh: enc.pssh || [] };
  }

  function psshBox(p, kid) {
    const sid = uuidBytes(p.systemId);
    let kids = p.kids ? p.kids.map(toU8) : null;
    // Общий формат W3C ('cenc' initData) — pssh версии 1 со списком KID и без данных
    if (!kids && uuidString(sid) === SYSTEM_IDS.common) kids = [kid];
    const data = p.data ? toU8(p.data) : new Uint8Array(0);
    const version = kids && kids.length ? 1 : 0;
    const kidPart = version ? [u32(kids.length), ...kids] : [];
    return fullBox('pssh', version, 0, sid, ...kidPart, u32(data.length), data);
  }

  function init(opts) {
    const o = opts || {};
    const { width, height, timescale, trackId = 1, language = 'und' } = o;
    need(isInt(width, 1, 65535) && isInt(height, 1, 65535), 'init: width/height — целые 1–65535');
    need(isInt(timescale, 1, 0xffffffff), 'init: timescale — целое > 0');
    need(isInt(trackId, 1, 0xfffffffe), 'init: trackId — целое ≥ 1');
    const avcC = toU8(o.avcC);
    need(avcC.length >= 7 && avcC[0] === 1, 'init: avcC — AVCDecoderConfigurationRecord (configurationVersion 1)');
    const enc = checkEncryption(o.encryption);
    const sar = o.sar || [1, 1];
    need(isInt(sar[0], 1, 0xffffffff) && isInt(sar[1], 1, 0xffffffff), 'init: sar = [hSpacing, vSpacing]');
    const brands = o.brands || INIT_BRANDS;

    const ftyp = box('ftyp', fourcc(brands.major), u32(0), ...brands.compatible.map(fourcc));

    const mvhd = fullBox('mvhd', 0, 0,
      u32(0), u32(0),            // creation_time, modification_time
      u32(1000), u32(0),         // timescale фильма, duration = 0 (CMAF §7.5.1)
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), // rate 1.0, volume 1.0, reserved
      MATRIX, new Array(24).fill(0), // pre_defined
      u32(trackId + 1));         // next_track_ID

    // tkhd: флаги enabled | in_movie | in_preview (как GPAC в режиме CMAF), размер показа с учётом SAR
    const displayWidth = width * sar[0] / sar[1];
    need(displayWidth < 65536, 'init: ширина показа с учётом SAR не помещается в 16.16');
    const tkhd = fullBox('tkhd', 0, 0x000007,
      u32(0), u32(0), u32(trackId), u32(0), u32(0), // creation, modification, track_ID, reserved, duration = 0
      u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), // reserved, layer, alternate_group, volume = 0, reserved
      MATRIX, u32(Math.round(displayWidth * 65536)), u32(height * 65536));

    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(packLanguage(language)), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), u32(0), u32(0), u32(0),
      utf8(o.handlerName || 'VideoHandler'), [0]);

    // Описание сэмпла: avc1 (или encv для зашифрованной дорожки)
    const children = [box('avcC', avcC), box('pasp', u32(sar[0]), u32(sar[1]))];
    if (o.colr) {
      const c = o.colr;   // nclx: как в VUI (Rec. ITU-T H.273); без colr цвет берётся из SPS
      children.push(box('colr', fourcc('nclx'), u16(c.primaries), u16(c.transfer), u16(c.matrix), [c.fullRange ? 0x80 : 0]));
    }
    if (enc) {
      const tenc = fullBox('tenc', 1, 0, [0], [(enc.crypt << 4) | enc.skip], [1], [0], enc.kid, [enc.iv.length], enc.iv);
      children.push(box('sinf',
        box('frma', fourcc('avc1')),
        fullBox('schm', 0, 0, fourcc('cbcs'), u32(0x00010000)),
        box('schi', tenc)));
    }
    const name = new Uint8Array(32);                // compressorname: байт длины + до 31 байта
    const compressor = utf8(String(o.compressorName || '')).subarray(0, 31);
    name[0] = compressor.length;
    name.set(compressor, 1);
    const sampleEntry = box(enc ? 'encv' : 'avc1',
      [0, 0, 0, 0, 0, 0], u16(1),               // reserved, data_reference_index
      u16(0), u16(0), u32(0), u32(0), u32(0),   // pre_defined, reserved, pre_defined[3]
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), u32(0), // 72 dpi, reserved
      u16(1), name, u16(0x0018), u16(0xffff),   // frame_count, compressorname, depth, pre_defined = −1
      ...children);

    // Таблицы сэмплов пусты: все сэмплы — во фрагментах. Пустой stss говорит,
    // что НЕ все сэмплы синхронные (без stss по 14496-12 §8.6.2 синхронны все);
    // GPAC в режиме CMAF делает так же.
    const stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1), sampleEntry),
      fullBox('stts', 0, 0, u32(0)),
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stsz', 0, 0, u32(0), u32(0)),
      fullBox('stco', 0, 0, u32(0)),
      fullBox('stss', 0, 0, u32(0)));
    const minf = box('minf',
      fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
      box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), // данные в этом же файле
      stbl);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    const mvex = box('mvex', fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0)));
    const pssh = enc ? enc.pssh.map(p => psshBox(p, enc.kid)) : [];
    return concat([ftyp, box('moov', mvhd, trak, mvex, ...pssh)]);
  }

  /* ------------------------------------------------------------------
     Медиасегмент: styp + moof + mdat
     samples: [{data, duration, key, cto = 0}] в порядке декодирования.
     ------------------------------------------------------------------ */
  function segment(opts) {
    const o = opts || {};
    const { sequenceNumber, baseMediaDecodeTime, samples, trackId = 1 } = o;
    need(isInt(sequenceNumber, 0, 0xffffffff), 'segment: sequenceNumber — uint32');
    need(isInt(baseMediaDecodeTime, 0, Number.MAX_SAFE_INTEGER), 'segment: baseMediaDecodeTime — целое ≥ 0');
    need(Array.isArray(samples) && samples.length > 0, 'segment: нужен хотя бы один сэмпл');
    need(isInt(trackId, 1, 0xfffffffe), 'segment: trackId — целое ≥ 1');

    // Проверки CMAF: фрагмент начинается с SAP; при trun v1 первый показанный
    // сэмпл начинается ровно в baseMediaDecodeTime (23000-19 §7.5.17)
    let dts = baseMediaDecodeTime, earliest = Infinity, anyCto = false, payload = 0;
    const data = samples.map((s, i) => {
      const d = toU8(s.data);
      need(d.length > 0, `сэмпл ${i}: пустые данные`);
      need(isInt(s.duration, 0, 0xffffffff), `сэмпл ${i}: duration — uint32`);
      const cto = s.cto || 0;
      need(isInt(cto, -0x80000000, 0x7fffffff), `сэмпл ${i}: cto — int32`);
      if (cto) anyCto = true;
      earliest = Math.min(earliest, dts + cto);
      dts += s.duration;
      payload += d.length;
      return d;
    });
    need(!!samples[0].key, 'segment: первый сэмпл должен быть ключевым (фрагмент CMAF начинается с SAP)');
    need(earliest === baseMediaDecodeTime,
      `segment: первый показанный кадр начинается в ${earliest}, а baseMediaDecodeTime = ${baseMediaDecodeTime}; ` +
      'сдвиньте composition offsets (cto) так, чтобы min(dts + cto) = baseMediaDecodeTime (CMAF §7.5.17)');
    need(payload + 8 <= 0xffffffff, 'segment: mdat больше 4 ГБ');

    const enc = o.encryption ? checkSegmentEncryption(o.encryption, data) : null;
    const brands = o.brands || SEGMENT_BRANDS;
    const styp = box('styp', fourcc(brands.major), u32(0), ...brands.compatible.map(fourcc));
    const mfhd = fullBox('mfhd', 0, 0, u32(sequenceNumber));
    const tfhd = fullBox('tfhd', 0, TFHD_FLAGS, u32(trackId), u32(1));
    const tfdt = fullBox('tfdt', 1, 0, u64(baseMediaDecodeTime));

    // trun v1: у каждого сэмпла длительность, размер, флаги (+ знаковый cto, если нужен)
    const trunFlags = TRUN.dataOffset | TRUN.duration | TRUN.size | TRUN.flags | (anyCto ? TRUN.cto : 0);
    const trunSize = 12 + 4 + 4 + samples.length * (anyCto ? 16 : 12);

    // Шифрование: saiz, saio, senc (saio указывает на данные первого сэмпла в senc)
    let saiz = null, sencBody = null, saioSize = 0;
    if (enc) {
      const sizes = enc.subsamples.map(list => 2 + 6 * list.length);   // IV нет (константный), только подвыборки
      sizes.forEach((n, i) => need(n <= 255, `сэмпл ${i}: ${enc.subsamples[i].length} подвыборок не помещаются в saiz (uint8)`));
      const same = sizes.every(n => n === sizes[0]);
      saiz = fullBox('saiz', 0, 0, [same ? sizes[0] : 0], u32(sizes.length), same ? [] : sizes);
      saioSize = 12 + 4 + 4;
      const parts = [u32(enc.subsamples.length)];
      for (const list of enc.subsamples) {
        parts.push(u16(list.length));
        for (const s of list) parts.push(u16(s.clear), u32(s.protected));
      }
      sencBody = parts;
    }
    const sencSize = enc ? 12 + sencBody.reduce((a, p) => a + p.length, 0) : 0;
    const trafSize = 8 + tfhd.length + tfdt.length + trunSize + (enc ? saiz.length + saioSize + sencSize : 0);
    const moofSize = 8 + mfhd.length + trafSize;
    const dataOffset = moofSize + 8;               // от начала moof до первого байта в mdat

    const trun = [u8(1), u24(trunFlags), u32(samples.length), u32(dataOffset)];
    samples.forEach((s, i) => {
      trun.push(u32(s.duration), u32(data[i].length), u32(s.key ? SAMPLE_FLAGS.sync : SAMPLE_FLAGS.nonSync));
      if (anyCto) trun.push(u32(s.cto || 0));
    });
    const trafParts = [tfhd, tfdt, box('trun', ...trun)];
    if (enc) {
      // смещение от начала moof: заголовки moof и traf, mfhd, …, saio, затем заголовок senc (8 + 4 + 4)
      const sencAux = 8 + mfhd.length + 8 + tfhd.length + tfdt.length + trunSize + saiz.length + saioSize + 16;
      trafParts.push(saiz, fullBox('saio', 0, 0, u32(1), u32(sencAux)), fullBox('senc', 0, 0x000002, ...sencBody));
    }
    const moof = box('moof', mfhd, box('traf', ...trafParts));
    if (moof.length !== moofSize) throw new Error(`внутренняя ошибка: moof ${moof.length} ≠ ${moofSize}`);

    // Итог: один буфер без лишних копий сэмплов
    const out = new Uint8Array(styp.length + moof.length + 8 + payload);
    let p = 0;
    out.set(styp, p); p += styp.length;
    out.set(moof, p); p += moof.length;
    out.set(u32(8 + payload), p); out.set(fourcc('mdat'), p + 4); p += 8;
    for (const d of data) { out.set(d, p); p += d.length; }
    return out;
  }

  function checkSegmentEncryption(enc, data) {
    const subs = enc.subsamples;
    need(Array.isArray(subs) && subs.length === data.length, 'encryption.subsamples: по списку подвыборок на каждый сэмпл');
    subs.forEach((list, i) => {
      need(Array.isArray(list) && list.length > 0 && list.length <= 0xffff, `сэмпл ${i}: нужен непустой список подвыборок`);
      let sum = 0;
      for (const s of list) {
        need(isInt(s.clear, 0, 0xffff), `сэмпл ${i}: BytesOfClearData — uint16 (0–65535)`);
        need(isInt(s.protected, 0, 0xffffffff), `сэмпл ${i}: BytesOfProtectedData — uint32`);
        sum += s.clear + s.protected;
      }
      need(sum === data[i].length, `сэмпл ${i}: подвыборки покрывают ${sum} байт, а в сэмпле ${data[i].length}`);
    });
    return { subsamples: subs };
  }

  /* ------------------------------------------------------------------
     cbcs: AES-128-CBC по шаблону crypt:skip (ISO/IEC 23001-7 §10.4).
     В каждой подвыборке шифруется защищённый диапазон: 1 блок 16 байт
     шифруем, 9 пропускаем, шаблон и цепочка CBC начинаются заново с
     константным IV в каждой подвыборке; хвост < 16 байт остаётся открытым.
     WebCrypto AES-CBC всегда добавляет PKCS#7: шифруем собранные подряд
     блоки и отбрасываем лишний последний блок; при расшифровке дописываем
     блок, который расшифруется в корректное заполнение.
     ------------------------------------------------------------------ */
  const KINDS = ['clear', 'len', 'nalhdr', 'slicehdr', 'nonvcl', 'enc', 'skip', 'tail'];
  const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
  const keyCache = new Map();

  function subtleCrypto() {
    const c = root.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) недоступен: нужен безопасный контекст или node ≥ 19');
    return c.subtle;
  }

  function importKey(key) {
    if (key && typeof key === 'object' && key.type === 'secret' && key.algorithm) return Promise.resolve(key); // CryptoKey
    const raw = toU8(key);
    if (raw.length !== 16) return Promise.reject(new RangeError('ключ AES-128: нужно 16 байт'));
    const id = hex(raw);
    if (!keyCache.has(id)) {
      if (keyCache.size > 16) keyCache.clear();
      const pending = subtleCrypto().importKey('raw', raw.slice(), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
      pending.catch(() => keyCache.delete(id));      // неудачный импорт не запоминаем
      keyCache.set(id, pending);
    }
    return keyCache.get(id);
  }

  async function cryptBlocks(buf, offsets, key, iv, decrypt) {
    const subtle = subtleCrypto();
    const n = offsets.length * 16;
    const gathered = new Uint8Array(n);
    offsets.forEach((o, i) => gathered.set(buf.subarray(o, o + 16), i * 16));
    let result;
    if (!decrypt) {
      result = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, gathered)).subarray(0, n);
    } else {
      // Блок X = E(0x10… ⊕ C_last) расшифруется в полный блок заполнения PKCS#7
      const last = gathered.slice(n - 16);
      const pad = new Uint8Array(16).fill(16);
      const x = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: last }, key, pad)).subarray(0, 16);
      const padded = new Uint8Array(n + 16);
      padded.set(gathered);
      padded.set(x, n);
      result = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, padded));
    }
    offsets.forEach((o, i) => buf.set(result.subarray(i * 16, i * 16 + 16), o));
  }

  // Разметка байтов сэмпла для рисования: структура NAL (если сэмпл читается
  // как NAL-блоки с длиной lengthSize), поверх — шаблон шифрования
  function structureKinds(sample, lengthSize) {
    const kinds = new Uint8Array(sample.length);      // 0 = 'clear'
    if (!lengthSize) return kinds;
    const marks = [];
    let off = 0;
    while (off < sample.length) {
      if (off + lengthSize > sample.length) return kinds;
      let size = 0;
      for (let k = 0; k < lengthSize; k++) size = size * 256 + sample[off + k];
      const start = off + lengthSize;
      if (size === 0 || start + size > sample.length) return kinds;  // не NAL-блоки — без структуры
      marks.push([off, start, start + size, sample[start] & 31]);
      off = start + size;
    }
    for (const [o, s, e, type] of marks) {
      kinds.fill(K.len, o, s);
      kinds[s] = K.nalhdr;
      kinds.fill(type === 1 || type === 5 ? K.slicehdr : K.nonvcl, s + 1, e);
    }
    return kinds;
  }

  function toRegions(kinds) {
    const regions = [];
    for (let i = 0; i < kinds.length; i++) {
      const last = regions[regions.length - 1];
      if (last && last.kind === KINDS[kinds[i]]) last.end = i + 1;
      else regions.push({ start: i, end: i + 1, kind: KINDS[kinds[i]] });
    }
    return regions;
  }

  async function cbcs(sample, subsamples, key, iv, opts, decrypt) {
    const input = toU8(sample);
    const o = opts || {};
    const crypt = o.cryptByteBlock === undefined ? 1 : o.cryptByteBlock;
    const skip = o.skipByteBlock === undefined ? 9 : o.skipByteBlock;
    const lengthSize = o.lengthSize === undefined ? 4 : o.lengthSize;
    need(isInt(crypt, 1, 15) && isInt(skip, 0, 15), 'cryptByteBlock 1–15, skipByteBlock 0–15');
    const ivBytes = toU8(iv);
    need(ivBytes.length === 16, 'IV: нужно 16 байт');
    const cryptoKey = await importKey(key);

    const out = input.slice();
    const kinds = structureKinds(input, lengthSize);
    const jobs = [];
    let pos = 0;
    for (const s of subsamples) {
      need(isInt(s.clear, 0, 0xffff) && isInt(s.protected, 0, 0xffffffff), 'подвыборка: clear — uint16, protected — uint32');
      pos += s.clear;
      const end = pos + s.protected;
      need(end <= input.length, `подвыборки выходят за конец сэмпла (${input.length} байт)`);
      const blocks = [];
      let p = pos;
      while (end - p >= 16 * crypt) {             // шаблон заново с начала каждого защищённого диапазона
        for (let b = 0; b < crypt; b++) blocks.push(p + 16 * b);
        kinds.fill(K.enc, p, p + 16 * crypt);
        p += 16 * crypt;
        const s2 = Math.min(16 * skip, end - p);
        kinds.fill(K.skip, p, p + s2);
        p += s2;
      }
      kinds.fill(K.tail, p, end);                  // неполный хвост — открыт
      if (blocks.length) jobs.push(cryptBlocks(out, blocks, cryptoKey, ivBytes, decrypt)); // цепочка CBC — своя у подвыборки
      pos = end;
    }
    need(pos === input.length, `подвыборки покрывают ${pos} байт, а в сэмпле ${input.length}`);
    await Promise.all(jobs);
    return { bytes: out, regions: toRegions(kinds) };
  }

  const encryptCbcs = (sample, subsamples, key, iv, opts) => cbcs(sample, subsamples, key, iv, opts, false);
  const decryptCbcs = (sample, subsamples, key, iv, opts) => cbcs(sample, subsamples, key, iv, opts, true);

  /* ------------------------------------------------------------------
     Разбор: дерево боксов [{type, start, size, headerSize, end, children?, fields?}]
     ------------------------------------------------------------------ */
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'mvex', 'moof', 'traf',
    'sinf', 'schi', 'edts', 'udta', 'mfra', 'tref', 'rinf']);
  const VISUAL_ENTRIES = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'encv', 'hvc1', 'hev1', 'av01', 'vp09']);

  function parse(input, opts) {
    const bytes = toU8(input);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ctx = { ivSize: opts && opts.ivSize !== undefined ? opts.ivSize : null };
    return parseBoxes(bytes, dv, 0, bytes.length, ctx);
  }

  function parseBoxes(bytes, dv, start, end, ctx) {
    const list = [];
    let p = start;
    while (p < end) {
      if (end - p < 8) { list.push({ type: '(хвост)', start: p, size: end - p, headerSize: 0, end, error: 'обрывок меньше заголовка бокса' }); break; }
      let size = dv.getUint32(p);
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      let headerSize = 8;
      if (size === 1) {
        if (end - p < 16) { list.push({ type, start: p, size: end - p, headerSize: 8, end, error: 'нет largesize' }); break; }
        size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
        headerSize = 16;
      } else if (size === 0) {
        size = end - p;                               // до конца файла/родителя
      }
      if (type === 'uuid') headerSize += 16;
      const node = { type, start: p, size, headerSize, end: p + size };
      if (size < headerSize || p + size > end) {
        node.error = `размер ${size} выходит за границы (${end - p} байт осталось)`;
        node.size = end - p;
        node.end = end;
        list.push(node);
        break;
      }
      try {
        // Виды, обрезанные по концу бокса: чтение за его границу бросит ошибку
        const end2 = p + size;
        decodeBox(node, bytes.subarray(0, end2), new DataView(bytes.buffer, bytes.byteOffset, end2), ctx);
      } catch (e) {
        node.error = e.message;
      }
      list.push(node);
      p += size;
    }
    return list;
  }

  function str4(bytes, p) { return String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]); }
  function u64At(dv, p) { return dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4); }
  // Строка до нулевого байта (UTF-8, как в hdlr)
  function cstring(bytes, p, end) {
    let i = p;
    while (i < end && bytes[i]) i++;
    const raw = bytes.subarray(p, i);
    return typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(raw) : String.fromCharCode(...raw);
  }

  // Минимальная длина полезной нагрузки (версия 0), чтобы не читать чужие байты
  const MIN_PAYLOAD = {
    ftyp: 8, styp: 8, mvhd: 100, tkhd: 84, mdhd: 24, hdlr: 24, vmhd: 12, dref: 8, 'url ': 4, stsd: 8,
    stts: 8, stsc: 8, stco: 8, co64: 8, stss: 8, ctts: 8, stsz: 12, avcC: 6, pasp: 8, colr: 4, btrt: 12,
    frma: 4, schm: 12, tenc: 24, pssh: 24, mehd: 8, trex: 24, mfhd: 8, tfhd: 8, tfdt: 8, trun: 8,
    senc: 8, saiz: 9, saio: 8,
  };

  function decodeBox(node, bytes, dv, ctx) {
    const t = node.type;
    const b = node.start + node.headerSize;           // начало полезной нагрузки
    const e = node.end;
    const full = () => ({ version: bytes[b], flags: (bytes[b + 1] << 16) | (bytes[b + 2] << 8) | bytes[b + 3] });
    const min = VISUAL_ENTRIES.has(t) ? 78 : MIN_PAYLOAD[t] || 0;
    if (e - b < min) throw new RangeError(`${t}: полезная нагрузка ${e - b} байт, нужно не меньше ${min}`);

    if (CONTAINERS.has(t)) { node.children = parseBoxes(bytes, dv, b, e, ctx); return; }

    switch (t) {
      case 'ftyp':
      case 'styp': {
        const compatibleBrands = [];
        for (let p = b + 8; p + 4 <= e; p += 4) compatibleBrands.push(str4(bytes, p));
        node.fields = { majorBrand: str4(bytes, b), minorVersion: dv.getUint32(b + 4), compatibleBrands };
        return;
      }
      case 'mvhd': {
        const f = full();
        const v1 = f.version === 1;
        const ts = b + (v1 ? 20 : 12);
        node.fields = {
          version: f.version,
          timescale: dv.getUint32(ts),
          duration: v1 ? u64At(dv, ts + 4) : dv.getUint32(ts + 4),
          nextTrackId: dv.getUint32(e - 4),
        };
        return;
      }
      case 'tkhd': {
        const f = full();
        const v1 = f.version === 1;
        const id = b + (v1 ? 20 : 12);
        node.fields = {
          version: f.version, flags: f.flags,
          trackId: dv.getUint32(id),
          duration: v1 ? u64At(dv, id + 8) : dv.getUint32(id + 8),
          width: dv.getUint32(e - 8) / 65536,
          height: dv.getUint32(e - 4) / 65536,
        };
        return;
      }
      case 'mdhd': {
        const f = full();
        const v1 = f.version === 1;
        const ts = b + (v1 ? 20 : 12);
        const lang = dv.getUint16(ts + (v1 ? 12 : 8));
        node.fields = {
          version: f.version,
          timescale: dv.getUint32(ts),
          duration: v1 ? u64At(dv, ts + 4) : dv.getUint32(ts + 4),
          language: String.fromCharCode(((lang >> 10) & 31) + 0x60, ((lang >> 5) & 31) + 0x60, (lang & 31) + 0x60),
        };
        return;
      }
      case 'hdlr':
        node.fields = { handlerType: str4(bytes, b + 8), name: cstring(bytes, b + 24, e) };
        return;
      case 'vmhd':
        node.fields = { flags: full().flags, graphicsMode: dv.getUint16(b + 4) };
        return;
      case 'dref':
        node.fields = { entryCount: dv.getUint32(b + 4) };
        node.children = parseBoxes(bytes, dv, b + 8, e, ctx);
        return;
      case 'url ':
        node.fields = { flags: full().flags, selfContained: (full().flags & 1) === 1 };
        return;
      case 'stsd':
        node.fields = { entryCount: dv.getUint32(b + 4) };
        node.children = parseBoxes(bytes, dv, b + 8, e, ctx);
        return;
      case 'stts': case 'stsc': case 'stco': case 'co64': case 'stss': case 'ctts':
        node.fields = { entryCount: dv.getUint32(b + 4) };
        return;
      case 'stsz':
        node.fields = { sampleSize: dv.getUint32(b + 4), sampleCount: dv.getUint32(b + 8) };
        return;
      case 'avcC': {
        const lengthSize = (bytes[b + 4] & 3) + 1;
        const h = v => v.toString(16).padStart(2, '0');
        node.fields = {
          version: bytes[b], profile: bytes[b + 1], compat: bytes[b + 2], level: bytes[b + 3], lengthSize,
          spsCount: bytes[b + 5] & 31,
          codec: 'avc1.' + h(bytes[b + 1]) + h(bytes[b + 2]) + h(bytes[b + 3]),
        };
        return;
      }
      case 'pasp':
        node.fields = { hSpacing: dv.getUint32(b), vSpacing: dv.getUint32(b + 4) };
        return;
      case 'colr': {
        const colourType = str4(bytes, b);
        node.fields = { colourType };
        if (colourType === 'nclx') {
          Object.assign(node.fields, {
            primaries: dv.getUint16(b + 4), transfer: dv.getUint16(b + 6), matrix: dv.getUint16(b + 8),
            fullRange: (bytes[b + 10] & 0x80) !== 0,
          });
        }
        return;
      }
      case 'btrt':
        node.fields = { bufferSizeDB: dv.getUint32(b), maxBitrate: dv.getUint32(b + 4), avgBitrate: dv.getUint32(b + 8) };
        return;
      case 'frma':
        node.fields = { dataFormat: str4(bytes, b) };
        return;
      case 'schm':
        node.fields = { schemeType: str4(bytes, b + 4), schemeVersion: dv.getUint32(b + 8) };
        return;
      case 'tenc': {
        const f = full();
        const pattern = bytes[b + 5];
        const isProtected = bytes[b + 6];
        const perSampleIvSize = bytes[b + 7];
        node.fields = {
          version: f.version,
          cryptByteBlock: f.version ? pattern >> 4 : 0,
          skipByteBlock: f.version ? pattern & 15 : 0,
          isProtected, perSampleIvSize,
          kid: hex(bytes.subarray(b + 8, b + 24)),
        };
        if (isProtected === 1 && perSampleIvSize === 0) {
          const n = bytes[b + 24];
          node.fields.constantIvSize = n;
          node.fields.constantIv = hex(bytes.subarray(b + 25, b + 25 + n));
        }
        ctx.ivSize = ctx.ivSize === null ? perSampleIvSize : ctx.ivSize;   // для senc в этом же файле
        return;
      }
      case 'pssh': {
        const f = full();
        const systemId = uuidString(bytes.subarray(b + 4, b + 20));
        let p = b + 20;
        const kids = [];
        if (f.version > 0) {
          const n = dv.getUint32(p);
          p += 4;
          for (let i = 0; i < n; i++, p += 16) kids.push(hex(bytes.subarray(p, p + 16)));
        }
        const dataSize = dv.getUint32(p);
        node.fields = { version: f.version, systemId, systemName: systemName(systemId), kids, dataSize, dataStart: p + 4 };
        return;
      }
      case 'mehd': {
        const f = full();
        node.fields = { fragmentDuration: f.version === 1 ? u64At(dv, b + 4) : dv.getUint32(b + 4) };
        return;
      }
      case 'trex':
        node.fields = {
          trackId: dv.getUint32(b + 4), defaultSampleDescriptionIndex: dv.getUint32(b + 8),
          defaultSampleDuration: dv.getUint32(b + 12), defaultSampleSize: dv.getUint32(b + 16),
          defaultSampleFlags: dv.getUint32(b + 20),
        };
        return;
      case 'mfhd':
        node.fields = { sequenceNumber: dv.getUint32(b + 4) };
        return;
      case 'tfhd': {
        const { flags } = full();
        let p = b + 8;
        const f = {
          flags, trackId: dv.getUint32(b + 4),
          durationIsEmpty: (flags & 0x010000) !== 0,
          defaultBaseIsMoof: (flags & 0x020000) !== 0,
        };
        if (flags & 0x01) { f.baseDataOffset = u64At(dv, p); p += 8; }
        if (flags & 0x02) { f.sampleDescriptionIndex = dv.getUint32(p); p += 4; }
        if (flags & 0x08) { f.defaultSampleDuration = dv.getUint32(p); p += 4; }
        if (flags & 0x10) { f.defaultSampleSize = dv.getUint32(p); p += 4; }
        if (flags & 0x20) { f.defaultSampleFlags = dv.getUint32(p); p += 4; }
        node.fields = f;
        return;
      }
      case 'tfdt': {
        const f = full();
        node.fields = { version: f.version, baseMediaDecodeTime: f.version === 1 ? u64At(dv, b + 4) : dv.getUint32(b + 4) };
        return;
      }
      case 'trun': {
        const { version, flags } = full();
        const n = dv.getUint32(b + 4);
        let p = b + 8;
        const f = { version, flags, sampleCount: n };
        if (flags & TRUN.dataOffset) { f.dataOffset = dv.getInt32(p); p += 4; }
        if (flags & TRUN.firstSampleFlags) { f.firstSampleFlags = dv.getUint32(p); p += 4; }
        if (flags & TRUN.duration) f.durations = [];
        if (flags & TRUN.size) f.sizes = [];
        if (flags & TRUN.flags) f.sampleFlags = [];
        if (flags & TRUN.cto) f.ctos = [];
        for (let i = 0; i < n; i++) {
          if (flags & TRUN.duration) { f.durations.push(dv.getUint32(p)); p += 4; }
          if (flags & TRUN.size) { f.sizes.push(dv.getUint32(p)); p += 4; }
          if (flags & TRUN.flags) { f.sampleFlags.push(dv.getUint32(p)); p += 4; }
          if (flags & TRUN.cto) { f.ctos.push(version === 0 ? dv.getUint32(p) : dv.getInt32(p)); p += 4; }
        }
        node.fields = f;
        return;
      }
      case 'senc':
        node.fields = decodeSenc(bytes, dv, b, e, ctx);
        return;
      case 'saiz': {
        const { flags } = full();
        let p = b + 4;
        const f = { flags };
        if (flags & 1) { f.auxInfoType = str4(bytes, p); f.auxInfoTypeParameter = dv.getUint32(p + 4); p += 8; }
        f.defaultSampleInfoSize = bytes[p];
        f.sampleCount = dv.getUint32(p + 1);
        p += 5;
        if (f.defaultSampleInfoSize === 0) f.sampleInfoSizes = Array.from(bytes.subarray(p, p + f.sampleCount));
        node.fields = f;
        return;
      }
      case 'saio': {
        const { version, flags } = full();
        let p = b + 4;
        const f = { version, flags };
        if (flags & 1) { f.auxInfoType = str4(bytes, p); f.auxInfoTypeParameter = dv.getUint32(p + 4); p += 8; }
        f.entryCount = dv.getUint32(p);
        p += 4;
        f.offsets = [];
        for (let i = 0; i < f.entryCount; i++) {
          f.offsets.push(version === 0 ? dv.getUint32(p) : u64At(dv, p));
          p += version === 0 ? 4 : 8;
        }
        node.fields = f;
        return;
      }
      case 'mdat':
        node.fields = { payloadStart: b, payloadSize: e - b };
        return;
      default:
        if (VISUAL_ENTRIES.has(t)) {
          const nameLen = Math.min(bytes[b + 42], 31);
          node.fields = {
            dataReferenceIndex: dv.getUint16(b + 6),
            width: dv.getUint16(b + 24), height: dv.getUint16(b + 26),
            compressorName: cstring(bytes, b + 43, b + 43 + nameLen),
            depth: dv.getUint16(b + 74),
          };
          node.children = parseBoxes(bytes, dv, b + 78, e, ctx);
        }
      // неизвестные боксы остаются непрозрачными
    }
  }

  // senc: размер IV берём из tenc (если был в этом же буфере) или из opts.ivSize;
  // иначе подбираем 0/8/16 — тот, что ровно заполняет бокс
  function decodeSenc(bytes, dv, b, e, ctx) {
    const flags = (bytes[b + 1] << 16) | (bytes[b + 2] << 8) | bytes[b + 3];
    const n = dv.getUint32(b + 4);
    const tryRead = ivSize => {
      let p = b + 8;
      const samples = [];
      for (let i = 0; i < n; i++) {
        const s = {};
        if (ivSize) { if (p + ivSize > e) return null; s.iv = hex(bytes.subarray(p, p + ivSize)); p += ivSize; }
        if (flags & 2) {
          if (p + 2 > e) return null;
          const count = dv.getUint16(p);
          p += 2;
          if (p + 6 * count > e) return null;
          s.subsamples = [];
          for (let k = 0; k < count; k++, p += 6) s.subsamples.push({ clear: dv.getUint16(p), protected: dv.getUint32(p + 2) });
        }
        samples.push(s);
      }
      return p === e ? samples : null;
    };
    const candidates = ctx.ivSize !== null ? [ctx.ivSize] : [0, 8, 16];
    for (const iv of candidates) {
      const samples = tryRead(iv);
      if (samples) return { flags, sampleCount: n, ivSize: iv, samples };
    }
    throw new Error('senc: не удалось разобрать подвыборки');
  }

  /* ------------------------------------------------------------------
     Навигация по дереву: find(tree, 'moof/traf/trun'), walk(tree, fn)
     ------------------------------------------------------------------ */
  function findAll(nodes, path) {
    const [head, ...rest] = path.split('/');
    const hits = (nodes || []).filter(n => n.type === head);
    if (!rest.length) return hits;
    return hits.flatMap(n => findAll(n.children, rest.join('/')));
  }
  const find = (nodes, path) => findAll(nodes, path)[0] || null;
  function walk(nodes, fn, depth = 0, parent = null) {
    for (const n of nodes || []) {
      fn(n, depth, parent);
      walk(n.children, fn, depth + 1, n);
    }
  }

  FJ.mp4 = {
    INIT_BRANDS, SEGMENT_BRANDS, SYSTEM_IDS, SAMPLE_FLAGS, KINDS,
    init, segment, parse, find, findAll, walk,
    encryptCbcs, decryptCbcs,
  };
  if (typeof module !== 'undefined') module.exports = FJ.mp4;
})(typeof window !== 'undefined' ? window : globalThis);

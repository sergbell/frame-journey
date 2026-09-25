// Тесты CMAF-мультиплексора, разбора боксов и шифрования cbcs.
// Главная проверка — внешняя: ffprobe/ffmpeg читают и декодируют наш init + сегменты
// (кадры совпадают по framemd5 с декодом исходного потока), а ffmpeg -decryption_key
// расшифровывает наш cbcs и получает те же кадры. Запуск: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const mp4 = require('../js/22-mp4.js');
const h264 = require('../js/23-h264.js');
const H = require('./fixtures/helpers.js');

const TIMESCALE = 24000, DURATION = 1000;           // 24 fps
const KEY = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 255);
const KID = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const IV = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 7) & 255);
const hex = b => Buffer.from(b).toString('hex');
const SKIP_NO_FFMPEG = H.HAS_FFMPEG ? false : 'ffmpeg/ffprobe не найдены';

// Поток → {avcC, samples с длительностями и cto из POC}
function prepared(name, opts) {
  const s = H.loadStream(name, opts);
  return { ...s, timed: H.timing(s.samples, s.avcC, DURATION) };
}
const initFor = (s, extra = {}) => {
  const sps = h264.parseSPS(s.sps[0]);
  return mp4.init({ width: sps.width, height: sps.height, timescale: TIMESCALE, avcC: s.avcC, ...extra });
};

// Каждый контейнер ровно заполнен детьми (с учётом префикса stsd/dref/sample entry)
const PREFIX = { stsd: 8, dref: 8, avc1: 78, encv: 78 };
function assertSizes(nodes, parentEnd, label) {
  for (const n of nodes) {
    assert.ok(!n.error, `${label}/${n.type}: ${n.error}`);
    if (n.children) {
      let p = n.start + n.headerSize + (PREFIX[n.type] || 0);
      for (const c of n.children) { assert.equal(c.start, p, `${label}/${n.type}/${c.type}: начало`); p = c.end; }
      assert.equal(p, n.end, `${label}/${n.type}: дети заполняют бокс`);
      assertSizes(n.children, n.end, label + '/' + n.type);
    }
  }
  if (nodes.length) assert.equal(nodes[nodes.length - 1].end, parentEnd, label + ': последний бокс до конца');
}
const types = nodes => nodes.map(n => n.type);

/* ------------------------------------------------------------------ */

test('SYSTEM_IDS: значения из реестра DASH-IF', () => {
  assert.deepEqual(mp4.SYSTEM_IDS, {
    widevine: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
    playready: '9a04f079-9840-4286-ab92-e65be0885f95',
    fairplay: '94ce86fb-07ff-4f43-adb8-93d2fa968ca2',
    common: '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b',
    clearkey: 'e2719d58-a985-b3c9-781a-b030af78d30e',
  });
});

test('init из h264.videoInfo(avcC): размеры, SAR и цвет из SPS', () => {
  const s = H.loadStream('high.h264');
  const info = h264.videoInfo(s.avcC);
  assert.deepEqual([info.width, info.height, info.sar, info.colr, info.fps, info.lengthSize, info.profile], [640, 360, [1, 1], null, 24, 4, 'High']);
  const tree = mp4.parse(mp4.init({ ...info, timescale: TIMESCALE, avcC: s.avcC }));
  const avc1 = mp4.find(tree, 'moov/trak/mdia/minf/stbl/stsd/avc1');
  assert.deepEqual([avc1.fields.width, avc1.fields.height], [640, 360]);
  assert.deepEqual(types(avc1.children), ['avcC', 'pasp']);        // без описания цвета в VUI colr не пишем
  // Поток с описанием цвета в VUI → colr nclx с теми же значениями
  const r = H.prng(5);
  let sps;
  do { sps = H.synthSPS(r, 0); } while (!h264.parseSPS(sps.nal).vui || !h264.parseSPS(sps.nal).vui.colour_description_present_flag);
  const pps = H.synthPPS(r, 0, sps.cfg);
  const avcC = H.buildAvcC([sps.nal], [pps.nal]);
  const vi = h264.videoInfo(avcC);
  const parsed = h264.parseSPS(sps.nal);
  assert.deepEqual(vi.colr, { primaries: parsed.vui.colour_primaries, transfer: parsed.vui.transfer_characteristics,
    matrix: parsed.vui.matrix_coefficients, fullRange: !!parsed.vui.video_full_range_flag });
  const colr = mp4.find(mp4.parse(mp4.init({ ...vi, timescale: TIMESCALE, avcC })), 'moov/trak/mdia/minf/stbl/stsd/avc1/colr');
  assert.deepEqual(colr.fields, { colourType: 'nclx', ...vi.colr });
});

test('init: ftyp + moov, порядок и поля боксов, размеры сходятся', () => {
  const s = H.loadStream('high.h264');
  const bytes = initFor(s);
  const tree = mp4.parse(bytes);
  assertSizes(tree, bytes.length, 'init');
  assert.deepEqual(types(tree), ['ftyp', 'moov']);
  assert.deepEqual(tree[0].fields, { majorBrand: 'cmfc', minorVersion: 0, compatibleBrands: ['cmfc', 'cmf2', 'iso6'] });
  const moov = tree[1];
  assert.deepEqual(types(moov.children), ['mvhd', 'trak', 'mvex']);
  assert.deepEqual(mp4.find(tree, 'moov/mvhd').fields, { version: 0, timescale: 1000, duration: 0, nextTrackId: 2 });
  assert.deepEqual(mp4.find(tree, 'moov/trak/tkhd').fields, { version: 0, flags: 7, trackId: 1, duration: 0, width: 640, height: 360 });
  assert.deepEqual(types(mp4.find(tree, 'moov/trak/mdia').children), ['mdhd', 'hdlr', 'minf']);
  assert.deepEqual(mp4.find(tree, 'moov/trak/mdia/mdhd').fields, { version: 0, timescale: TIMESCALE, duration: 0, language: 'und' });
  assert.deepEqual(mp4.find(tree, 'moov/trak/mdia/hdlr').fields, { handlerType: 'vide', name: 'VideoHandler' });
  assert.deepEqual(types(mp4.find(tree, 'moov/trak/mdia/minf').children), ['vmhd', 'dinf', 'stbl']);
  assert.deepEqual(mp4.find(tree, 'moov/trak/mdia/minf/dinf/dref/url ').fields, { flags: 1, selfContained: true });
  const stbl = mp4.find(tree, 'moov/trak/mdia/minf/stbl');
  assert.deepEqual(types(stbl.children), ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'stss']);
  for (const t of ['stts', 'stsc', 'stco', 'stss']) assert.equal(mp4.find(stbl.children, t).fields.entryCount, 0);
  const avc1 = mp4.find(stbl.children, 'stsd/avc1');
  assert.equal(avc1.fields.width, 640);
  assert.equal(avc1.fields.height, 360);
  assert.equal(avc1.fields.depth, 0x18);
  assert.deepEqual(types(avc1.children), ['avcC', 'pasp']);
  const avcC = avc1.children[0];
  assert.deepEqual(bytes.subarray(avcC.start + 8, avcC.end), s.avcC, 'avcC скопирован как есть');
  assert.equal(avcC.fields.codec, h264.parseAvcC(s.avcC).codec);
  assert.deepEqual(avc1.children[1].fields, { hSpacing: 1, vSpacing: 1 });
  assert.deepEqual(mp4.find(tree, 'moov/mvex/trex').fields, {
    trackId: 1, defaultSampleDescriptionIndex: 1, defaultSampleDuration: 0, defaultSampleSize: 0, defaultSampleFlags: 0,
  });
  // colr и SAR по запросу; язык; неверные параметры
  const t2 = mp4.parse(initFor(s, { sar: [4, 3], colr: { primaries: 1, transfer: 1, matrix: 1, fullRange: false }, language: 'rus', trackId: 3 }));
  assert.deepEqual(mp4.find(t2, 'moov/trak/mdia/minf/stbl/stsd/avc1/colr').fields, { colourType: 'nclx', primaries: 1, transfer: 1, matrix: 1, fullRange: false });
  assert.ok(Math.abs(mp4.find(t2, 'moov/trak/tkhd').fields.width - 640 * 4 / 3) <= 1 / 65536, 'ширина показа 16.16');
  assert.equal(mp4.find(t2, 'moov/trak/mdia/mdhd').fields.language, 'rus');
  assert.equal(mp4.find(t2, 'moov/mvex/trex').fields.trackId, 3);
  assert.throws(() => mp4.init({ width: 640, height: 360, timescale: 0, avcC: s.avcC }), /timescale/);
  assert.throws(() => mp4.init({ width: 640, height: 360, timescale: 1, avcC: new Uint8Array(3) }), /avcC/);
  assert.throws(() => initFor(s, { language: 'Russian' }), /language/);
});

test('init с encryption: encv + sinf(frma, schm cbcs, schi/tenc v1) и pssh', () => {
  const s = H.loadStream('high.h264');
  const wvData = Uint8Array.from([0x12, 0x10, ...KID]);
  const bytes = initFor(s, {
    encryption: {
      scheme: 'cbcs', kid: KID, constantIV: IV, cryptByteBlock: 1, skipByteBlock: 9,
      pssh: [{ systemId: mp4.SYSTEM_IDS.widevine, data: wvData }, { systemId: 'common' }, { systemId: 'playready', data: new Uint8Array(40) }],
    },
  });
  const tree = mp4.parse(bytes);
  assertSizes(tree, bytes.length, 'init-enc');
  assert.deepEqual(types(tree[1].children), ['mvhd', 'trak', 'mvex', 'pssh', 'pssh', 'pssh']);
  const encv = mp4.find(tree, 'moov/trak/mdia/minf/stbl/stsd/encv');
  assert.ok(encv, 'encv вместо avc1');
  assert.deepEqual(types(encv.children), ['avcC', 'pasp', 'sinf']);
  const sinf = encv.children[2];
  assert.deepEqual(types(sinf.children), ['frma', 'schm', 'schi']);
  assert.deepEqual(sinf.children[0].fields, { dataFormat: 'avc1' });
  assert.deepEqual(sinf.children[1].fields, { schemeType: 'cbcs', schemeVersion: 0x00010000 });
  assert.deepEqual(mp4.find(sinf.children, 'schi/tenc').fields, {
    version: 1, cryptByteBlock: 1, skipByteBlock: 9, isProtected: 1, perSampleIvSize: 0,
    kid: hex(KID), constantIvSize: 16, constantIv: hex(IV),
  });
  const [wv, common, pr] = mp4.findAll(tree, 'moov/pssh').map(n => n.fields);
  assert.deepEqual([wv.version, wv.systemName, wv.dataSize, wv.kids], [0, 'widevine', wvData.length, []]);
  assert.deepEqual(bytes.subarray(wv.dataStart, wv.dataStart + wv.dataSize), wvData);
  assert.deepEqual([common.version, common.systemId, common.kids, common.dataSize], [1, mp4.SYSTEM_IDS.common, [hex(KID)], 0]);
  assert.deepEqual([pr.systemName, pr.dataSize], ['playready', 40]);
  assert.throws(() => initFor(s, { encryption: { scheme: 'cenc', kid: KID, constantIV: IV } }), /cbcs/);
  assert.throws(() => initFor(s, { encryption: { kid: KID.subarray(0, 8), constantIV: IV } }), /kid/);
});

test('segment: styp, mfhd, tfhd (default-base-is-moof), tfdt v1, trun v1; data_offset указывает на mdat', () => {
  for (const name of ['high.h264', 'bframes.h264']) {
    const s = prepared(name);
    const bytes = mp4.segment({ sequenceNumber: 7, baseMediaDecodeTime: 2 ** 33 + 48000, samples: s.timed });
    const tree = mp4.parse(bytes);
    assertSizes(tree, bytes.length, name);
    assert.deepEqual(types(tree), ['styp', 'moof', 'mdat']);
    assert.deepEqual(tree[0].fields, { majorBrand: 'cmfs', minorVersion: 0, compatibleBrands: ['cmfs', 'cmff', 'msdh'] });
    assert.deepEqual(types(tree[1].children), ['mfhd', 'traf']);
    assert.equal(mp4.find(tree, 'moof/mfhd').fields.sequenceNumber, 7);
    assert.deepEqual(types(mp4.find(tree, 'moof/traf').children), ['tfhd', 'tfdt', 'trun']);
    assert.deepEqual(mp4.find(tree, 'moof/traf/tfhd').fields, {
      flags: 0x020002, trackId: 1, durationIsEmpty: false, defaultBaseIsMoof: true, sampleDescriptionIndex: 1,
    });
    assert.deepEqual(mp4.find(tree, 'moof/traf/tfdt').fields, { version: 1, baseMediaDecodeTime: 2 ** 33 + 48000 });
    const trun = mp4.find(tree, 'moof/traf/trun').fields;
    const moof = tree[1], mdat = tree[2];
    const withCto = s.timed.some(x => x.cto);
    assert.equal(trun.version, 1);
    assert.equal(trun.flags, withCto ? 0xf01 : 0x701);
    assert.equal(trun.sampleCount, 48);
    assert.deepEqual(trun.sizes, s.timed.map(x => x.data.length));
    assert.deepEqual(trun.durations, s.timed.map(() => DURATION));
    assert.deepEqual(trun.sampleFlags, s.timed.map(x => (x.key ? 0x02000000 : 0x01010000)));
    if (withCto) {
      assert.deepEqual(trun.ctos, s.timed.map(x => x.cto));
      assert.ok(trun.ctos.some(c => c < 0), 'в B-потоке есть отрицательные смещения (trun v1)');
    } else assert.equal(trun.ctos, undefined);
    assert.equal(moof.start + trun.dataOffset, mdat.start + 8, 'data_offset → первый байт mdat');
    assert.equal(mdat.fields.payloadSize, trun.sizes.reduce((a, b) => a + b, 0));
    let p = mdat.fields.payloadStart;
    for (const x of s.timed) { assert.deepEqual(bytes.subarray(p, p + x.data.length), x.data); p += x.data.length; }
  }
});

test('segment: ошибки входа — CMAF-условия и подвыборки', () => {
  const s = prepared('high.h264');
  const seg = extra => mp4.segment({ sequenceNumber: 1, baseMediaDecodeTime: 0, samples: s.timed, ...extra });
  assert.throws(() => seg({ samples: s.timed.slice(1) }), /ключевым/);
  assert.throws(() => seg({ samples: s.timed.map((x, i) => ({ ...x, cto: i === 0 ? 1000 : 0 })) }), /baseMediaDecodeTime/);
  assert.throws(() => seg({ samples: [] }), /хотя бы один/);
  const subs = s.timed.map(x => [{ clear: 10, protected: x.data.length - 10 }]);
  assert.throws(() => seg({ encryption: { subsamples: subs.slice(1) } }), /на каждый сэмпл/);
  assert.throws(() => seg({ encryption: { subsamples: subs.map(l => [{ ...l[0], protected: l[0].protected + 1 }]) } }), /покрывают/);
  assert.throws(() => seg({ encryption: { subsamples: subs.map((l, i) => (i ? l : [{ clear: 70000, protected: 0 }])) } }), /uint16/);
  const many = s.timed.map(x => [...Array.from({ length: 50 }, () => ({ clear: 1, protected: 0 })), { clear: x.data.length - 50, protected: 0 }]);
  assert.throws(() => seg({ encryption: { subsamples: many } }), /saiz/);
});

test('encryptCbcs: шаблон 1:9 с начала каждого защищённого диапазона, хвост < 16 открыт, совпадает с OpenSSL AES-128-CBC', async () => {
  // Синтетический сэмпл: 3 подвыборки с разными длинами защищённой части
  const layout = [{ clear: 5, protected: 16 * 10 * 3 + 7 }, { clear: 100, protected: 15 }, { clear: 0, protected: 16 * 12 }];
  const size = layout.reduce((a, s) => a + s.clear + s.protected, 0);
  const plain = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 7) & 255);
  const { bytes, regions } = await mp4.encryptCbcs(plain, layout, KEY, IV, { lengthSize: 0 });
  // Эталон: для каждой подвыборки шифруем блоки 0, 10, 20… её защищённой части одной цепочкой CBC
  const expected = plain.slice();
  let pos = 0;
  const encBlocks = [];
  for (const s of layout) {
    pos += s.clear;
    const offs = [];
    for (let p = pos; pos + s.protected - p >= 16; p += 160) offs.push(p);
    if (offs.length) {
      const c = nodeCrypto.createCipheriv('aes-128-cbc', KEY, IV).setAutoPadding(false);
      const ct = Buffer.concat([c.update(Buffer.concat(offs.map(o => plain.subarray(o, o + 16)))), c.final()]);
      offs.forEach((o, i) => expected.set(ct.subarray(16 * i, 16 * i + 16), o));
    }
    encBlocks.push(...offs);
    pos += s.protected;
  }
  assert.deepEqual(bytes, expected, 'совпадает с OpenSSL');
  assert.deepEqual(regions.filter(r => r.kind === 'enc').map(r => r.start), encBlocks);
  assert.deepEqual(regions.filter(r => r.kind === 'tail').map(r => [r.start, r.end]),
    [[5 + 480, 5 + 487], [5 + 487 + 100, 5 + 487 + 115]]);
  assert.equal(regions[0].start, 0);
  assert.equal(regions[regions.length - 1].end, size);
  regions.slice(1).forEach((r, i) => assert.equal(r.start, regions[i].end, 'регионы идут подряд'));
  const back = await mp4.decryptCbcs(bytes, layout, KEY, IV, { lengthSize: 0 });
  assert.deepEqual(back.bytes, plain);
  // Ключ как CryptoKey; другой шаблон (2:8); ошибки
  const ck = await crypto.subtle.importKey('raw', KEY, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  assert.deepEqual((await mp4.encryptCbcs(plain, layout, ck, IV, { lengthSize: 0 })).bytes, expected);
  const p28 = await mp4.encryptCbcs(plain, layout, KEY, IV, { lengthSize: 0, cryptByteBlock: 2, skipByteBlock: 8 });
  assert.deepEqual(p28.regions.filter(r => r.kind === 'enc').map(r => [r.start, r.end - r.start]).slice(0, 3), [[5, 32], [165, 32], [325, 32]]);
  assert.deepEqual((await mp4.decryptCbcs(p28.bytes, layout, KEY, IV, { lengthSize: 0, cryptByteBlock: 2, skipByteBlock: 8 })).bytes, plain);
  await assert.rejects(mp4.encryptCbcs(plain, [{ clear: 1, protected: 1 }], KEY, IV), /покрывают/);
  await assert.rejects(mp4.encryptCbcs(plain, layout, KEY.subarray(0, 8), IV), /16 байт/);
});

// Шифруем все сэмплы потока: карта подвыборок из h264, байты из encryptCbcs
async function encryptStream(s) {
  const ctx = h264.makeContext(s.avcC);
  const out = [];
  for (const x of s.timed) {
    const subsamples = h264.cbcsSubsamples(x.data, ctx);
    const enc = await mp4.encryptCbcs(x.data, subsamples, KEY, IV);
    out.push({ ...x, data: enc.bytes, plain: x.data, subsamples, regions: enc.regions });
  }
  return out;
}

test('cbcs по кадрам: длины/заголовки NAL/заголовки слайсов не тронуты, блоки 1:9, расшифровка возвращает исходник', async () => {
  for (const name of ['high.h264', 'baseline.h264', 'bframes.h264']) {
    const s = prepared(name, { keep: name === 'baseline.h264' ? [9] : [] });
    const enc = await encryptStream(s);
    let encBlocks = 0;
    for (const [i, x] of enc.entries()) {
      const label = `${name}[${i}]`;
      // Байты вне 'enc' не изменились; каждый 'enc' — ровно 16 байт и изменился
      const kinds = new Array(x.data.length);
      for (const r of x.regions) kinds.fill(r.kind, r.start, r.end);
      for (let b = 0; b < x.data.length; b++) if (kinds[b] !== 'enc') assert.equal(x.data[b], x.plain[b], `${label}: байт ${b} (${kinds[b]}) изменён`);
      for (const r of x.regions.filter(r => r.kind === 'enc')) {
        assert.equal(r.end - r.start, 16, label);
        assert.notDeepEqual(x.data.subarray(r.start, r.end), x.plain.subarray(r.start, r.end), label);
        encBlocks++;
      }
      // Шаблон: в каждом защищённом диапазоне блоки на смещениях 0, 160, 320…
      let pos = 0;
      const expected = [];
      for (const sub of x.subsamples) {
        pos += sub.clear;
        for (let p = pos; pos + sub.protected - p >= 16; p += 160) expected.push(p);
        pos += sub.protected;
      }
      assert.deepEqual(x.regions.filter(r => r.kind === 'enc').map(r => r.start), expected, label);
      // Разметка структуры: длины, заголовки NAL, заголовки слайсов, не-VCL — в открытой части
      for (const n of h264.nals(x.plain)) {
        assert.ok(kinds.slice(n.offset, n.start).every(k => k === 'len'), label);
        assert.equal(kinds[n.start], 'nalhdr', label);
        if (n.type === 1 || n.type === 5) {
          const sh = h264.sliceHeader(x.plain.subarray(n.start, n.end), h264.makeContext(s.avcC));
          assert.ok(kinds.slice(n.start + 1, n.start + sh.dataOffsetInNal).every(k => k === 'slicehdr'), label);
          assert.ok(kinds.slice(n.start + sh.dataOffsetInNal, n.end).every(k => ['enc', 'skip', 'tail'].includes(k)), label);
        } else {
          assert.ok(kinds.slice(n.start + 1, n.end).every(k => k === 'nonvcl'), label);
        }
      }
      const back = await mp4.decryptCbcs(x.data, x.subsamples, KEY, IV);
      assert.deepEqual(back.bytes, x.plain, label + ': расшифровка');
    }
    assert.ok(encBlocks > 100, name);
  }
});

test('зашифрованный сегмент: saiz/saio/senc, saio указывает на данные senc', async () => {
  const s = prepared('bframes.h264');
  const enc = await encryptStream(s);
  const bytes = mp4.segment({ sequenceNumber: 1, baseMediaDecodeTime: 0, samples: enc, encryption: { subsamples: enc.map(x => x.subsamples) } });
  const tree = mp4.parse(bytes);
  assertSizes(tree, bytes.length, 'enc-seg');
  const traf = mp4.find(tree, 'moof/traf');
  assert.deepEqual(types(traf.children), ['tfhd', 'tfdt', 'trun', 'saiz', 'saio', 'senc']);
  const saiz = mp4.find(traf.children, 'saiz').fields;
  const saio = mp4.find(traf.children, 'saio').fields;
  const senc = mp4.find(traf.children, 'senc');
  const sizes = enc.map(x => 2 + 6 * x.subsamples.length);
  if (saiz.defaultSampleInfoSize) assert.ok(sizes.every(n => n === saiz.defaultSampleInfoSize));
  else assert.deepEqual(saiz.sampleInfoSizes, sizes);
  assert.equal(saiz.sampleCount, 48);
  assert.deepEqual([saio.entryCount, saio.offsets.length], [1, 1]);
  assert.equal(tree[1].start + saio.offsets[0], senc.start + 16, 'saio → первый сэмпл в senc (от начала moof)');
  assert.deepEqual(senc.fields.samples.map(x => x.subsamples), enc.map(x => x.subsamples));
  assert.equal(senc.fields.ivSize, 0);
  assert.equal(senc.fields.flags, 2);
  // Сверка «вручную»: по saio/saiz читаем сырые байты вспомогательной информации
  let p = tree[1].start + saio.offsets[0];
  enc.forEach((x, i) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + p);
    assert.equal(dv.getUint16(0), x.subsamples.length);
    x.subsamples.forEach((sub, k) => {
      assert.equal(dv.getUint16(2 + 6 * k), sub.clear);
      assert.equal(dv.getUint32(4 + 6 * k), sub.protected);
    });
    p += sizes[i];
  });
  // data_offset по-прежнему указывает на mdat
  assert.equal(tree[1].start + mp4.find(traf.children, 'trun').fields.dataOffset, tree[2].start + 8);
});

/* ---------------- Внешняя проверка: ffprobe / ffmpeg ---------------- */

const md5s = text => text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
function framemd5(file, pre = [], post = []) {
  const r = H.run('ffmpeg', ['-hide_banner', '-v', 'error', ...pre, '-i', file, ...post, '-f', 'framemd5', '-']);
  assert.equal(r.status, 0, r.stderr);
  return { hashes: md5s(r.stdout), stderr: r.stderr };
}
function ffprobeJson(args) {
  const r = H.run('ffprobe', ['-v', 'error', '-of', 'json', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function writeMovie(dir, name, init, segs) {
  const files = [['init.mp4', init], ...segs.map((b, i) => [`seg${i + 1}.m4s`, b])];
  for (const [f, b] of files) fs.writeFileSync(path.join(dir, `${name}-${f}`), b);
  const out = path.join(dir, name + '.mp4');
  fs.writeFileSync(out, Buffer.concat([init, ...segs]));
  return out;
}

test('ffprobe/ffmpeg: init + 2 сегмента → h264 640×360, 96 кадров, без ошибок, pts через 1000, кадры = исходник', { skip: SKIP_NO_FFMPEG }, (t) => {
  const dir = H.tmpDir();
  const report = [];
  for (const name of ['high.h264', 'baseline.h264', 'bframes.h264', 'mbaff.h264', 'hi444.h264']) {
    const s = prepared(name, { keep: name === 'baseline.h264' ? [9] : [] });
    const n = s.timed.length;
    const sps = h264.parseSPS(s.sps[0]);
    const init = initFor(s);
    const seg1 = mp4.segment({ sequenceNumber: 1, baseMediaDecodeTime: 0, samples: s.timed });
    const seg2 = mp4.segment({ sequenceNumber: 2, baseMediaDecodeTime: n * DURATION, samples: s.timed });
    const file = writeMovie(dir, name.replace('.h264', ''), init, [seg1, seg2]);

    const info = ffprobeJson(['-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', file]).streams[0];
    assert.deepEqual(info, { codec_name: 'h264', width: sps.width, height: sps.height, nb_read_frames: String(2 * n) }, name);

    const dec = H.run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-']);
    assert.equal(dec.status, 0, name);
    assert.equal(dec.stderr, '', name + ': ffmpeg -v error должен молчать');

    // Время. ffmpeg держит DTS = tfdt + Σ длительностей, а к PTS добавляет dts_shift = max(−cto)
    // (libavformat/mov.c, mov_finalize_packet: pts = dts + dts_shift + offset), чтобы pts ≥ dts.
    // Поэтому кадры идут через DURATION начиная с shift, а у пакетов pts − dts = cto + shift.
    const shift = Math.max(0, ...s.timed.map(x => -x.cto));
    const frames = ffprobeJson(['-select_streams', 'v', '-show_entries', 'frame=pts,duration', file]).frames;
    assert.equal(frames.length, 2 * n);
    frames.forEach((f, i) => {
      assert.equal(+f.pts, shift + i * DURATION, `${name}: pts кадра ${i}`);
      assert.equal(+f.duration, DURATION, `${name}: duration кадра ${i}`);
    });
    const packets = ffprobeJson(['-select_streams', 'v', '-show_entries', 'packet=pts,dts,duration,flags', file]).packets;
    assert.equal(packets.length, 2 * n);
    packets.forEach((p, i) => {
      assert.equal(+p.dts, i * DURATION, `${name}: dts пакета ${i}`);
      assert.equal(+p.pts - +p.dts, s.timed[i % n].cto + shift, `${name}: pts − dts пакета ${i}`);
      assert.equal(p.flags.startsWith('K'), s.timed[i % n].key, `${name}: ключевой ли пакет ${i}`);
    });

    // Декодированные кадры бит-в-бит совпадают с декодом исходного Annex B (дважды: два сегмента)
    const ref = framemd5(path.join(H.FIXTURES, name)).hashes;
    const got = framemd5(file).hashes;
    assert.equal(ref.length, n);
    assert.deepEqual(got, [...ref, ...ref], name + ': framemd5');
    report.push(`${name}: ${info.width}×${info.height}, ${info.nb_read_frames} кадров, pts ${frames[0].pts}…${frames[frames.length - 1].pts}`);
  }
  t.diagnostic(report.join('; '));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ffmpeg -decryption_key: наш cbcs расшифровывается ffmpeg в те же кадры и пакеты', { skip: SKIP_NO_FFMPEG }, async (t) => {
  const dir = H.tmpDir();
  const report = [];
  for (const name of ['high.h264', 'baseline.h264', 'bframes.h264']) {
    const s = prepared(name, { keep: name === 'baseline.h264' ? [9] : [] });
    const n = s.timed.length;
    const enc = await encryptStream(s);
    const encryption = { subsamples: enc.map(x => x.subsamples) };
    const initEnc = initFor(s, {
      encryption: { scheme: 'cbcs', kid: KID, constantIV: IV, cryptByteBlock: 1, skipByteBlock: 9,
        pssh: [{ systemId: 'widevine', data: Uint8Array.from([0x12, 0x10, ...KID]) }, { systemId: 'common' }] },
    });
    const segs = [1, 2].map(k => mp4.segment({ sequenceNumber: k, baseMediaDecodeTime: (k - 1) * n * DURATION, samples: enc, encryption }));
    const encFile = writeMovie(dir, name.replace('.h264', '') + '-enc', initEnc, segs);
    const clearFile = writeMovie(dir, name.replace('.h264', '') + '-clear', initFor(s),
      [1, 2].map(k => mp4.segment({ sequenceNumber: k, baseMediaDecodeTime: (k - 1) * n * DURATION, samples: s.timed })));

    // Пакеты после расшифровки в демультиплексоре = исходные сэмплы
    const pk = f => framemd5(f, ['-decryption_key', hex(KEY)], ['-c', 'copy']).hashes;
    const clearPackets = framemd5(clearFile, [], ['-c', 'copy']).hashes;
    assert.deepEqual(pk(encFile), clearPackets, name + ': пакеты');
    // Декодированные кадры тоже совпадают, и без ошибок
    const dec = framemd5(encFile, ['-decryption_key', hex(KEY)]);
    assert.equal(dec.stderr, '', name);
    assert.deepEqual(dec.hashes, framemd5(clearFile).hashes, name + ': кадры');
    // Контроль: без ключа (или с чужим) данные действительно зашифрованы
    const wrong = Buffer.from(KEY).map(b => b ^ 0x5a).toString('hex');
    const bad = H.run('ffmpeg', ['-hide_banner', '-v', 'error', '-decryption_key', wrong, '-i', encFile, '-c', 'copy', '-f', 'framemd5', '-']);
    assert.notDeepEqual(md5s(bad.stdout), clearPackets, name + ': чужой ключ');
    const raw = H.run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', encFile, '-c', 'copy', '-f', 'framemd5', '-']);
    const encPackets = md5s(raw.stdout);
    assert.equal(encPackets.length, 2 * n);
    assert.equal(encPackets.filter((h, i) => h === clearPackets[i]).length, 0, name + ': все пакеты зашифрованы');
    // Контроль saio: ffmpeg читает подвыборки по смещению из saio (saiz/saio стоят раньше senc).
    // Сдвигаем только значение saio — расшифровка обязана сломаться; значит, в норме saio верен.
    const badSeg = segs[0].slice();
    const saio = mp4.find(mp4.parse(badSeg), 'moof/traf/saio');
    const dv = new DataView(badSeg.buffer);
    dv.setUint32(saio.start + 16, dv.getUint32(saio.start + 16) + 8);
    const badFile = writeMovie(dir, name.replace('.h264', '') + '-badsaio', initEnc, [badSeg]);
    const badSaio = H.run('ffmpeg', ['-hide_banner', '-v', 'error', '-decryption_key', hex(KEY), '-i', badFile, '-c', 'copy', '-f', 'framemd5', '-']);
    assert.notDeepEqual(md5s(badSaio.stdout), clearPackets.slice(0, n), name + ': с испорченным saio расшифровка не должна совпасть');
    report.push(`${name}: ${2 * n} пакетов расшифрованы бит-в-бит`);
  }
  t.diagnostic(report.join('; '));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parse(): чужой фрагментированный MP4 от ffmpeg — размеры trun = пакеты ffprobe, data_offset → mdat', { skip: SKIP_NO_FFMPEG }, () => {
  const dir = H.tmpDir();
  const file = path.join(dir, 'ff.mp4');
  // (+cmaf у ffmpeg 8 на сыром потоке с B-кадрами падает на assert в movenc.c — поэтому без него)
  const r = H.run('ffmpeg', ['-hide_banner', '-v', 'error', '-framerate', '24', '-i', path.join(H.FIXTURES, 'bframes.h264'), '-c', 'copy',
    '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', file]);
  assert.equal(r.status, 0, r.stderr);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const tree = mp4.parse(bytes);
  assertSizes(tree, bytes.length, 'ffmpeg');
  const sizes = [];
  for (const moof of tree.filter(n => n.type === 'moof')) {
    const trun = mp4.find(moof.children, 'traf/trun').fields;
    const tfhd = mp4.find(moof.children, 'traf/tfhd').fields;
    const mdat = tree[tree.indexOf(moof) + 1];
    assert.equal(mdat.type, 'mdat');
    assert.ok(tfhd.defaultBaseIsMoof);
    assert.equal(moof.start + trun.dataOffset, mdat.start + 8);
    sizes.push(...(trun.sizes || new Array(trun.sampleCount).fill(tfhd.defaultSampleSize)));
  }
  const packets = ffprobeJson(['-show_entries', 'packet=size', file]).packets.map(p => +p.size);
  assert.deepEqual(sizes, packets);
  assert.ok(tree.filter(n => n.type === 'moof').length >= 3, 'несколько фрагментов');
  assert.equal(mp4.find(tree, 'moov/trak/mdia/minf/stbl/stsd/avc1').fields.width, 640);
  fs.rmSync(dir, { recursive: true, force: true });
});

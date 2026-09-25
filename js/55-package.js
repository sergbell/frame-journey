/* =====================================================================
   55-package — глава «Упаковка и защита»: настоящий сегмент CMAF
   (fMP4) по байтам, шифрование cbcs, манифесты HLS и DASH из фактических
   размеров сегментов, лицензия DRM и A/B-водяные знаки.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const asset = FJ.asset, film = FJ.film;

  // Демонстрационный ключ и идентификаторы (не секрет: лицензионного сервера нет)
  const KID = 'b7e1a9c4d2f04e3a8c6b5d4e3f2a1b0c';
  const KEY = '3c5e7a9b1d2f40618293a4b5c6d7e8f9';
  const IV = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const hex2u8 = s => Uint8Array.from(s.match(/../g).map(x => parseInt(x, 16)));
  const u8hex = (u, n) => Array.from(u.subarray(0, n || u.length), b => b.toString(16).padStart(2, '0')).join(' ');
  const SYS = { widevine: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', playready: '9a04f079-9840-4286-ab92-e65be0885f95', fairplay: '94ce86fb-07ff-4f43-adb8-93d2fa968ca2' };

  const P = { rung: 1, seg: 12, enc: true, tab: 'master', wmSession: 669, wmLeak: null };
  let manPre, tabSeg, wmCv, wmOut, drmBody, boxHost, mapCv, blkCv, blkInfo, hexPre;

  /* ------------------------------------------------------------------
     Манифесты
     ------------------------------------------------------------------ */
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function hlsColor(txt) {
    return txt.split('\n').map(l => {
      if (/^#EXT/.test(l)) {
        const i = l.indexOf(':');
        if (i < 0) return `<span class="k">${esc(l)}</span>`;
        return `<span class="k">${esc(l.slice(0, i))}</span>:${esc(l.slice(i + 1)).replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, '$1=<span class="v">$2</span>')}`;
      }
      if (/^#/.test(l)) return `<span class="c">${esc(l)}</span>`;
      return esc(l);
    }).join('\n');
  }
  function xmlColor(txt) {
    return esc(txt).replace(/(&lt;\/?)([\w:]+)/g, '$1<span class="k">$2</span>').replace(/([\w:]+)=(&quot;|")([^"]*?)(")/g, '$1=<span class="v">"$3"</span>').replace(/(&lt;!--.*?--&gt;)/g, '<span class="c">$1</span>');
  }
  const codecOf = r => (asset.decoderConfig[r] && asset.decoderConfig[r].codec) || asset.codec || 'avc1.64001f';
  function master() {
    const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS', '# «Восемь планов»: 5 качеств, CMAF (fMP4), H.264, IDR каждые 2 с'];
    if (P.enc) L.push('# в настоящем кинотеатре здесь были бы и аудиодорожки (EXT-X-MEDIA TYPE=AUDIO), и субтитры');
    asset.ladder.forEach((rg, r) => {
      L.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(asset.peakKbps(r)) * 1000},AVERAGE-BANDWIDTH=${Math.round(asset.avgKbps(r)) * 1000},CODECS="${codecOf(r)}",RESOLUTION=${rg.w}x${rg.h},FRAME-RATE=24.000,VIDEO-RANGE=SDR`);
      L.push(`${rg.name}/playlist.m3u8`);
    });
    asset.ladder.forEach((rg, r) => {
      const ib = ifrKbps(r);
      L.push(`#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${ib * 1000},CODECS="${codecOf(r)}",RESOLUTION=${rg.w}x${rg.h},URI="${rg.name}/iframes.m3u8"`);
    });
    return L.join('\n');
  }
  function ifrKbps(r) {
    let mx = 0;
    for (let k = 0; k < asset.segCount; k++) { const f = asset.frames[r][k * asset.segFrames]; if (f) mx = Math.max(mx, f.size * 8 / asset.segDur / 1000); }
    return Math.round(mx);
  }
  function keyLines() {
    if (!P.enc) return [];
    const psshB64 = 'AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADsIARIQt+GpxNLwTjqMa11OPyobDBoNd2lkZXZpbmVfdGVzdCIQYjdlMWE5YzRkMmYwNGUzYQ==';
    return [
      `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://keys.example/${KID}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"`,
      `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,${psshB64}",KEYID=0x${KID.toUpperCase()},KEYFORMAT="urn:uuid:${SYS.widevine}",KEYFORMATVERSIONS="1"`,
    ];
  }
  function media() {
    const rg = asset.ladder[P.rung];
    const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', ...keyLines(), '#EXT-X-MAP:URI="init.mp4"'];
    for (let k = 0; k < asset.segCount; k++) {
      const s = asset.segs[P.rung][k];
      L.push('#EXTINF:2.000,');
      L.push(`seg_${String(k + 1).padStart(3, '0')}.m4s${k === P.seg ? `   # ${fmt.bytes(s.bytes)}, ${fmt.kbps(s.bytes * 8 / 2)} — открыт ниже` : ''}`);
    }
    L.push('#EXT-X-ENDLIST');
    void rg;
    return L.join('\n');
  }
  function iframes() {
    const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-I-FRAMES-ONLY', ...keyLines(), '#EXT-X-MAP:URI="init.mp4"', '# каждая запись — байты одного IDR внутри сегмента: для перемотки и превью на ТВ'];
    const offs = FJ.pack && FJ.pack.idrOffsets ? FJ.pack.idrOffsets(P.rung) : null;
    for (let k = 0; k < asset.segCount; k++) {
      const f = asset.frames[P.rung][k * asset.segFrames];
      const off = offs ? offs[k] : null;
      L.push('#EXTINF:2.000,');
      L.push(off != null ? `#EXT-X-BYTERANGE:${f.size}@${off}` : `#EXT-X-BYTERANGE:${f ? f.size : 0}@…`);
      L.push(`seg_${String(k + 1).padStart(3, '0')}.m4s`);
    }
    L.push('#EXT-X-ENDLIST');
    return L.join('\n');
  }
  function mpd() {
    const reps = asset.ladder.map((rg, r) => `      <Representation id="${rg.name}" codecs="${codecOf(r)}" bandwidth="${Math.round(asset.peakKbps(r)) * 1000}" width="${rg.w}" height="${rg.h}"/>`).join('\n');
    const cp = P.enc ? `
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="${KID.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}"/>
      <ContentProtection schemeIdUri="urn:uuid:${SYS.widevine}"><cenc:pssh>AAAAW3Bzc2gAAAAA7e+Lq…</cenc:pssh></ContentProtection>
      <ContentProtection schemeIdUri="urn:uuid:${SYS.playready}"><cenc:pssh>AAADfnBzc2gAAAAAmgTweZhA…</cenc:pssh></ContentProtection>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static"
     mediaPresentationDuration="PT1M4S" minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011,urn:mpeg:dash:profile:cmaf:2019">
  <Period id="0" start="PT0S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true"
                   startWithSAP="1" maxWidth="1280" maxHeight="720" frameRate="24">${cp}
      <SegmentTemplate timescale="24000" duration="48000" startNumber="1"
                       initialization="$RepresentationID$/init.mp4"
                       media="$RepresentationID$/seg_$Number%03d$.m4s"/>
${reps}
    </AdaptationSet>
  </Period>
</MPD>`;
  }
  function paintManifest() {
    if (!manPre) return;
    const txt = P.tab === 'master' ? master() : P.tab === 'media' ? media() : P.tab === 'iframes' ? iframes() : mpd();
    manPre.innerHTML = P.tab === 'mpd' ? xmlColor(txt) : hlsColor(txt);
  }

  /* ------------------------------------------------------------------
     DRM: что умеет это устройство (EME)
     ------------------------------------------------------------------ */
  async function probeDrm() {
    const rows = [
      ['Widevine L1 (аппаратный)', 'com.widevine.alpha', 'HW_SECURE_ALL', ['cenc']],
      ['Widevine L3 (программный)', 'com.widevine.alpha', 'SW_SECURE_CRYPTO', ['cenc']],
      ['PlayReady SL3000', 'com.microsoft.playready.recommendation.3000', '', ['cenc']],
      ['PlayReady SL2000', 'com.microsoft.playready.recommendation', '', ['cenc']],
      ['FairPlay', 'com.apple.fps', '', ['sinf', 'skd']],
      ['Clear Key (W3C, без защиты)', 'org.w3.clearkey', '', ['cenc', 'keyids']],
    ];
    drmBody.innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td class="mono">${r[1]}</td><td>…</td></tr>`).join('');
    const out = [];
    for (const [name, ks, rob, idt] of rows) {
      let res = 'нет';
      if (!navigator.requestMediaKeySystemAccess) res = 'нет EME';
      else {
        try {
          const vc = { contentType: 'video/mp4; codecs="avc1.64001f"' };
          if (rob) vc.robustness = rob;
          const acc = await Promise.race([
            navigator.requestMediaKeySystemAccess(ks, [{ initDataTypes: idt, videoCapabilities: [vc], encryptionScheme: 'cbcs' }]),
            new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 2500)),
          ]);
          res = acc ? '<span class="cd-yes">да</span>' : 'нет';
        } catch (e) {
          res = /policy|permission|allowed/i.test(e.message || '') ? 'закрыто политикой окна' : 'нет';
        }
      }
      out.push(`<tr><td>${name}</td><td class="mono">${ks}</td><td>${res}</td></tr>`);
    }
    drmBody.innerHTML = out.join('');
  }

  /* ------------------------------------------------------------------
     A/B-водяные знаки: номер сессии записан выбором вариантов сегментов
     ------------------------------------------------------------------ */
  const WM_BITS = 12;
  function bitsOf(n) { return Array.from({ length: WM_BITS }, (_, i) => (n >> (WM_BITS - 1 - i)) & 1); }
  function paintWm() {
    if (!wmCv) return;
    const { ctx, w, h: H } = wmCv;
    wmCv.clear();
    const N = 24;                                // сегментов показываем
    const bits = bitsOf(P.wmSession);
    const l = 64, t = 22, cw = (w - l - 8) / N, rh = (H - t - 30) / 2;
    ctx.font = FJ.font.mono(11); ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    ctx.fillStyle = FJ.colors.text; ctx.fillText('вариант A', l - 8, t + rh / 2); ctx.fillText('вариант B', l - 8, t + rh * 1.5);
    const path = [];
    for (let k = 0; k < N; k++) {
      const bit = bits[k % WM_BITS];
      for (let v = 0; v < 2; v++) {
        const x = l + k * cw + 2, y = t + v * rh + 3, ww = cw - 4, hh = rh - 6;
        const on = bit === v;
        ctx.fillStyle = on ? (v ? 'rgba(165,139,255,.35)' : 'rgba(111,179,255,.35)') : 'rgba(255,255,255,.04)';
        ctx.fillRect(x, y, ww, hh);
        ctx.strokeStyle = on ? (v ? '#a58bff' : '#6fb3ff') : 'rgba(255,255,255,.08)';
        ctx.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1);
        if (on) path.push([x + ww / 2, y + hh / 2]);
      }
    }
    ctx.strokeStyle = '#ffb02e'; ctx.lineWidth = 2; ctx.beginPath();
    path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    path.forEach(([x, y]) => { ctx.fillStyle = '#ffb02e'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); });
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = FJ.colors.muted; ctx.font = FJ.font.mono(10);
    for (let k = 0; k < N; k += 2) ctx.fillText(String(k + 1), l + (k + 0.5) * cw, t + 2 * rh + 6);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('позиция бита = номер сегмента mod 12', l, 12);
    const leak = P.wmLeak;
    wmOut.innerHTML = `Сессия <b class="mono">№ ${P.wmSession}</b> = <span class="mono">${bits.join('')}</span> в&nbsp;двоичном виде. Edge CDN отдаёт этому зрителю вариант A на&nbsp;нулях и&nbsp;B на&nbsp;единицах; оба варианта выглядят одинаково, разница спрятана в&nbsp;самом изображении.` +
      (leak ? `<br>Пиратская копия: детектор сравнил ${WM_BITS} сегментов с&nbsp;эталонами A и&nbsp;B и&nbsp;прочитал <span class="mono">${leak.join('')}</span> → <b class="mono">сессия № ${parseInt(leak.join(''), 2)}</b>. ${parseInt(leak.join(''), 2) === P.wmSession ? 'Совпало: утечка найдена.' : ''}` : '');
  }

  /* ------------------------------------------------------------------
     Монтаж главы
     ------------------------------------------------------------------ */
  function mount(el) {
    FJ.addStyle(`
      .pk-tabs { margin-bottom: 8px; }
      .pk-man { max-height: 420px; font-size: 12px; }
      .pk-wm { height: 170px; }
      .pk-map { height: 120px; } .pk-blk { height: 230px; }
      .pk-tree { font: 12px/1.7 var(--f-mono); color: var(--text-2); max-height: 360px; overflow: auto; padding: 10px 12px; background: #111214; border: 1px solid var(--line); border-radius: 4px; }
      .pk-tree .b { color: var(--q3); } .pk-tree .sz { color: var(--muted); } .pk-tree .f { color: var(--q2); }
      .pk-two { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      @media (max-width: 700px) { .pk-two { grid-template-columns: minmax(0, 1fr); } }
      .cd-yes { color: var(--q4); }
      .pk-two video { width: 100%; height: 100%; display: block; background: #050506; object-fit: contain; }
    `);
    $('#packText').innerHTML = `
      <p>Закодированные кадры надо упаковать так, чтобы их понял любой плеер. Сегодня это CMAF&nbsp;— фрагментированный MP4: заголовок <code>ftyp</code> + <code>moov</code> с&nbsp;описанием дорожки и&nbsp;сегменты <code>moof</code> + <code>mdat</code>, где <code>moof</code>&nbsp;— оглавление кадров, а&nbsp;<code>mdat</code>&nbsp;— сами кадры. Одни и&nbsp;те&nbsp;же сегменты читают и&nbsp;HLS, и&nbsp;DASH: меняется только манифест${FJ.cite('hls')}${FJ.cite('dashif-timing')}.</p>
      <p><strong>Защита.</strong> Студия отдаёт премьеры только в&nbsp;зашифрованном виде. По&nbsp;схеме <code>cbcs</code> (Common Encryption) шифруется не&nbsp;весь кадр: заголовки NAL и&nbsp;слайсов остаются открытыми, а&nbsp;в&nbsp;данных слайса по&nbsp;AES‑128‑CBC шифруется один 16‑байтный блок из&nbsp;каждых десяти${FJ.cite('cenc')}. Это экономит процессор телевизора, и&nbsp;главное&nbsp;— один и&nbsp;тот&nbsp;же файл подходит Widevine, PlayReady и&nbsp;FairPlay. Apple для CENC требует именно шаблон 1:9${FJ.cite('apple-auth')}.</p>
      <p>Ключ приходит в&nbsp;лицензии. Плеер через EME просит модуль расшифровки (CDM), тот идёт к&nbsp;серверу лицензий, сервер проверяет подписку и&nbsp;устройство. Для HD и&nbsp;4K правила студий строже: аппаратная доверенная среда (Widevine L1, PlayReady SL3000), HDCP 2.2 на&nbsp;выходе HDMI, ключи на&nbsp;сервере и&nbsp;контент в&nbsp;CDN&nbsp;— не&nbsp;раньше чем за&nbsp;два дня до&nbsp;релиза${FJ.cite('ecp')}${FJ.cite('playready-sl')}${FJ.cite('widevine')}.</p>
      <p><strong>Водяные знаки.</strong> Если фильм всё&nbsp;же утёк, нужно понять, откуда. В&nbsp;A/B‑схеме каждый сегмент заранее кодируют в&nbsp;двух неотличимых на&nbsp;глаз вариантах. Edge CDN по&nbsp;подписанному токену отдаёт каждому зрителю свою последовательность A и&nbsp;B, и&nbsp;в&nbsp;этой последовательности записан номер его сессии. Схема стандартизована в&nbsp;ETSI TS 104 002${FJ.cite('etsi-wm')}.</p>`;

    // 1. сегмент изнутри
    const segBar = h('div', { class: 'row' });
    const rungSeg = h('div'), segSl = h('div', { style: { minWidth: '220px', flex: '1' } }), encTg = h('div');
    segBar.append(rungSeg, segSl, encTg);
    el.append(h('h3', { text: 'Сегмент изнутри' }), segBar);
    FJ.seg(rungSeg, asset.ladder.map((rg, r) => ({ v: r, label: rg.name, chip: `var(--q${r + 1})` })), P.rung, v => { P.rung = v; refresh(); }, { small: true });
    rungSeg.title = 'Качество: от него зависят сегмент и плейлист качества';
    FJ.slider(segSl, { id: 'pkSeg', label: 'Сегмент', min: 1, max: asset.segCount, step: 1, value: P.seg + 1, fmt: v => `№ ${v} · ${film.shotAt((v - 1) * 48 + 24).name}`, onInput: v => { P.seg = v - 1; refresh(); } });
    FJ.toggle(encTg, { id: 'pkEnc', label: 'Зашифровать cbcs', value: P.enc, onChange: v => { P.enc = v; refresh(); } });
    boxHost = h('div', { class: 'pk-two' });
    el.append(boxHost);
    const mapHost = h('div', { class: 'fig__canvas pk-map', role: 'img', 'aria-label': 'Байтовая карта сегмента: боксы и кадры' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [h('span', { class: 'ctl-label', text: 'Карта байтов сегмента: оглавление и кадры' }), mapHost]));
    mapCv = FJ.canvas(mapHost, { onResize: () => paintMap() });
    const blkHost = h('div', { class: 'fig__canvas pk-blk', role: 'img', 'aria-label': 'Ключевой кадр по 16-байтным блокам' });
    blkInfo = h('p', { class: 'caption' });
    hexPre = h('pre', { class: 'code', style: { fontSize: '11.5px' } });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [h('span', { class: 'ctl-label', text: 'Ключевой кадр сегмента по 16-байтным блокам' }), blkHost, blkInfo, hexPre]));
    blkCv = FJ.canvas(blkHost, { onResize: () => paintBlocks() });

    // 1б. лицензия: EME + Clear Key расшифровывают наш cbcs прямо в <video>
    el.append(h('h3', { text: 'Лицензия: браузер расшифровывает сам', style: { marginTop: '12px' } }));
    const vid = h('video', { muted: true, playsinline: true, 'aria-label': 'Зашифрованный фильм, который расшифровывает модуль Clear Key браузера' });
    vid.muted = true;
    const vScreen = h('div', { class: 'monitor__screen' }, [vid]);
    const vTally = h('span', { class: 'tally' });
    const vUmd = h('span', { text: 'EME · org.w3.clearkey · cbcs' });
    const vMon = h('div', { class: 'monitor' }, [vScreen, h('div', { class: 'umd' }, [vTally, h('span', { class: 'lbl', text: '<video> + MSE' }), vUmd])]);
    const lic = h('pre', { class: 'code', style: { fontSize: '11.5px', maxHeight: '300px' }, 'aria-live': 'polite' });
    const licBtn = h('button', { class: 'btn primary', type: 'button' }, ['Запросить лицензию и играть']);
    const denyTg = h('div');
    el.append(h('div', { class: 'pk-two' }, [vMon, lic]));
    el.append(h('div', { class: 'row' }, [licBtn, denyTg]));
    el.append(h('p', { class: 'caption', html: 'Это настоящий EME: браузер находит в&nbsp;init‑сегменте бокс <code>pssh</code>, создаёт сессию, отдаёт запрос «серверу лицензий» (здесь это функция на&nbsp;странице), получает ключ и&nbsp;сам расшифровывает наши cbcs‑сегменты. Clear Key&nbsp;— тестовая система W3C: ключ лежит в&nbsp;JavaScript, поэтому премьеры так не&nbsp;защищают. Widevine, PlayReady и&nbsp;FairPlay прячут ключ в&nbsp;CDM и&nbsp;доверенной среде, но&nbsp;протокол EME и&nbsp;формат cbcs у&nbsp;них те&nbsp;же.' }));
    let deny = false;
    FJ.toggle(denyTg, { id: 'pkDeny', label: 'Сервер отказывает в лицензии', value: false, onChange: v => { deny = v; } });
    let curVid = vid;
    licBtn.addEventListener('click', () => {
      // каждый запуск — новый <video>: к старому уже привязаны ключи и MediaSource
      const nv = h('video', { muted: true, playsinline: true, 'aria-label': curVid.getAttribute('aria-label') });
      nv.muted = true;
      try { curVid.pause(); curVid.removeAttribute('src'); curVid.load(); } catch (e) { /* уже остановлен */ }
      curVid.replaceWith(nv); curVid = nv;
      vTally.className = 'tally'; vUmd.textContent = 'EME · org.w3.clearkey · cbcs';
      playLicensed(nv, lic, vTally, vUmd, () => deny);
    });
    lic.textContent = '// журнал EME появится после нажатия';

    // 2. манифесты
    el.append(h('h3', { text: 'Манифесты', style: { marginTop: '12px' } }));
    tabSeg = h('div', { class: 'pk-tabs' });
    el.append(tabSeg);
    FJ.seg(tabSeg, [{ v: 'master', label: 'master.m3u8' }, { v: 'media', label: 'playlist.m3u8' }, { v: 'iframes', label: 'iframes.m3u8' }, { v: 'mpd', label: 'manifest.mpd' }], P.tab, v => { P.tab = v; paintManifest(); }, { small: true });
    manPre = h('pre', { class: 'code pk-man', tabindex: '0', 'aria-label': 'Текст манифеста' });
    el.append(manPre);
    el.append(h('p', { class: 'caption', html: 'BANDWIDTH&nbsp;— пиковый битрейт сегмента, AVERAGE-BANDWIDTH&nbsp;— средний, оба посчитаны по&nbsp;настоящим сегментам нашей фермы. CODECS&nbsp;— строка, которую вернул кодировщик браузера. С&nbsp;включённым шифрованием появляются ключи FairPlay и&nbsp;Widevine (HLS) и&nbsp;ContentProtection (DASH); тексты pssh укорочены.' }));

    // 3. DRM этого устройства
    el.append(h('h3', { text: 'Какие DRM есть в этом браузере', style: { marginTop: '12px' } }));
    const tbl = h('table', { class: 'tbl' });
    tbl.innerHTML = '<thead><tr><th>Система</th><th>Ключ EME</th><th>Доступна</th></tr></thead>';
    drmBody = h('tbody'); tbl.append(drmBody);
    el.append(h('div', { class: 'tbl-wrap' }, [tbl]));
    el.append(h('p', { class: 'caption', html: 'Проверка через <code>navigator.requestMediaKeySystemAccess</code> со&nbsp;схемой cbcs. Chrome на&nbsp;компьютере обычно даёт только программный Widevine L3, Edge&nbsp;— PlayReady, Safari&nbsp;— FairPlay. Во&nbsp;встроенных окнах EME бывает закрыт политикой.' }));

    // 4. A/B
    el.append(h('h3', { text: 'A/B-водяной знак', style: { marginTop: '12px' } }));
    const wmBar = h('div', { class: 'row' });
    const wmNew = h('button', { class: 'btn', type: 'button', onclick: () => { P.wmSession = 1 + Math.floor(Math.random() * 4094); P.wmLeak = null; paintWm(); } }, ['Другой зритель']);
    const wmLeakBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => { P.wmLeak = bitsOf(P.wmSession); paintWm(); } }, ['Найти источник утечки']);
    wmBar.append(wmNew, wmLeakBtn);
    el.append(wmBar);
    const wmHost = h('div', { class: 'fig__canvas pk-wm', role: 'img', 'aria-label': 'Последовательность вариантов A и B, записывающая номер сессии' });
    wmOut = h('p', { class: 'caption' });
    el.append(h('div', { class: 'panel', style: { padding: '12px' } }, [wmHost, wmOut]));
    wmCv = FJ.canvas(wmHost, { onResize: () => paintWm() });

    paintManifest(); paintWm(); probeDrm();
    asset.on('done', refresh);
  }

  /* ------------------------------------------------------------------
     Мультиплексирование и шифрование (FJ.mp4 / FJ.h264)
     ------------------------------------------------------------------ */
  let cur = null, token = 0;
  async function refresh() {
    paintManifest();
    if (!asset.allReady || asset.mode !== 'webcodecs' || !FJ.mp4 || !FJ.mp4.segment) { paintBoxes(null); return; }
    const my = ++token;
    try { cur = await FJ.pack.build(P.rung, P.seg, P.enc); } catch (e) { cur = { error: e.message }; }
    if (my !== token) return;
    paintBoxes(cur); paintMap(); paintBlocks();
  }
  function paintBoxes(c) {
    if (!boxHost) return;
    if (!c) { boxHost.innerHTML = `<div class="notice"><span><b>Ждём ферму.</b> Сегменты появятся, когда кодирование закончится${asset.mode === 'model' ? ' — но в модельном режиме настоящих байтов нет' : ''}.</span></div>`; return; }
    if (c.error) { boxHost.innerHTML = `<div class="notice"><span><b>Не удалось упаковать:</b> ${esc(c.error)}</span></div>`; return; }
    boxHost.innerHTML = '';
    boxHost.append(h('div', { class: 'stack', style: { gap: '6px' } }, [h('span', { class: 'ctl-label', text: `init.mp4 · ${fmt.bytes(c.init.length)}` }), h('div', { class: 'pk-tree', html: treeHtml(c.initTree) })]));
    boxHost.append(h('div', { class: 'stack', style: { gap: '6px' } }, [h('span', { class: 'ctl-label', text: `seg_${String(P.seg + 1).padStart(3, '0')}.m4s · ${fmt.bytes(c.seg.length)}` }), h('div', { class: 'pk-tree', html: treeHtml(c.segTree) })]));
  }
  function treeHtml(tree, depth) {
    depth = depth || 0;
    return tree.map(b => {
      const pad = '&nbsp;'.repeat(depth * 3);
      const f = b.fields ? Object.entries(b.fields).filter(([k, v]) => typeof v !== 'object' || Array.isArray(v) && v.length <= 4 && typeof v[0] !== 'object').slice(0, 5).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' · ') : '';
      return `<div>${pad}<span class="b">${esc(b.type)}</span> <span class="sz">${fmt.int(b.size)} Б</span>${f ? ` <span class="f">${esc(String(f)).slice(0, 110)}</span>` : ''}</div>` + (b.children ? treeHtml(b.children, depth + 1) : '');
    }).join('');
  }
  function paintMap() {
    if (!mapCv) return;
    const { ctx, w, h: H } = mapCv;
    mapCv.clear();
    if (!cur || !cur.seg) return;
    const top = cur.segTree;
    const total = cur.seg.length;
    // верхняя полоса: боксы в честном масштабе
    const y0 = 18, bh = 26;
    const colors = { styp: '#8f9197', moof: '#6fb3ff', mdat: '#e8d84a', sidx: '#a58bff' };
    for (const b of top) {
      const x = b.start / total * w, ww = Math.max(1, b.size / total * w);
      ctx.fillStyle = FJ.alpha(colors[b.type] || '#888', 0.8); ctx.fillRect(x, y0, ww, bh);
    }
    ctx.font = FJ.font.mono(10); ctx.fillStyle = FJ.colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const moof = top.find(b => b.type === 'moof');
    ctx.fillText(`весь сегмент ${fmt.bytes(total)} · moof ${moof ? fmt.int(moof.size) + ' Б' : '—'} (${moof ? fmt.num(moof.size / total * 100, 2) : 0} %) · кадры в mdat`, 0, 12);
    // нижняя полоса: кадры внутри mdat
    const y1 = 62, fh = 36;
    const fr = cur.frames;
    const sum = fr.reduce((a, f) => a + f.size, 0);
    let x = 0;
    fr.forEach((f, i) => {
      const ww = f.size / sum * w;
      ctx.fillStyle = f.key ? '#ff4d3d' : (i % 2 ? 'rgba(232,216,74,.55)' : 'rgba(232,216,74,.8)');
      ctx.fillRect(x, y1, Math.max(0.6, ww - 0.4), fh);
      x += ww;
    });
    ctx.fillStyle = FJ.colors.muted; ctx.fillText(`${fr.length} кадров: красный — IDR (${fmt.bytes(fr[0].size)}), жёлтые — P‑кадры`, 0, y1 + fh + 14);
  }
  function paintBlocks() {
    if (!blkCv) return;
    const { ctx, w, h: H } = blkCv;
    blkCv.clear();
    if (!cur || !cur.idr) return;
    const { regions, len } = cur.idr;
    const nb = Math.ceil(len / 16);
    const cols = Math.max(32, Math.floor(w / 7)), cell = w / cols;
    const rows = Math.ceil(nb / cols);
    const shown = Math.min(rows, Math.floor(H / cell));
    const kindCol = { len: '#8f9197', nalhdr: '#6fb3ff', slicehdr: '#a58bff', enc: '#ff4d3d', skip: '#3a3c41', tail: '#ffb02e', nonvcl: '#5bcb5e', clear: '#3a3c41' };
    const blockKind = new Array(nb).fill('clear');
    for (const r of regions) for (let b = Math.floor(r.start / 16); b <= Math.floor((r.end - 1) / 16) && b < nb; b++) {
      // зашифрованный блок важнее всего, потом заголовки
      if (blockKind[b] === 'enc') continue;
      if (r.kind === 'enc' || blockKind[b] === 'clear' || blockKind[b] === 'skip') blockKind[b] = r.kind;
    }
    for (let b = 0; b < Math.min(nb, shown * cols); b++) {
      const x = (b % cols) * cell, y = Math.floor(b / cols) * cell;
      ctx.fillStyle = kindCol[blockKind[b]] || '#3a3c41';
      ctx.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    }
    const encN = blockKind.filter(k => k === 'enc').length;
    blkInfo.innerHTML = P.enc
      ? `IDR‑кадр ${fmt.bytes(len)} = ${fmt.int(nb)} блоков по&nbsp;16 байт. Зашифровано ${fmt.int(encN)} (${fmt.pct(encN / nb, 1)}): красный&nbsp;— AES‑128‑CBC, тёмный&nbsp;— пропущенные 9 из&nbsp;10, серый&nbsp;— длина NAL, синий&nbsp;— заголовок NAL, фиолетовый&nbsp;— заголовок слайса, зелёный&nbsp;— SPS/PPS/SEI, янтарный&nbsp;— хвост короче блока. Шифрование сделал WebCrypto с&nbsp;демонстрационным ключом.${shown < rows ? ` Показаны первые ${fmt.int(shown * cols)} блоков.` : ''}`
      : `IDR‑кадр ${fmt.bytes(len)} = ${fmt.int(nb)} блоков по&nbsp;16 байт. Включите шифрование: увидите, какие блоки cbcs закрывает, а&nbsp;какие оставляет открытыми.`;
    hexPre.textContent = cur.hex || '';
  }

  FJ.pack = FJ.pack || {};

  /* ---------- данные PSSH ---------- */
  // Widevine: protobuf WidevinePsshData, поле 2 (key_id) = KID
  function widevinePssh(kid) { return Uint8Array.from([0x12, 0x10, ...kid]); }
  // PlayReady: объект PRO с WRMHEADER 4.3 (AESCBC = cbcs); KID в порядке байтов GUID
  function playreadyPssh(kid) {
    const guid = Uint8Array.from([kid[3], kid[2], kid[1], kid[0], kid[5], kid[4], kid[7], kid[6], ...kid.slice(8)]);
    const b64 = btoa(String.fromCharCode(...guid));
    const xml = `<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.3.0.0"><DATA><PROTECTINFO><KIDS><KID ALGID="AESCBC" VALUE="${b64}"></KID></KIDS></PROTECTINFO><LA_URL>https://license.example/playready</LA_URL></DATA></WRMHEADER>`;
    const utf16 = new Uint8Array(xml.length * 2);
    for (let i = 0; i < xml.length; i++) { utf16[i * 2] = xml.charCodeAt(i) & 255; utf16[i * 2 + 1] = xml.charCodeAt(i) >> 8; }
    const total = 4 + 2 + 2 + 2 + utf16.length;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, total, true); dv.setUint16(4, 1, true); dv.setUint16(6, 1, true); dv.setUint16(8, utf16.length, true);
    out.set(utf16, 10);
    return out;
  }

  /* ---------- карта байтов ключевого кадра ---------- */
  function regionsOf(sample, nalsInfo, subs, enc) {
    const R = [];
    let pos = 0;
    for (const n of nalsInfo) {
      R.push({ start: pos, end: pos + n.lengthSize, kind: 'len' });
      const st = pos + n.lengthSize;
      if (n.slice) {
        R.push({ start: st, end: st + 1, kind: 'nalhdr' });
        R.push({ start: st + 1, end: st + n.slice.dataOffsetInNal, kind: 'slicehdr' });
        const ds = st + n.slice.dataOffsetInNal, de = st + n.size;
        if (enc) {
          for (let b = ds; b < de; b += 16) {
            const bi = (b - ds) / 16;
            if (b + 16 > de) R.push({ start: b, end: de, kind: 'tail' });
            else R.push({ start: b, end: b + 16, kind: bi % 10 === 0 ? 'enc' : 'skip' });
          }
        } else R.push({ start: ds, end: de, kind: 'clear' });
      } else R.push({ start: st, end: st + n.size, kind: 'nonvcl' });
      pos = st + n.size;
    }
    void subs;
    return R;
  }

  /* ---------- упаковка сегмента ---------- */
  const TS = 24000, FD = 1000; // таймскейл 24 000, кадр = 1000 тиков
  FJ.pack.build = async function (r, k, enc) {
    const a = asset, rg = a.ladder[r], dc = a.decoderConfig[r];
    const avcC = dc.description instanceof Uint8Array ? dc.description : new Uint8Array(dc.description.buffer || dc.description);
    const ctx = FJ.h264.makeContext(avcC);
    const frames = [];
    for (let i = k * a.segFrames; i < Math.min(a.frameCount, (k + 1) * a.segFrames); i++) frames.push(a.frames[r][i]);
    let samples = frames.map(f => ({ data: f.data, duration: FD, key: f.key }));
    const idr = frames[0].data;
    const nalsInfo = FJ.h264.parseSample(idr, ctx);
    let encInit = null, encSeg = null, encIdr = null;
    if (enc) {
      const key = hex2u8(KEY), iv = hex2u8(IV), kid = hex2u8(KID);
      const subs = [], out = [];
      for (const s of samples) {
        const ss = FJ.h264.cbcsSubsamples(s.data, ctx);
        const res = await FJ.mp4.encryptCbcs(s.data, ss, key, iv);
        const bytes = res instanceof Uint8Array ? res : res.bytes;
        out.push({ data: bytes, duration: s.duration, key: s.key });
        subs.push(ss);
      }
      encIdr = out[0].data;
      samples = out;
      encInit = { scheme: 'cbcs', kid, constantIV: iv, cryptByteBlock: 1, skipByteBlock: 9, pssh: [{ systemId: SYS.widevine, data: widevinePssh(kid) }, { systemId: SYS.playready, data: playreadyPssh(kid) }] };
      encSeg = { subsamples: subs };
    }
    const init = FJ.mp4.init({ width: rg.w, height: rg.h, timescale: TS, avcC, encryption: encInit });
    const seg = FJ.mp4.segment({ sequenceNumber: k + 1, baseMediaDecodeTime: k * a.segFrames * FD, samples, encryption: encSeg });
    const regions = regionsOf(idr, nalsInfo, null, enc);
    // первые байты среза: до и после шифрования
    const firstSlice = nalsInfo.find(n => n.slice);
    let hex = '';
    if (firstSlice) {
      let off = 0; for (const n of nalsInfo) { if (n === firstSlice) break; off += n.lengthSize + n.size; }
      const ds = off + firstSlice.lengthSize + firstSlice.slice.dataOffsetInNal;
      hex = `данные слайса IDR с байта ${ds}:\nоткрыто   ${u8hex(idr.subarray(ds, ds + 48))}`;
      if (encIdr) hex += `\ncbcs      ${u8hex(encIdr.subarray(ds, ds + 48))}\n          ^ первые 16 байт зашифрованы, следующие 144 — нет (шаблон 1:9)`;
    }
    return { init, seg, initTree: FJ.mp4.parse(init), segTree: FJ.mp4.parse(seg), frames: frames.map(f => ({ size: f.size, key: f.key })), idr: { len: idr.length, regions }, hex };
  };

  /* ---------- EME + MSE: зашифрованный фильм в <video> ---------- */
  let licRun = 0;
  async function playLicensed(video, logEl, tally, umd, denied) {
    const my = ++licRun;
    const log = [];
    const put = (s) => { log.push(s); logEl.textContent = log.join('\n'); logEl.scrollTop = logEl.scrollHeight; };
    const t0 = performance.now();
    const ts = () => (performance.now() - t0).toFixed(0).padStart(5, ' ') + ' мс  ';
    if (!asset.allReady || asset.mode !== 'webcodecs') { put('Ферма ещё кодирует или WebCodecs нет — подождите.'); return; }
    if (!navigator.requestMediaKeySystemAccess || typeof MediaSource === 'undefined') { put('В этом браузере нет EME или MSE.'); return; }
    const r = P.rung, rg = asset.ladder[r], dc = asset.decoderConfig[r];
    const avcC = dc.description instanceof Uint8Array ? dc.description : new Uint8Array(dc.description.buffer || dc.description);
    const kid = hex2u8(KID), key = hex2u8(KEY), iv = hex2u8(IV);
    const ctx = FJ.h264.makeContext(avcC);
    const mime = `video/mp4; codecs="${dc.codec}"`;
    const b64u = u => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    let mkeys;
    try {
      const acc = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: mime, encryptionScheme: 'cbcs' }] }]);
      mkeys = await acc.createMediaKeys();
      await video.setMediaKeys(mkeys);
      put(ts() + 'requestMediaKeySystemAccess("org.w3.clearkey", cbcs) → есть');
    } catch (e) {
      put('EME недоступен: ' + (e.message || e.name) + '\nЧаще всего его закрывает политика встроенного окна — откройте страницу из репозитория.');
      return;
    }
    video.addEventListener('encrypted', async ev => {
      if (my !== licRun) return;
      put(ts() + `encrypted: initDataType="${ev.initDataType}", pssh ${ev.initData.byteLength} Б (Common PSSH 1077efec…)`);
      const s = mkeys.createSession('temporary');
      s.addEventListener('message', async m => {
        const req = new TextDecoder().decode(m.message);
        put(ts() + 'CDM → сервер лицензий:\n' + JSON.stringify(JSON.parse(req), null, 2));
        if (denied()) { put(ts() + 'сервер лицензий: 403, подписка не найдена → ключа нет'); tally.className = 'tally warn'; umd.textContent = 'waitingforkey · ключа нет'; return; }
        const resp = { keys: [{ kty: 'oct', kid: b64u(kid), k: b64u(key) }], type: 'temporary' };
        put(ts() + 'сервер лицензий → CDM:\n' + JSON.stringify(resp, null, 2).replace(b64u(key), b64u(key).slice(0, 6) + '…ключ…'));
        await s.update(new TextEncoder().encode(JSON.stringify(resp)));
      });
      s.addEventListener('keystatuseschange', () => { s.keyStatuses.forEach((st) => put(ts() + 'статус ключа: ' + st)); });
      await s.generateRequest(ev.initDataType, ev.initData);
    }, { once: true });
    video.addEventListener('waitingforkey', () => { if (my === licRun) put(ts() + 'waitingforkey: кадры зашифрованы, ключа нет — картинка стоит'); }, { once: true });
    video.addEventListener('playing', () => { if (my === licRun) { put(ts() + 'playing: CDM расшифровывает, декодер показывает'); tally.className = 'tally on'; umd.textContent = `${rg.name} · cbcs · Clear Key`; } }, { once: true });

    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
    await new Promise(res => ms.addEventListener('sourceopen', res, { once: true }));
    const sb = ms.addSourceBuffer(mime);
    const append = b => new Promise((ok, bad) => { sb.addEventListener('updateend', ok, { once: true }); sb.addEventListener('error', () => bad(new Error('SourceBuffer')), { once: true }); sb.appendBuffer(b); });
    const init = FJ.mp4.init({ width: rg.w, height: rg.h, timescale: TS, avcC, encryption: { scheme: 'cbcs', kid, constantIV: iv, cryptByteBlock: 1, skipByteBlock: 9, pssh: [{ systemId: '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b' }] } });
    await append(init);
    put(ts() + `init.mp4 ${fmt.bytes(init.length)} → SourceBuffer (encv/sinf/tenc cbcs 1:9 + pssh)`);
    const segOf = async k => {
      const samples = [], subs = [];
      for (let i = k * asset.segFrames; i < (k + 1) * asset.segFrames; i++) {
        const f = asset.frames[r][i];
        const ss = FJ.h264.cbcsSubsamples(f.data, ctx);
        samples.push({ data: (await FJ.mp4.encryptCbcs(f.data, ss, key, iv)).bytes, duration: FD, key: f.key });
        subs.push(ss);
      }
      return FJ.mp4.segment({ sequenceNumber: k + 1, baseMediaDecodeTime: k * asset.segFrames * FD, samples, encryption: { subsamples: subs } });
    };
    const first = 3, last = asset.segCount - 1;
    let next = first;
    const pump = async () => {
      while (my === licRun && next <= last && (sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0) - video.currentTime < 8) {
        const seg = await segOf(next);
        if (my !== licRun) return;
        await append(seg);
        if (next < first + 2) put(ts() + `seg_${String(next + 1).padStart(3, '0')}.m4s ${fmt.bytes(seg.length)} → SourceBuffer (зашифрован)`);
        next++;
      }
      if (next > last && ms.readyState === 'open' && !sb.updating) ms.endOfStream();
    };
    await pump();
    video.currentTime = first * asset.segDur;
    video.ontimeupdate = () => { if (my === licRun) pump(); };
    try { await video.play(); } catch (e) { put('play(): ' + e.message); }
  }

  /* ---------- смещения IDR для I-frame плейлиста ---------- */
  const idrCache = {};
  FJ.pack.idrOffsets = function (r) {
    if (idrCache[r]) return idrCache[r];
    if (!FJ.mp4 || !FJ.mp4.segment || !asset.allReady || asset.mode !== 'webcodecs') return null;
    const offs = [];
    for (let k = 0; k < asset.segCount; k++) {
      const samples = [];
      for (let i = k * asset.segFrames; i < Math.min(asset.frameCount, (k + 1) * asset.segFrames); i++) { const f = asset.frames[r][i]; samples.push({ data: f.data, duration: FD, key: f.key }); }
      const seg = FJ.mp4.segment({ sequenceNumber: k + 1, baseMediaDecodeTime: k * asset.segFrames * FD, samples });
      const tree = FJ.mp4.parse(seg);
      const mdat = tree.find(b => b.type === 'mdat');
      offs.push(mdat ? mdat.start + mdat.headerSize : null);
    }
    idrCache[r] = offs;
    return offs;
  };

  FJ.figure({
    id: 'pack', el: $('#fig-pack'),
    mount,
    start() { refresh(); },
  });
  FJ.pack.state = P;
  FJ.pack.keys = { KID, KEY, IV, hex2u8, u8hex, SYS };
})(window);

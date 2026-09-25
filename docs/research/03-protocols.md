# Исследование: протоколы и спецификации (проверено 2026-09-25)

## HLS — draft-pantos-hls-rfc8216bis-22 (01.05.2026), «Sent to the RFC Editor»
- EXT-X-PART-INF:PART-TARGET обязателен при наличии EXT-X-PART. Длительность части ≤ PART-TARGET и ≥ 85 % (кроме INDEPENDENT/GAP и последней части сегмента).
- EXT-X-PART: URI, DURATION обязательны; INDEPENDENT=YES — SHOULD для частей с независимым кадром.
- EXT-X-PRELOAD-HINT: TYPE (PART/MAP), URI; сервер не отдаёт ни байта части, пока вся часть не может уйти на полной скорости (чтобы ABR честно мерил сеть).
- EXT-X-SERVER-CONTROL: HOLD-BACK ≥ 3 × TD (по умолчанию 3 × TD); **PART-HOLD-BACK ≥ 2 × PART-TARGET (MUST), ≥ 3 × (SHOULD)**; CAN-SKIP-UNTIL ≥ 6 × TD.
- Клиент SHOULD NOT стартовать ближе к концу плейлиста, чем HOLD-BACK / PART-HOLD-BACK.
- `_HLS_msn=M[&_HLS_part=N]` — блокирующая перезагрузка; > 3 TD ожидания → 503.
- Новая часть добавляется в течение одного PART-TARGET; рекомендованный TD — 6 с, GOP 1–2 с.
- SAMPLE-AES в fMP4 = CENC cbcs; SAMPLE-AES-CTR = cenc.
- https://www.ietf.org/archive/id/draft-pantos-hls-rfc8216bis-22.txt

## Apple HLS Authoring Specification (ревизия 2025-06-26)
- H.264 16:9: 416×234 145 · 640×360 365 · 768×432 730 · 768×432 1100 · 960×540 2000 · 1280×720 3000 · 1280×720 4500 · 1920×1080 6000 · 1920×1080 7800 кбит/с.
- HEVC SDR: 640×360 145 … 1920×1080 5800 · 2560×1440 8100 · 3840×2160 11600 · 16800 кбит/с.
- IDR каждые 2 с (SHOULD), каждый сегмент начинается с IDR (MUST); TD SHOULD 6 с.
- AVERAGE-BANDWIDTH обязателен; BANDWIDTH — пиковый битрейт сегментов; VOD: измеренное в пределах ±10 %; пик SHOULD ≤ 200 % среднего.
- I-frame плейлисты MUST существовать.
- LL: PART-TARGET ≥ P95 RTT, рекомендуется 1 с; **PART-HOLD-BACK ≥ 3 × PART-TARGET (MUST у Apple)**.
- CENC-видео — шаблон 1:9; SAMPLE-AES-CTR на устройствах Apple не использовать.
- https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices

## DASH (ISO/IEC 23009-1; схема 6-й редакции — 17.06.2026)
- MPD → Period → AdaptationSet → Representation; SegmentTemplate ($Number$/$Time$), SegmentTimeline.
- Live: availabilityStartTime, timeShiftBufferDepth, minimumUpdatePeriod, suggestedPresentationDelay.
- LL-DASH (DASH-IF): ServiceDescription/Latency@target (мс), availabilityTimeOffset > 0, availabilityTimeComplete="false", chunked transfer; ProducerReferenceTime.

## CMAF (ISO/IEC 23000-19:2024)
- Заголовок: ftyp + moov (mvex). Чанк: moof + mdat (опц. styp, prft, emsg). Фрагмент начинается с SAP.
- styp-бренды: cmfs, cmff, cmfl, lmsg.
- Замер: 2-секундный сегмент 30 fps (60 сэмплов) — moof 1048 байт (trun 980, 16 байт на сэмпл); ≈ 88 + 16 × N байт.

## Common Encryption (ISO/IEC 23001-7:2023)
- Схемы: cenc (AES-CTR), cbc1, cens, cbcs (AES-CBC, шаблон), sve1.
- Шаблон 1:9 (crypt 1 блок по 16 байт, skip 9) рекомендован для видео и обязателен у Apple. Неполный хвостовой блок остаётся открытым. cbcs — константный IV в tenc.
- В CMAF защищённые данные cbcs начинаются с первого байта после заголовка слайса (Shaka Packager).
- senc: subsample_count, BytesOfClearData (uint16), BytesOfProtectedData (uint32); длина NAL и байт типа — открыты.
- Боксы: pssh, schm, tenc (init); senc, saiz, saio (фрагмент).
- Widevine L1 — всё в TEE; L3 — программный базовый уровень. PlayReady SL150 / SL2000 / SL3000 (аппаратный TEE).
- EME: com.widevine.alpha (SW_SECURE_CRYPTO … HW_SECURE_ALL), com.microsoft.playready.recommendation(.3000), com.apple.fps.

## CMCD (CTA-5004, v1 2020; v2 = CTA-5004-A, 02.2026)
- v1: br, bl, bs, cid, d, dl, mtp, nor, nrr, ot, pr, rtp, sf, sid, st, su, tb, v. Заголовки CMCD-Object/Request/Session/Status. В браузерах — query-аргумент (без CORS preflight), ключи по алфавиту.
- v2: режим событий, `ltc` (задержка), `msd` (задержка старта), `sta` (состояние), `dfa` (выпавшие кадры), `ttfb`, `ttlb`, `st=ll`.
- CMSD (CTA-5006, 2022): CMSD-Static / CMSD-Dynamic от CDN к плееру.

## MoQ
- draft-ietf-moq-transport-21 (08.09.2026). Pub/sub поверх QUIC/WebTransport; track → group (точка входа, обычно ключевой кадр) → object (кадр).
- Cloudflare: релеи в 330+ городах (08.2025), API (07.2026). OpenMOQ: Akamai, CDN77, Cisco, Oracle, YouTube и др.
- Поддержка: WebTransport — Chrome 97, Firefox 114, Safari 26.4; WebCodecs video — Chrome 94, Firefox 130, Safari 16.4.

## Задержка
- Обычный HLS: ≈ HOLD-BACK (3 × TD) + до 1 TD + кодирование/CDN → 6 с сегменты: ~18–24 с+; 2 с: ~6–8 с+.
- LL-HLS: цель Apple — 1–2 с (WWDC19), на практике 2–6 с.
- LL-DASH: 2–10 с, пример DASH-IF — 3,5 с.
- WebRTC: < 500 мс (Cloudflare Stream).
- Эфирное ТВ: BBC — от ~3 до почти 6 с; большинство измерений 3–10 с.

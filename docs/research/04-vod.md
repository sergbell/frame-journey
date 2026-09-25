# Исследование: специфика VOD (проверено 2026-09-25)

## Мастера
- Netflix Branded IMF: App #2E (SMPTE ST 2067-21); UHD JPEG 2000 ≤ 30 fps — «max 800 Mbit/s», > 30 fps — 1600; HD — 400 / 800 Мбит/с. Dolby Vision P3-D65 PQ 12 бит. **Одна секунда чёрного и тишины в начале и конце; никаких полос и слейтов.** https://studiopartner.netflix.net/studio/branded-imf-delivery-specifications
- Netflix Non-Branded v9.3 (09.2023): IMF App 2E или ProRes 422 HQ (iTunes); «Up-resing of content is prohibited».
- Apple ProRes (04.2022), 24p: 1080p 422 HQ 176 Мбит/с (79 ГБ/ч), 4444 XQ 396; 2160p 422 HQ 707 (318 ГБ/ч), 4444 XQ 1591 (716 ГБ/ч). https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf
- IMF (SMPTE ST 2067): «file-based framework for the exchange and processing of multiple content versions».

## Тестовый контент
- Netflix Open Content (CC BY 4.0): El Fuente (2013), Chimera (2014, повтор «кодек-убийцы» из House of Cards), Meridian (2016, Dolby Vision, 4000 нит, «grainy footage with lots of noise… smoke, fog»), Sparks (2017), Nocturne (2018, 120 fps). https://opencontent.netflix.com · https://netflixtechblog.com/engineers-making-movies-aka-open-source-test-content-f21363ea3781
- Sparks: 1080p H.264 — 12 568 кбит/с для VMAF 91,47; BoJack Horseman — VMAF 91,10 при 1 673 кбит/с.

## Защита
- MovieLabs ECP v1.4 (08.2024): AES-128+, TEE («secure processing environment isolated by hardware»), аппаратный корень доверия, HDCP 2.2 для UHD, криминалистические водяные знаки на сервере и/или клиенте, контент на CDN и ключи на сервере лицензий — не раньше чем за два дня до релиза. https://movielabs.com/ngvideo/MovieLabs_ECP_Spec_v1.4.pdf
- Widevine: L3 на Android — «DEVICE_IS_PROVISIONED_SD_ONLY» (Classic); HD/UHD — только L1 (Patat et al., 2022). Netflix в Chrome: до 1080p на macOS/Linux, до 2160p на Windows с подходящим железом — «L3 = SD» это политика сервиса.
- Netflix: 4K/HDR требует HDCP 2.2; рекомендуемые скорости: 720p 3, 1080p 5, 4K 15 Мбит/с. https://help.netflix.com/en/node/306

## A/B-водяные знаки
- ETSI TS 104 002 V1.1.1 (08.2023) «DASH-IF Forensic A/B Watermarking»: каждый сегмент в двух вариантах (бит 0/1); edge CDN собирает последовательность по подписанному WM-токену (CWT, RFC 8392); WMPaceInfo задаёт позицию бита. https://www.etsi.org/deliver/etsi_ts/104000_104099/104002/01.01.01_60/ts_104002v010101p.pdf
- UHD Forum Watermarking API for Encoder Integration (2021): ContentArmor, Irdeto, NexGuard, Verimatrix.

## Популярность и кэш
- Yu et al., EuroSys 2006: 10 % самых популярных объектов ≈ 60 % обращений, 23 % ≈ 80 %.
- Cha et al., IMC 2007: 10 % видео ≈ 80 % просмотров.
- Fricker, Robert, Roberts 2012: Zipf α часто ≈ 0,8. Че: h(n) ≈ 1 − e^(−q(n)·t_C), Σ(1 − e^(−q(n)·t_C)) = C.
- Open Connect: окно заливки по умолчанию 02:00–14:00 местного времени; порядок: peer → tier → S3 (Fill patterns). Популярность = байты / размер ассета; популярное — на быстрых серверах, хвост — на 200 ТБ+ хранилищах; эпизод The Crown ≈ 1200 файлов (2017). https://netflixtechblog.com/content-popularity-for-open-connect-b86d56f613b

## Суточный трафик
- DE-CIX: пик 26,99 Тбит/с 09.12.2025 в 20:11 CET (игровой день Лиги чемпионов). https://www.de-cix.net/en/about-de-cix/media/press-releases/de-cix-global-data-traffic-volume-hits-record-breaking-79-exabytes-at-internet-exchanges-in-2025
- MSK-IX: пик 2025 г. 8,54 Тбит/с; DATAIX — 10,5 Тбит/с. https://www.comnews.ru/content/243781/2026-02-12/2026-w07/1008/dataix-msk-ix-i-piter-ix-podveli-itogi-2025-g

## QoE
- Conviva State of Streaming Q2 2022: старт 4,62 с (мир), отказы старта 0,94 %, буферизация 0,22 %; по устройствам: Apple TV 2,89 с, Roku 3,09 с, **LG TV 7,33 с**. https://www.conviva.ai/wp-content/uploads/2022/09/Q2-SoS.pdf
- Krishnan & Sitaraman: «viewers start to abandon a video if it takes more than 2 seconds to start up, with each incremental delay of 1 second resulting in a 5.8% increase in the abandonment rate».

## Браузеры
- Chromium demuxer_memory_limit: по умолчанию 150 МиБ видео / 12 МиБ аудио; low-end 30/2; Android Go 15/1. Firefox 100/15, Safari 290/14 (Chrome Developers blog). https://github.com/chromium/chromium/blob/main/media/base/demuxer_memory_limit.h
- WebCodecs video: Chrome 94, Firefox 130 (десктоп), Safari 16.4.

## Конвенции
- SMPTE-полосы: яркость (BT.709, 75 %) 0,750 · 0,696 · 0,591 · 0,536 · 0,214 · 0,159 · 0,054 — «лестница вниз».
- Universal Leader: 8…2, на «2» — однокадровый 1 кГц (2-pop), затем 47 кадров чёрного: ровно 2 с до первого кадра действия.
- Тон: SMPTE RP 155 −20 dBFS; EBU R68 −18 dBFS.

## Кодирование Netflix
- 2015: куски кодируются параллельно и склеиваются; тайтл — «несколько часов» вместо «дней». Cosmos (2021): кодирование, разрезанное на 31 кусок, — 31 параллельная функция, 8 минут.

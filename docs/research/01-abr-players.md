# Исследование: ABR и плееры (проверено по исходникам и статьям, 2026-09-25)

Коммиты: hls.js master c721313 (v1.7.3), dash.js development acddd0c (5.2.x), Shaka main a8cded8, Media3 release 8c6678b (1.11.1).

## hls.js
- Defaults (src/config.ts L505–516): abrEwmaFastLive 3, abrEwmaSlowLive 9, abrEwmaFastVoD 3, abrEwmaSlowVoD 9, abrEwmaDefaultEstimate 5e5 (500 кбит/с), abrEwmaDefaultEstimateMax 5e6, abrBandWidthFactor 0.95, abrBandWidthUpFactor 0.7, abrMaxWithRealBitrate false, maxStarvationDelay 4, maxLoadingDelay 4.
- EWMA (src/utils/ewma.ts): alpha = exp(ln 0.5 / halfLife); adjAlpha = alpha^weight; est = v(1−adjAlpha) + adjAlpha·est; getEstimate = est / (1 − alpha^totalWeight). Вес = длительность загрузки в секундах (минимум min(50 мс, bytes/100000)). Значение = 8·bytes/duration. Длительность = конец загрузки/разбора − начало запроса − min(TTFB, оценка TTFB).
- Оценка = min(fast, slow): «вниз быстро, вверх медленно». Дефолт используется, пока суммарный вес fast < 0.001.
- findBestLevel: перебор сверху вниз; бюджет 0.95·оценки для текущего и ниже, 0.7·оценки для ступеней выше последней загруженной; время загрузки = TTFB + bitrate·avgFragDur/budget; принять, если fetchTime < buffer/playbackRate + maxStarvationDelay (сначала с 0, потом с min(fragDur, 4 с)). Для live проверка времени пропускается.
- Аварийный обрыв: таймер 100 мс во время загрузки; если фрагмент не успевает до опустошения буфера — переключение вниз и возможный abort.
- Источник: https://github.com/video-dev/hls.js/blob/c721313f028431b107e4a77edf40bb908f8d782c/src/controller/abr-controller.ts

## dash.js v5
- Стратегия по умолчанию — «dynamic»: ThroughputRule, пока буфер < 12 с (hybridSwitchBufferTime), затем BOLA; обратно при буфере < 6 с (AbrController.js L993–1001).
- ThroughputRule: максимальная ступень ≤ 0.9 × пропускная способность (bandwidthSafetyFactor 0.9). EWMA throughput: half-life slow 8, fast 3 при весе 0.0015 × время загрузки в мс → эффективно 2 с и 5,33 с; оценка = min(fast, slow).
- bufferTimeDefault 18 с. InsufficientBufferRule: пустой буфер → нижняя ступень, иначе cap = 0.7 × throughput × buffer / fragDur.
- BolaRule: MINIMUM_BUFFER_S = 10, MINIMUM_BUFFER_PER_BITRATE_LEVEL_S = 2, PLACEHOLDER_BUFFER_DECAY = 0.99.
  - utilities = ln(bitrate), нормированы: u_i − u_0 + 1.
  - bufferTime = max(bufferTimeDefault, 10 + 2·N).
  - gp = (u_max − 1) / (bufferTime/10 − 1); Vp = 10 / gp.
  - Выбор: max по i от (Vp·(u_i − 1 + gp) − (buffer + placeholder)) / bitrate_i; при равенстве — выше.
  - BOLA-O: подъём ограничен выбором по безопасной пропускной способности, но не ниже текущей ступени.
  - Пример для {300, 750, 1200, 1850, 2850, 4300}: bufferTime 22 с, gp 2,2188, Vp 4,5069; подъёмы при 7,25 / 10,60 / 12,65 / 14,60 / 16,51 с.
- Low-latency правила (выкл.): L2A-LL (Karagkioules et al., MMSys'20), LoL+ (Bentaleb et al., IEEE TMM).
- Источник: https://github.com/Dash-Industry-Forum/dash.js/blob/acddd0cfee4189d4249026937117eb8c80be619a/src/streaming/rules/abr/BolaRule.js

## Shaka Player
- defaultBandwidthEstimate 1e6; switchInterval 8 с; bandwidthUpgradeTarget 0.85; bandwidthDowngradeTarget 0.95; fastHalfLife 2, slowHalfLife 5; minTotalBytes 128e3, minBytes 16e3; cacheLoadThreshold 5 мс; дефолт = navigator.connection.downlink, если есть.
- Итог эквивалентен «максимальный вариант ≤ 0.95 × оценки», стабильность — только от switchInterval 8 с.

## ExoPlayer / Media3 AdaptiveTrackSelection
- bandwidthFraction 0.7; minDurationForQualityIncreaseMs 10 000; maxDurationForQualityDecreaseMs 25 000; minDurationToRetainAfterDiscardMs 25 000.
- DefaultBandwidthMeter: скользящая взвешенная медиана (вес √bytes, окно 2000), обновление после ≥ 2000 мс передачи или ≥ 512 КиБ; стартовые оценки по стране и типу сети, запасная 1 Мбит/с.

## Статьи
- **BBA** — Huang, Johari, McKeown, Trunnell, Watson, SIGCOMM'14 (Netflix). Буфер 240 с, чанки 4 с. BBA-0: резервуар 90 с, подушка 126 с. Две A/B-проверки по > 500 тыс. пользователей. На 10–20 % меньше ребуферизаций при сопоставимом битрейте. http://yuba.stanford.edu/~nickm/papers/sigcomm2014-video.pdf
- **BOLA** — Spiteri, Urgaonkar, Sitaraman, INFOCOM 2016. Цель: max ῡ + γs̄ при Q ≤ Qmax, Ляпунов (drift-plus-penalty). Правило: max (V·υ_m + V·γp − Q)/S_m, υ_m = ln(S_m/S_1). 84–95 % от офлайн-оптимума. https://arxiv.org/abs/1601.06748
- **MPC/RobustMPC** — Yin, Jindal, Sekar, Sinopoli, SIGCOMM'15. QoE = Σq(R_k) − λΣ|Δq| − μΣ rebuffer − μs·Ts, λ = 1, μ = μs = 3000 (q в кбит/с). Горизонт 5, прогноз — гармоническое среднее 5 последних; Robust: Ĉ/(1 + max ошибка за 5). https://conferences.sigcomm.org/sigcomm/2015/pdf/papers/p325.pdf
- **Pensieve** — Mao, Netravali, Alizadeh, SIGCOMM'17. QoE_lin: q = R (Мбит/с), μ = 4,3. Лесенка {300, 750, 1200, 1850, 2850, 4300}. +12–25 % QoE. https://people.csail.mit.edu/hongzi/content/publications/Pensieve-Sigcomm17.pdf
- **Puffer/Fugu** — Yan et al., NSDI'20. 38,6 года видео, 63 508 пользователей. Stall ratio: Fugu 0,13 %, MPC-HM 0,22 %, BBA 0,19 %, Pensieve 0,17 %, RobustMPC-HM 0,12 %. Простой BBA «surprisingly well»; только у 4 % потоков были остановки; пути < 6 Мбит/с — 14 % времени, но 83 % остановок. https://www.usenix.org/system/files/nsdi20-paper-yan.pdf
- **Dobrian et al.**, SIGCOMM'11: +1 % буферизации → более 3 минут меньше просмотра 90-минутного эфира. https://conferences.sigcomm.org/sigcomm/2011/papers/sigcomm/p362.pdf
- **Krishnan & Sitaraman**, IMC'12 (23 млн просмотров, Akamai): зрители начинают уходить после ~2 с задержки старта; каждая следующая секунда — +5,8 % ухода; ребуферизация ≥ 1 % → на 5,02 % меньше просмотрено. https://people.cs.umass.edu/~ramesh/Site/PUBLICATIONS_files/imc208-krishnan.pdf

## Трассы
- Norway HSDPA (Riiser et al., MMSys'13): 86 логов, 31,2 ч; посекундная медиана 0,98 Мбит/с (p5 0,055; p95 3,15; max 8,95).
- Belgium 4G/LTE (van der Hooft et al., 2016): 40 логов ~5 ч; медиана 28,8 Мбит/с (p5 5,0; p95 58,8).
- FCC MBA: в Pensieve отфильтрованы среднее < 6 Мбит/с, минимум > 0,2 Мбит/с.

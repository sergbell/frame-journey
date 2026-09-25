# Исследование: факты индустрии (проверено 2026-09-25)

## Netflix: кодирование
- **Per-title** (Netflix Tech Blog, 14.12.2015): фиксированная лесенка H.264 с 2010 г.: 235/320×240, 375/384×288, 560 и 750/512×384, 1050/640×480, 1750/720×480, 2350 и 3000/1280×720, 4300 и 5800/1920×1080. Пробные кодирования, выпуклая оболочка («Pareto-efficient frontier»). BoJack Horseman: 1080p при 1540 кбит/с (фиксированная давала только 480p при 1750). Orange Is the New Black: верх 4640 вместо 5800 (−20 %). https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2
- **Dynamic Optimizer** (05.03.2018): каждый план — свои оболочки VMAF, сборка с равным наклоном (trellis). На 10 тайтлах VP9 ~256 кбит/с: −17,1 % по VMAF, −22,5 % по PSNR против лучшего фикс-QP; 28–38 % BD-rate для x264/x265/libvpx. https://netflixtechblog.com/dynamic-optimizer-a-perceptual-video-encoding-optimization-framework-e19f1e3a277f
- **Shot-based в продакшне** (09.03.2018): серия Stranger Things — ~900 планов (в среднем 4 с) вместо 20 кусков по 3 мин. https://netflixtechblog.com/optimized-shot-based-encodes-now-streaming-4b9464204830
- **4K** (28.08.2020): старые ступени 8/10/12/16 Мбит/с; оптимизация: −50 % BD-rate, средний верх 8 вместо 16 Мбит/с, ребуферизаций/час −65 %, время старта −10 %. https://netflixtechblog.com/optimized-shot-based-encodes-for-4k-now-streaming-47b516b10bbb
- **VMAF** (06.06.2016): SVR над VIF (4 масштаба), DLM (ADM) и motion; шкала 0–100; Emmy (объявлено 25.01.2021). VMAF v1 (20.06.2026): дистанции 1080p 3H, телефон 5H, 4K 1,5H/3H; CAMBI (бандинг). https://netflixtechblog.com/toward-a-practical-perceptual-video-quality-metric-653f208b9652 · https://netflixtechblog.com/vmaf-v1-good-is-not-good-enough-60d7e4244ea8
- **AV1 ≈ 30 % просмотра Netflix** (01.12.2025): VMAF +4,3 к AVC и +0,9 к HEVC, ~⅓ меньше трафика, на 45 % меньше прерываний буферизации; 88 % больших экранов, сертифицированных в 2021–2025, поддерживают AV1. https://netflixtechblog.com/av1-now-powering-30-of-netflix-streaming-02f592242d80
- **Синтез зерна AV1** (02.07.2025): пример 8274 → 2804 кбит/с (−66 %); ~300 тайтлов: −36 % битрейта от 1080p; A/B: ребуферизаций −10 %, задержка старта −10 %. https://netflixtechblog.com/av1-scale-film-grain-synthesis-the-awakening-ee09cfdff40b
- **Live Netflix** (15.07.2025): AVC и HEVC, сегменты 2 с, два региона AWS, «epoch locking» (ISO/IEC 23009-9). https://netflixtechblog.com/behind-the-streams-live-at-netflix-part-1-d23f917c2f40

## Open Connect
- «18K+ серверов в 6K+ точках», > 1000 провайдеров со встроенными серверами; «close to 95 %» через прямые подключения (2018). https://openconnect.netflix.com/en/ · https://blog.apnic.net/2018/06/20/netflix-content-distribution-through-open-connect/
- Предзаливка по прогнозу популярности в окно вне пика; steering-сервис в AWS. https://openconnect.netflix.com/Open-Connect-Overview.pdf
- Сервер: почти 800 Гбит/с TLS-трафика с одной машины (EuroBSDCon 2022, Drew Gallatin); 400 Гбит/с (2021); kTLS, NIC TLS offload. https://papers.freebsd.org/2022/eurobsdcon/gallatin-the_other_freebsd_optimizations-netflix/
- Хранилище (2026): 2U, до 120 ТБ NVMe, ~200 Гбит/с. https://openconnect.netflix.com/en/appliances/

## Рекорды эфиров
- Netflix, Пол — Тайсон (15.11.2024): 65 млн одновременных потоков в пике; ~90 тыс. жалоб в Downdetector. http://about.netflix.com/en/news/jake-paul-vs-mike-tyson-over-108-million-live-global-viewers
- JioHotstar, финал T20 World Cup (08.03.2026): 72,5 млн одновременных потоков — «новый мировой рекорд». https://www.ril.com/ar2025-26/media-and-entertainment.html
- Hotstar: 25,3 млн (2019), пик 5,7 Тбит/с и 1 млн запросов/с (2018), «panic mode». https://d1.awsstatic.com/events/reinvent/2019/Scaling_Hotstar.com_for_25_million_concurrent_viewers_CMY302.pdf
- **Okko, финал Лиги чемпионов (30.05.2026): > 4,5 млн зрителей трансляции, > 1 млн входов на старте, пик 7,8 Тбит/с на собственной CDN, > 10 Тбит/с вместе с внешними CDN.** https://www.gazeta.press/sport/news/2026/06/08/28645921.shtml
- VK Видео: рекорд 1,3 млн одновременно (2025). https://vk.company/ru/press/releases/12183/

## Сбои на масштабе
- Netflix Live Origin (15.12.2025): CDN отвергает запросы вне допустимого окна; 404 на ещё не вышедший сегмент кэшируется до времени публикации; запрос следующего сегмента держится открытым до публикации; миллисекундный TTL в nginx; при стрессе 503 с max-age=5 с. https://netflixtechblog.com/netflix-live-origin-41f1b0ad5371
- Netflix (15.07.2025): перезапуски после сбоев всего в 30 с дали 10-кратный рост нагрузки; сервер говорит клиентам, сколько ждать перед повтором. 
- nginx: proxy_cache_lock по умолчанию выключен; proxy_cache_lock_timeout 5 с — дольше 2-секундного сегмента. https://nginx.org/en/docs/http/ngx_http_proxy_module.html

## Кодеки
- HEVC к AVC: −59 % при равном субъективном качестве (PSNR показывает лишь −44 %). Tan et al., IEEE TCSVT 2016.
- VVC к HEVC: ~46 % (UHD), ~50 % (HD), ~49 % (HDR) — JVET, 2020–2021.
- AV2: спецификация 1.0.0 от 28.05.2026, выпуск 09.06.2026; AOMedia заявляет ~30 % к AV1. http://aomedia.org/press%20releases/Alliance-for-Open-Media-Releases-AV2-Codec/
- Argos VCU (ASPLOS'21): 20–33× производительности на стоимость для VP9 против CPU.

## Трафик
- Ericsson Mobility Report (06.2026): на конец 2025 г. видео ≈ 75 % мобильного трафика.
- Sandvine GIPR 2024: on-demand streaming — 54 % нисходящего трафика (по содержимому).

## Российский рынок (TelecomDaily, 2025)
- Выручка онлайн-кинотеатров 178,2 млрд ₽ (+45 %); доли: Кинопоиск 32,7 %, Okko 15,1 %, Wink 14,7 %, Иви 14,5 %, Kion 7,2 %. https://habr.com/ru/news/1005926/
- Платные подписки: Кинопоиск 14 млн, Okko 10,1 млн, Wink 7,7 млн (оценки TelecomDaily, оспариваются). https://www.kinometro.ru/news/show/name/russtreamings_stats_2025_03022026

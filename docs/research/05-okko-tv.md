# Исследование: Okko и смарт-ТВ (проверено 2026-09-25)

## Okko
- С 2022 г. юридически не часть Сбера (продан «Новым возможностям», затем владелец — CEO Сергей Шишкин); входит в подписку СберПрайм. https://www.kommersant.ru/doc/5678806 · CTO — Иван Карев (CNews, 09.06.2026).
- TelecomDaily 2025: 13,8 млн пользователей, 10,1 млн платящих (№ 2 после Кинопоиска). Доля выручки дистрибуции 15,1 % (2-е место).
- Права: Лига чемпионов/Лига Европы/Лига конференций (с 2024/25), Бундеслига (2025/26–2028/29), ОИ‑2026. **РПЛ у Okko нет** (права у «Матч ТВ» до 2029/30).
- 2014: UHD 4K на Smart TV (HEVC + MPEG-DASH); «больше 90 % выручки — Smart TV» (Ведомости, 05.09.2014). 2017: первый в РФ легальный VOD с Dolby Atmos. 2025: ЛЧ в вебе 1080p50.
- Стек 2020 (интервью CTO, Хабр/RUVDS, 20.06.2020): DASH+CENC — браузеры и Samsung/LG после 2014; Smooth Streaming+PlayReady — старые ТВ; HLS+FairPlay — Safari; DASH+Widevine — Android; Widevine Classic — старые LG; **свой модуль Nginx на лету переписывал манифесты под старые платформы**; H.264 и H.265; 4K — HEVC + аппаратный DRM + HDCP. https://habr.com/ru/companies/ruvds/articles/507364/
- Хабр, 13.08.2026 (перестройка платформы): плеер — SDK на платформу; ТВ — самое сложное (старые ОС, не обновляемые модели); транскодер переписан на микросервисы; «новый кодек» — ~−10 % трафика; цель — минута исходника в 3 качества за минуту; QoE: старт, ошибки, остановки, переключения — единые события на всех платформах. https://habr.com/ru/companies/okko/articles/1069762/
- OkkoCDN: 3,5 Тбит/с (обзор 2024); финал ЛЧ 30.05.2026 — 7,8 Тбит/с на OkkoCDN, > 10 Тбит/с с внешними CDN, > 1 млн авторизаций на старте. ОИ‑2026: > 1,5 млн одновременно в пике, ~8 млн зрителей, резерв в Cloud.ru под всплески 3–5×. https://www.cnews.ru/news/line/2026-02-27_okko_ispolzoval_oblachnye · https://www.cnews.ru/news/line/2026-06-09_okko_ispolzoval_oblachnye
- Доклады: VideoTech 2023 — «Ускорение первого кадра в сценарии вьюпорта» (Животворев, Соколов) https://vtconf.com/en/archive/2023/talks/20003064-acceleration-of-the-first-frame-in-a-viewport-scenario-technical-and-visual-on-the-product-side/ ; HolyJS 2023 — «Один плеер для Smart TV и web»; linkmeup 2024 — «Как устроен кеш-сервер в OkkoCDN»; VideoTech 2024 — тестирование стриминга на Smart TV (приложение ТВ — веб на «очень старых браузерах»).
- Платформы: Samsung (2010+), LG (2012+), Philips, Sony, Panasonic, Hisense, Huawei Vision, Android TV, Yandex TV, Salute TV, Xbox. Okko Smart Box (2020): Amlogic S905Y2, 2 ГБ.

## Рынок ТВ-ОС в РФ (продажи, М.Видео-Эльдорадо, 2025)
Android/Google TV ≈ 44–46 %, YaOS 15–16 %, VIDAA 8 %, Salute TV 7 % (11 % в янв.–апр. 2026), Tizen 5 %, webOS 5 %. Samsung и LG остановили поставки в марте 2022. ~54 млн подключённых ТВ на конец 2024.

## Движки ТВ
- webOS: 3.0 (2016) Chromium 38 · 4.0 (2018) Ch 53 · 5.0 (2020) Ch 68 · 6.0 (2021) Ch 79 · 22 Ch 87 · 23 Ch 94 · 24 Ch 108 · 25 Ch 120 · 26 Ch 132. Полный W3C MSE/EME — с webOS 5; AV1 — с webOS 5. https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine
- Tizen: 2015 (2.3) WebKit · 2017 (3.0) M47 · 2018 (4.0) M56 · 2019 (5.0) M63 · 2020 (5.5) M69 · 2021 (6.0) M76 · 2022 (6.5) M85 · 2023 (7.0) M94 · 2024 (8.0) M108 · 2025 (9.0) M120 · 2026 (10.0) M130. cbcs — с 2019, CMAF — с 2020; AV1 — с 2020 (UHD), 2021 (все). Нет Dolby Vision. https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html

## Ограничения
- Samsung AVPlay: буфер по умолчанию 10 с или 15 МБ; 4K — SET_MODE_4K; нет getVideoPlaybackQuality; рекомендуемые битрейты 4K 15/10, FHD 5/3, HD 1,5 Мбит/с; live-сегменты ≤ 2 с. https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html
- LG: память приложения < 250 МБ; webOS 4 — паузы сборки мусора в MSE (hls.js, dash.js, Shaka).
- Bitmovin: буфер 30 с вперёд / 10 с назад; **Tizen 2016 не переваривает BaseMediaDecodeTime > 2³²**. https://developer.bitmovin.com/playback/docs/smart-tvs-configuration-and-best-practices
- Chromium: 150 МБ видео / 12 МБ аудио; low-end 30 / 2.

## Дистанция
- ITU-R BT.2022: пиксель = 1′ → 1080p на 3,2H (31°), 4K на 1,6H (58°), 8K на 0,8H (96°). https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2022-0-201208-W!!PDF-E.pdf
- VMAF по умолчанию: 1080p на 3H, «60 pixels/degree»; 4K-модель — 1,5H. https://github.com/Netflix/vmaf/blob/master/resource/doc/faq.md
- Кембридж (27.10.2025): предел глаза ~94 ppd (ахроматическое); на 2,5 м 44″ 4K не лучше QHD. https://www.cam.ac.uk/research/news/is-your-ultra-hd-tv-worth-it-scientists-measure-the-resolution-limit-of-the-human-eye
- Conviva Q2 2022: старт LG TV 7,33 с против Apple TV 2,89 с.

## Не использовать без проверки
- Долю ТВ в просмотрах Okko после 2018 (нет официальных данных); MSU 2025 VOD comparison — не цитировать в негативном ключе.

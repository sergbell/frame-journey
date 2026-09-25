/* =====================================================================
   02-sources — реестр источников. FJ.cite('key') даёт ссылку-сноску,
   список в подвале нумеруется в порядке первого упоминания.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const S = {
    'hls': ['R. Pantos. HTTP Live Streaming 2nd Edition, draft-pantos-hls-rfc8216bis-22, 01.05.2026', 'https://www.ietf.org/archive/id/draft-pantos-hls-rfc8216bis-22.txt'],
    'apple-auth': ['Apple. HLS Authoring Specification for Apple Devices (ревизия 26.06.2025)', 'https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices'],
    'apple-ll': ['Apple. Enabling Low-Latency HTTP Live Streaming', 'https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls'],
    'dashif-ll': ['DASH-IF. Low-latency Modes for DASH, Change Request r8 (27.03.2020; вошёл в IOP v5, часть 4)', 'https://dashif.org/docs/CR-Low-Latency-Live-r8.pdf'],
    'dashif-timing': ['DASH-IF. Timing Model for DASH', 'https://dashif.org/Guidelines-TimingModel/'],
    'dashif-iop6': ['DASH-IF IOP v5.1, часть 6: Content Protection', 'https://github.com/user-attachments/files/24056674/DASH-IF-IOPv5.1.0-Part6.pdf'],
    'shaka-subsample': ['Shaka Packager: subsample_generator.cc — границы защищённых байтов cbcs', 'https://github.com/shaka-project/shaka-packager/blob/main/packager/media/crypto/subsample_generator.cc'],
    'cmcd': ['CTA-5004. Common Media Client Data (CMCD)', 'https://web.archive.org/web/2022/https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf'],
    'cmcd-b': ['CTA-5004-B. Common Media Client Data, версия 2 (04.2026)', 'https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-b.html'],
    'moq': ['IETF. Media over QUIC Transport, draft-ietf-moq-transport-21 (08.09.2026)', 'https://datatracker.ietf.org/doc/draft-ietf-moq-transport/'],
    'cf-moq': ['Cloudflare. MoQ: refactoring the internet’s real-time media stack (22.08.2025)', 'https://blog.cloudflare.com/moq/'],
    'bba': ['T.-Y. Huang et al. A Buffer-Based Approach to Rate Adaptation: Evidence from a Large Video Streaming Service. SIGCOMM 2014', 'http://yuba.stanford.edu/~nickm/papers/sigcomm2014-video.pdf'],
    'bola': ['K. Spiteri, R. Urgaonkar, R. Sitaraman. BOLA: Near-Optimal Bitrate Adaptation for Online Videos. INFOCOM 2016', 'https://arxiv.org/abs/1601.06748'],
    'mpc': ['X. Yin et al. A Control-Theoretic Approach for Dynamic Adaptive Video Streaming over HTTP. SIGCOMM 2015', 'https://conferences.sigcomm.org/sigcomm/2015/pdf/papers/p325.pdf'],
    'pensieve': ['H. Mao, R. Netravali, M. Alizadeh. Neural Adaptive Video Streaming with Pensieve. SIGCOMM 2017', 'https://people.csail.mit.edu/hongzi/content/publications/Pensieve-Sigcomm17.pdf'],
    'puffer': ['F. Y. Yan et al. Learning in situ: a randomized experiment in video streaming. NSDI 2020', 'https://www.usenix.org/system/files/nsdi20-paper-yan.pdf'],
    'dobrian': ['F. Dobrian et al. Understanding the Impact of Video Quality on User Engagement. SIGCOMM 2011', 'https://conferences.sigcomm.org/sigcomm/2011/papers/sigcomm/p362.pdf'],
    'krishnan': ['S. S. Krishnan, R. K. Sitaraman. Video Stream Quality Impacts Viewer Behavior. IMC 2012', 'https://people.cs.umass.edu/~ramesh/Site/PUBLICATIONS_files/imc208-krishnan.pdf'],
    'riiser': ['H. Riiser et al. Commute Path Bandwidth Traces from 3G Networks. MMSys 2013', 'https://dl.acm.org/doi/10.1145/2483977.2483991'],
    'hlsjs': ['hls.js: abr-controller.ts и config.ts (коммит c721313, 23.09.2026)', 'https://github.com/video-dev/hls.js/blob/c721313f028431b107e4a77edf40bb908f8d782c/src/controller/abr-controller.ts'],
    'dashjs': ['dash.js: BolaRule.js и AbrController.js (коммит acddd0c)', 'https://github.com/Dash-Industry-Forum/dash.js/blob/acddd0cfee4189d4249026937117eb8c80be619a/src/streaming/rules/abr/BolaRule.js'],
    'nf-pertitle': ['Netflix Tech Blog. Per-Title Encode Optimization (14.12.2015)', 'https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2'],
    'nf-dynopt': ['Netflix Tech Blog. Dynamic optimizer — a perceptual video encoding optimization framework (05.03.2018)', 'https://netflixtechblog.com/dynamic-optimizer-a-perceptual-video-encoding-optimization-framework-e19f1e3a277f'],
    'nf-shots': ['Netflix Tech Blog. Optimized shot-based encodes: now streaming! (09.03.2018)', 'https://netflixtechblog.com/optimized-shot-based-encodes-now-streaming-4b9464204830'],
    'nf-4k': ['Netflix Tech Blog. Optimized shot-based encodes for 4K: now streaming! (28.08.2020)', 'https://netflixtechblog.com/optimized-shot-based-encodes-for-4k-now-streaming-47b516b10bbb'],
    'nf-vmaf': ['Netflix Tech Blog. Toward A Practical Perceptual Video Quality Metric (06.06.2016)', 'https://netflixtechblog.com/toward-a-practical-perceptual-video-quality-metric-653f208b9652'],
    'nf-vmafv1': ['Netflix Tech Blog. VMAF v1: good is not good enough (20.06.2026)', 'https://netflixtechblog.com/vmaf-v1-good-is-not-good-enough-60d7e4244ea8'],
    'nf-av1': ['Netflix Tech Blog. AV1 — now powering 30% of Netflix streaming (01.12.2025)', 'https://netflixtechblog.com/av1-now-powering-30-of-netflix-streaming-02f592242d80'],
    'nf-fgs': ['Netflix Tech Blog. AV1 @ Scale: Film Grain Synthesis, The Awakening (02.07.2025)', 'https://netflixtechblog.com/av1-scale-film-grain-synthesis-the-awakening-ee09cfdff40b'],
    'nf-live': ['Netflix Tech Blog. Behind the Streams: Live at Netflix, часть 1 (15.07.2025)', 'https://netflixtechblog.com/behind-the-streams-live-at-netflix-part-1-d23f917c2f40'],
    'nf-origin': ['Netflix Tech Blog. Netflix Live Origin (15.12.2025)', 'https://netflixtechblog.com/netflix-live-origin-41f1b0ad5371'],
    'oc': ['Netflix Open Connect: обзор и оборудование', 'https://openconnect.netflix.com/Open-Connect-Overview.pdf'],
    'oc-800': ['D. Gallatin. The Other FreeBSD Optimizations Used by Netflix to Serve Video at 800Gb/s. EuroBSDCon 2022', 'https://papers.freebsd.org/2022/eurobsdcon/gallatin-the_other_freebsd_optimizations-netflix/'],
    'nf-tyson': ['Netflix. Jake Paul vs. Mike Tyson: over 108 million live global viewers (19.11.2024)', 'http://about.netflix.com/en/news/jake-paul-vs-mike-tyson-over-108-million-live-global-viewers'],
    'jio-2026': ['Reliance Industries. Годовой отчёт 2025–26: Media & Entertainment (рекорд 72,5 млн)', 'https://www.ril.com/ar2025-26/media-and-entertainment.html'],
    'hotstar-2019': ['Hotstar. Scaling Hotstar.com for 25 million concurrent viewers. AWS re:Invent 2019', 'https://d1.awsstatic.com/events/reinvent/2019/Scaling_Hotstar.com_for_25_million_concurrent_viewers_CMY302.pdf'],
    'okko-ucl': ['«Газета.Спорт». Okko о трансляции финала Лиги чемпионов (08.06.2026)', 'https://www.gazeta.press/sport/news/2026/06/08/28645921.shtml'],
    'vk-rec': ['VK. Пресс-релиз о рекорде VK Видео (11.12.2025)', 'https://vk.company/ru/press/releases/12183/'],
    'td-2025': ['TelecomDaily: рынок онлайн-кинотеатров в 2025 году (Хабр, 03.2026)', 'https://habr.com/ru/news/1005926/'],
    'ericsson': ['Ericsson Mobility Report, июнь 2026: Mobile traffic update', 'https://www.ericsson.com/en/reports-and-papers/mobility-report/dataforecasts/mobile-traffic-update'],
    'hevc-tan': ['T. K. Tan et al. Video Quality Evaluation Methodology and Verification Testing of HEVC Compression Performance. IEEE TCSVT, 2016', 'https://www.microsoft.com/en-us/research/publication/video-quality-evaluation-methodology-and-verification-testing-of-hevc-compression-performance/'],
    'vvc': ['MPEG VQAG / JVET: итоги проверочных тестов VVC (2021)', 'https://records.sigmm.org/2021/08/20/mpeg-visual-quality-assessment-advisory-group-overview-and-perspectives/'],
    'av2': ['AOMedia. Alliance for Open Media Releases AV2 Codec (06.2026)', 'http://aomedia.org/press%20releases/Alliance-for-Open-Media-Releases-AV2-Codec/'],
    'argos': ['P. Ranganathan et al. Warehouse-scale video acceleration: co-design and deployment in the wild. ASPLOS 2021', 'https://gwern.net/doc/cs/hardware/2021-ranganathan.pdf'],
    'che': ['H. Che, Y. Tung, Z. Wang. Hierarchical Web caching systems: modeling, design and experimental results. IEEE JSAC, 2002', 'https://doi.org/10.1109/JSAC.2002.801752'],
    'nginx-lock': ['nginx: proxy_cache_lock и proxy_cache_lock_timeout', 'https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_lock'],
    'smpte-rp219': ['SMPTE RP 219: High-Definition, Standard-Definition Compatible Color Bar Signal', 'https://doi.org/10.5594/SMPTE.RP219.2002'],
    'webcodecs': ['W3C. WebCodecs', 'https://www.w3.org/TR/webcodecs/'],
    'cenc': ['ISO/IEC 23001-7:2023. Common encryption in ISO base media file format files (фрагмент стандарта)', 'https://cdn.standards.iteh.ai/samples/84637/04ebded1a92a4c8ab9be6f419a3252ed/ISO-IEC-23001-7-2023.pdf'],
    'playready-sl': ['Microsoft. PlayReady Security Level', 'https://learn.microsoft.com/en-us/playready/overview/security-level'],
    'widevine': ['Google. Widevine DRM overview', 'https://developers.google.com/widevine/drm/overview'],
    'prores': ['Apple. Apple ProRes White Paper, приложение «Target Data Rates» (04.2022)', 'https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf'],
    'nf-imf': ['Netflix Partner Help Center. Branded IMF Delivery Specifications', 'https://studiopartner.netflix.net/studio/branded-imf-delivery-specifications'],
    'nf-open': ['Netflix Open Content: тестовые фильмы El Fuente, Chimera, Meridian, Sparks, Nocturne', 'https://opencontent.netflix.com'],
    'nf-movies': ['Netflix Tech Blog. Engineers Making Movies (AKA Open Source Test Content) (11.05.2018)', 'https://netflixtechblog.com/engineers-making-movies-aka-open-source-test-content-f21363ea3781'],
    'nf-scale': ['Netflix Tech Blog. High Quality Video Encoding at Scale (09.12.2015)', 'https://netflixtechblog.com/high-quality-video-encoding-at-scale-d159db052746'],
    'nf-cosmos': ['Netflix Tech Blog. The Netflix Cosmos Platform (01.03.2021)', 'https://netflixtechblog.com/the-netflix-cosmos-platform-35c14d9351ad'],
    'ecp': ['MovieLabs. Specification for Enhanced Content Protection, v1.4 (08.2024)', 'https://movielabs.com/ngvideo/MovieLabs_ECP_Spec_v1.4.pdf'],
    'etsi-wm': ['ETSI TS 104 002 V1.1.1. DASH-IF Forensic A/B Watermarking (08.2023)', 'https://www.etsi.org/deliver/etsi_ts/104000_104099/104002/01.01.01_60/ts_104002v010101p.pdf'],
    'yu2006': ['H. Yu et al. Understanding User Behavior in Large-Scale Video-on-Demand Systems. EuroSys 2006', 'https://people.cs.uchicago.edu/~ravenben/publications/pdf/vod-eurosys06.pdf'],
    'cha2007': ['M. Cha et al. I Tube, You Tube, Everybody Tubes. IMC 2007', 'http://www1.ece.neu.edu/~ningfang/SimPaper/p1-cha.pdf'],
    'fricker': ['C. Fricker, P. Robert, J. Roberts. A versatile and accurate approximation for LRU cache performance (2012)', 'https://arxiv.org/abs/1202.3974'],
    'oc-fill': ['Netflix Open Connect Partner Help Center. Fill patterns', 'https://openconnect.zendesk.com/hc/en-us/articles/360035618071-Fill-patterns'],
    'oc-pop': ['Netflix Tech Blog. Content Popularity for Open Connect (20.06.2017)', 'https://netflixtechblog.com/content-popularity-for-open-connect-b86d56f613b'],
    'decix': ['DE-CIX. Global data traffic volume hits record-breaking 79 exabytes in 2025 (20.01.2026)', 'https://www.de-cix.net/en/about-de-cix/media/press-releases/de-cix-global-data-traffic-volume-hits-record-breaking-79-exabytes-at-internet-exchanges-in-2025'],
    'mskix': ['ComNews. DATAIX, MSK-IX и Piter-IX подвели итоги 2025 года (12.02.2026)', 'https://www.comnews.ru/content/243781/2026-02-12/2026-w07/1008/dataix-msk-ix-i-piter-ix-podveli-itogi-2025-g'],
    'conviva': ['Conviva. State of Streaming Q2 2022', 'https://www.conviva.ai/wp-content/uploads/2022/09/Q2-SoS.pdf'],
    'chromium-mse': ['Chromium: media/base/demuxer_memory_limit.h — лимиты буфера MSE', 'https://github.com/chromium/chromium/blob/main/media/base/demuxer_memory_limit.h'],
    'nf-speed': ['Netflix Help Center. Internet connection speed recommendations', 'https://help.netflix.com/en/node/306'],
    'leader': ['Film leader: SMPTE Universal Leader и 2-pop', 'https://en.wikipedia.org/wiki/Film_leader'],
  };
  const order = [];
  FJ.sources = S;
  FJ.cite = function (key) {
    if (!S[key]) { console.warn('нет источника', key); return ''; }
    let n = order.indexOf(key);
    if (n < 0) { order.push(key); n = order.length - 1; }
    return `<sup class="ref"><a href="#src-${key}" title="${S[key][0].replace(/"/g, '&quot;')}">${n + 1}</a></sup>`;
  };
  FJ.renderSources = function (host) {
    host.innerHTML = '';
    for (const key of order) {
      const [title, url] = S[key];
      const li = FJ.h('li', { id: 'src-' + key });
      li.append(FJ.h('span', null, [title + ' — ', FJ.h('a', { href: url, target: '_blank', rel: 'noopener', text: url.replace(/^https?:\/\//, '').slice(0, 90) + (url.length > 98 ? '…' : '') })]));
      host.append(li);
    }
  };
})(window);

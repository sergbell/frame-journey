/* =====================================================================
   33-devices — профили устройств зрителя.
   Что меняется от устройства:
   • maxBuffer — сколько секунд видео плеер держит в памяти;
   • topRung — выше какой ступени лицензия или экран не пустят
     (0 — можно 720p, 1 — не выше 540p и т. д.);
   • smoothRung — выше какой ступени декодер не успевает и роняет кадры;
   • appStart — сколько секунд приложение «просыпается» до первого запроса;
   • drm — уровень защиты;
   • trace — типичная сеть.
   Числа иллюстративные и масштабированы под нашу лесенку 180p–720p.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ = root.FJ || {};
  FJ.devices = {
    tv: {
      id: 'tv', name: 'Телевизор 4K, 2024', short: 'ТВ 4K',
      maxBuffer: 30, topRung: 0, smoothRung: 0, appStart: 0.9, trace: 'wifi',
      drm: 'Widevine L1 / PlayReady SL3000', note: 'Большой экран: низкие ступени видны сразу, поэтому важен верх лесенки',
    },
    oldtv: {
      id: 'oldtv', name: 'Телевизор 2016 года', short: 'Старый ТВ',
      maxBuffer: 12, topRung: 0, smoothRung: 1, appStart: 2.4, trace: 'wifi',
      drm: 'PlayReady SL2000', note: 'Мало памяти — короткий буфер; слабый процессор роняет кадры на верхней ступени',
    },
    stb: {
      id: 'stb', name: 'Приставка Android TV', short: 'Приставка',
      maxBuffer: 30, topRung: 0, smoothRung: 0, appStart: 0.7, trace: 'fiber',
      drm: 'Widevine L1', note: 'Кабель Ethernet и аппаратный декодер',
    },
    phone: {
      id: 'phone', name: 'Смартфон', short: 'Телефон',
      maxBuffer: 30, topRung: 0, smoothRung: 0, appStart: 0.4, trace: 'lte',
      drm: 'Widevine L1 / FairPlay', note: 'Сеть скачет, зато экран маленький и прощает низкие ступени',
    },
    laptop: {
      id: 'laptop', name: 'Ноутбук, браузер', short: 'Браузер',
      maxBuffer: 30, topRung: 1, smoothRung: 0, appStart: 0.3, trace: 'wifi',
      drm: 'Widevine L3 (программный)', note: 'Программный DRM: студии обычно пускают только SD/HD — здесь верх ограничен 540p',
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

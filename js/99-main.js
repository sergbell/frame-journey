/* =====================================================================
   99-main — запуск: цвета, ферма, фигуры, навигация, источники.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, $$, fmt } = FJ;

  FJ.readColors();

  // Ферма стартует сразу: пока читается заголовок, фильм уже кодируется
  const asset = FJ.asset;
  let lastPaint = 0;
  function paintStrip() {
    $('#stFarm').textContent = asset.mode === 'pending' ? 'готовится' : (asset.progress >= 1 ? 'готово' : fmt.pct(asset.progress));
    $('#stCodec').textContent = asset.mode === 'model' ? 'модель' : (asset.codec || '—');
  }
  asset.on('progress', () => { const n = performance.now(); if (n - lastPaint > 150) { lastPaint = n; paintStrip(); } });
  asset.on('done', paintStrip);
  FJ.farm.start().then(paintStrip);

  // Фигуры
  FJ.bootFigures();
  FJ.renderSources($('#sources'));

  // Подсветка текущей главы в линии сигнала
  const links = $$('#path a');
  const ids = links.map(a => a.getAttribute('href').slice(1));
  const seen = new Map();
  const io = new IntersectionObserver(entries => {
    for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
    let best = null, bestR = 0;
    for (const id of ids) { const r = seen.get(id) || 0; if (r > bestR) { bestR = r; best = id; } }
    const idx = best ? ids.indexOf(best) : -1;
    links.forEach((a, i) => { a.classList.toggle('is-on', i === idx); a.classList.toggle('is-past', idx >= 0 && i < idx); });
  }, { threshold: [0, 0.15, 0.3, 0.5, 0.75] });
  ids.forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
})(window);

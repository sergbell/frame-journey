/* =====================================================================
   60-scale — глава «Масштаб»: калькулятор нагрузки, живая строка CMCD
   нашего плеера, рекорды и что ломается первым.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const { $, h, fmt } = FJ;
  const asset = FJ.asset;

  let calcCv, calcOut, cmcdPre, cmcdTbl;
  const S = { viewers: 1e6, kbps: 5000, seg: 2, part: 1 };
  const SID = 'f7a1c2e4-5b3d-4e8f-9a0b-1c2d3e4f5a6b';

  function mount(el) {
    FJ.addStyle(`
      .sc-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
      @media (min-width: 1100px) { .sc-grid { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); align-items: start; } }
      .sc-calc { height: 300px; }
      .sc-rec { display: grid; gap: 1px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); background: var(--line); border: 1px solid var(--line); border-radius: var(--r-m); overflow: hidden; }
      .sc-rec .stat b { font-size: 40px; }
      .sc-rec .stat em { font-style: normal; color: var(--muted); font-size: 11.5px; font-family: var(--f-mono); }
      .sc-break { counter-reset: br; display: grid; gap: 10px; padding: 0; margin: 0; list-style: none; }
      .sc-break li { display: grid; grid-template-columns: 2.2em 1fr; gap: 10px; font-size: 15px; color: var(--text-2); line-height: 1.55; }
      .sc-break li::before { counter-increment: br; content: counter(br, decimal-leading-zero); font-family: var(--f-mono); color: var(--amber); font-size: 13px; padding-top: 2px; }
      .sc-break strong { color: var(--text); }
      .sc-cmcd { white-space: pre-wrap; word-break: break-all; }
    `);
    FJ.sources['nf-degrade'] = ['Netflix Tech Blog. Behind the Streams: Live at Netflix, часть 1 — повторные запросы и деградация (15.07.2025)', 'https://netflixtechblog.com/behind-the-streams-live-at-netflix-part-1-d23f917c2f40'];
    FJ.sources['hotstar-2018'] = ['Hotstar Engineering. Scaling hotstar.com for 10 million concurrency (06.10.2018)', 'https://www.slideshare.net/hotstar-engineering/scaling-hotstarcom-for-10mn-concurrency'];
    FJ.sources['okko-oi'] = ['CNews. Okko и облачный резерв на Олимпийских играх 2026 (27.02.2026)', 'https://www.cnews.ru/news/line/2026-02-27_okko_ispolzoval_oblachnye'];

    $('#scaleText').innerHTML = `
      <p>Всё, что было выше, делается для одного зрителя. Платформа делает это для миллионов сразу, и&nbsp;под такой нагрузкой первыми отказывают вход, лицензии и&nbsp;ориджин. В&nbsp;финале Лиги чемпионов 30&nbsp;мая 2026 года на&nbsp;старте в&nbsp;Okko вошли больше миллиона человек, собственная CDN отдавала 7,8&nbsp;Тбит/с, а&nbsp;вместе с&nbsp;внешними CDN&nbsp;— больше 10&nbsp;Тбит/с${FJ.cite('okko-ucl')}. Для сравнения: весь пиковый трафик MSK-IX в&nbsp;2025 году&nbsp;— 8,54&nbsp;Тбит/с${FJ.cite('mskix')}. На&nbsp;Олимпиаде‑2026 у&nbsp;Okko было больше 1,5 млн зрителей одновременно, а&nbsp;облачный резерв готовили под всплески в&nbsp;3–5 раз${FJ.cite('okko-oi')}.</p>
      <p>Чтобы видеть такое вживую, нужна общая телеметрия плеера и&nbsp;CDN. Для этого есть CMCD (CTA‑5004): плеер добавляет к&nbsp;каждому запросу буфер, битрейт, измеренную скорость и&nbsp;номер сессии, и&nbsp;логи CDN превращаются в&nbsp;логи зрителей${FJ.cite('cmcd')}. В&nbsp;2026 году вышла вторая версия с&nbsp;ключами для задержки эфира, старта и&nbsp;выпавших кадров${FJ.cite('cmcd-b')}. Справа&nbsp;— настоящая строка CMCD. Её собирает маленький плеер этой главы: он без картинки смотрит наш фильм через сеть «4G в&nbsp;дороге».</p>`;

    const left = h('div', { class: 'stack' });
    const right = h('div', { class: 'stack' });
    el.append(h('div', { class: 'sc-grid' }, [left, right]));

    // калькулятор
    left.append(h('h3', { text: 'Сколько это в терабитах' }));
    const ctl = h('div', { class: 'row gap-l' });
    const sv = h('div'), sb = h('div'), ss = h('div'), sp = h('div');
    ctl.append(sv, sb, ss, sp);
    left.append(ctl);
    const logV = v => Math.round(Math.pow(10, v));
    FJ.slider(sv, { id: 'scV', label: 'Зрителей одновременно', min: 4, max: 8, step: 0.01, value: Math.log10(S.viewers), fmt: v => fmtPeople(logV(v)), onInput: v => { S.viewers = logV(v); paintCalc(); } });
    FJ.slider(sb, { id: 'scB', label: 'Средний битрейт', min: 500, max: 16000, step: 100, value: S.kbps, fmt: v => fmt.kbps(v * 1000), onInput: v => { S.kbps = v; paintCalc(); } });
    FJ.slider(ss, { id: 'scS', label: 'Длина сегмента', min: 1, max: 6, step: 1, value: S.seg, fmt: v => v + ' с', onInput: v => { S.seg = v; paintCalc(); } });
    FJ.slider(sp, { id: 'scP', label: 'Часть LL‑HLS', min: 0.25, max: 2, step: 0.25, value: S.part, fmt: v => fmt.num(v, 2) + ' с', onInput: v => { S.part = v; paintCalc(); } });
    calcOut = h('div', { class: 'stat-row' });
    left.append(calcOut);
    const calcHost = h('div', { class: 'fig__canvas sc-calc', role: 'img', 'aria-label': 'Исходящий трафик при выбранной аудитории в сравнении с известными пиками' });
    left.append(h('div', { class: 'panel', style: { padding: '12px' } }, [calcHost]));
    left.append(h('p', { class: 'caption', html: `Трафик&nbsp;= зрители × средний битрейт. Запросы сегментов&nbsp;= зрители ÷ длина сегмента. В&nbsp;LL‑HLS каждый зритель ещё и&nbsp;перезапрашивает плейлист раз в&nbsp;часть, и&nbsp;без склейки одинаковых запросов на&nbsp;CDN всё это дошло&nbsp;бы до&nbsp;ориджина. Серверы&nbsp;— теоретический минимум при 800&nbsp;Гбит/с на&nbsp;машину, как у&nbsp;лучших серверов Open Connect${FJ.cite('oc-800')}, без резерва. Пик DE-CIX пришёлся на&nbsp;20:11 по&nbsp;Центральной Европе в&nbsp;игровой день Лиги чемпионов${FJ.cite('decix')}.` }));
    calcCv = FJ.canvas(calcHost, { onResize: () => paintCalc() });

    // CMCD
    right.append(h('h3', { text: 'CMCD: что плеер сообщает CDN' }));
    cmcdPre = h('pre', { class: 'code sc-cmcd', 'aria-live': 'off' });
    right.append(cmcdPre);
    const tbl = h('table', { class: 'tbl' });
    tbl.innerHTML = '<thead><tr><th>Ключ</th><th>Значение</th><th>Что значит</th></tr></thead>';
    cmcdTbl = h('tbody'); tbl.append(cmcdTbl);
    right.append(h('div', { class: 'tbl-wrap' }, [tbl]));

    // рекорды
    el.append(h('h3', { text: 'Рекорды, на которые проектируют', style: { marginTop: '28px' } }));
    el.append(h('div', { class: 'sc-rec', html: `
      <div class="stat"><b>72,5 млн</b><span>одновременных потоков на&nbsp;JioHotstar в&nbsp;финале T20 World Cup, 8&nbsp;марта 2026${FJ.cite('jio-2026')}</span></div>
      <div class="stat"><b>65 млн</b><span>одновременных потоков у&nbsp;Netflix на&nbsp;бое Пол — Тайсон, 2024${FJ.cite('nf-tyson')}</span></div>
      <div class="stat"><b>&gt;&nbsp;10 Тбит/с</b><span>Okko в&nbsp;финале Лиги чемпионов, из&nbsp;них 7,8 — собственная CDN, 2026${FJ.cite('okko-ucl')}</span></div>
      <div class="stat"><b>≈&nbsp;800 Гбит/с</b><span>TLS-трафика с&nbsp;одного сервера Open Connect: kTLS и&nbsp;шифрование в&nbsp;сетевой карте${FJ.cite('oc-800')}</span></div>
      <div class="stat"><b>18 000+</b><span>серверов Open Connect в&nbsp;6000+ точках; ~95&nbsp;% трафика Netflix идёт по&nbsp;прямым подключениям к&nbsp;провайдерам${FJ.cite('oc')}</span></div>
      <div class="stat"><b>≈&nbsp;75 %</b><span>мобильного трафика в&nbsp;мире на&nbsp;конец 2025 года&nbsp;— видео${FJ.cite('ericsson')}</span></div>` }));

    // что ломается
    el.append(h('h3', { text: 'Что ломается первым', style: { marginTop: '28px' } }));
    el.append(h('ol', { class: 'sc-break', html: `
      <li><span><strong>Вход и&nbsp;лицензии.</strong> В&nbsp;одну минуту все нажимают «Смотреть»: авторизация, права, лицензии DRM, персональные манифесты. Hotstar в&nbsp;2018 году видел прирост до&nbsp;500&nbsp;тысяч зрителей в&nbsp;минуту, а&nbsp;автомасштабирование успевало только за&nbsp;90&nbsp;секунд реакции и&nbsp;4&nbsp;минуты загрузки. Поэтому мощности греют заранее${FJ.cite('hotstar-2018')}.</span></li>
      <li><span><strong>Повторы после сбоя.</strong> У&nbsp;Netflix перерыв всего в&nbsp;30&nbsp;секунд дал десятикратный рост нагрузки: все клиенты разом пришли заново. Теперь сервер сам говорит устройствам, сколько ждать перед повтором${FJ.cite('nf-degrade')}.</span></li>
      <li><span><strong>Лавина на&nbsp;ориджин.</strong> Новый сегмент нужен всем одновременно. Без склейки запросов каждый промах edge идёт наверх. В&nbsp;nginx эта склейка (proxy_cache_lock) по&nbsp;умолчанию выключена, а&nbsp;её таймаут в&nbsp;5&nbsp;секунд длиннее 2‑секундного сегмента${FJ.cite('nginx-lock')}. Netflix кэширует ответ 404 до&nbsp;момента публикации сегмента, а&nbsp;под нагрузкой отвечает 503 с&nbsp;max-age=5${FJ.cite('nf-origin')}.</span></li>
      <li><span><strong>Хвост устройств.</strong> Старый телевизор с&nbsp;движком 2014 года и&nbsp;15&nbsp;МБ буфера не&nbsp;переживёт того, что спокойно переживает телефон. Именно он первым покажет чёрный экран в&nbsp;самый важный момент.</span></li>
      <li><span><strong>План деградации.</strong> Что выключать под нагрузкой, решают заранее. У&nbsp;Netflix в&nbsp;этом списке эфир приоритетнее предзагрузки, меньше персонализации, без закладок и&nbsp;ниже верхняя ступень${FJ.cite('nf-degrade')}. У&nbsp;Hotstar это называлось panic mode: некритичные сервисы гасят, чтобы жило главное${FJ.cite('hotstar-2019')}.</span></li>` }));
    paintCalc();
  }

  function fmtPeople(n) {
    if (n >= 1e6) return fmt.num(n / 1e6, n >= 1e7 ? 0 : 1) + ' млн';
    if (n >= 1e3) return fmt.num(n / 1e3, 0) + ' тыс.';
    return String(n);
  }

  function paintCalc() {
    if (!calcCv) return;
    const egress = S.viewers * S.kbps * 1000;          // бит/с
    const segRps = S.viewers / S.seg;
    const plRps = S.viewers / S.part;
    const servers = Math.ceil(egress / 800e9);
    calcOut.innerHTML = `
      <div class="stat"><b>${fmt.rate(egress)}</b><span>исходящий трафик</span></div>
      <div class="stat"><b>${fmtPeople(Math.round(segRps))}</b><span>запросов сегментов в&nbsp;секунду</span></div>
      <div class="stat"><b>${fmtPeople(Math.round(plRps))}</b><span>запросов плейлиста в&nbsp;секунду при LL‑HLS</span></div>
      <div class="stat"><b>${fmt.int(servers)}</b><span>серверов по&nbsp;800&nbsp;Гбит/с, минимум</span></div>`;
    const { ctx, w, h: H } = calcCv;
    calcCv.clear();
    const refs = [
      ['Пик DE-CIX, мир, 09.12.2025', 26.99e12, '#8f9197'],
      ['Okko, финал ЛЧ, всего', 10e12, '#ffb02e'],
      ['Пик MSK-IX, 2025', 8.54e12, '#8f9197'],
      ['Okko, финал ЛЧ, своя CDN', 7.8e12, '#ffb02e'],
      ['Hotstar, 2018', 5.7e12, '#8f9197'],
    ];
    const maxV = Math.max(egress, 30e12) * 1.1;
    const p = new FJ.Plot(ctx, { l: 196, t: 10, w: w - 210, h: H - 34 }, { min: 1e9, max: maxV, log: true }, { min: 0, max: refs.length + 1 });
    const xt = [1e9, 1e10, 1e11, 1e12, 1e13, 1e14].filter(v => v <= maxV);
    p.gridX(xt); p.labelsX(xt, v => fmt.rate(v).replace(/,0(?= )/, ''), { size: 10 });
    const rows = [['Ваш сценарий', egress, '#ff4d3d']].concat(refs);
    rows.forEach(([label, v, col], k) => {
      const y = p.r.t + k / rows.length * p.r.h + 4, bh = p.r.h / rows.length - 8;
      ctx.fillStyle = FJ.alpha(col, k === 0 ? 0.9 : 0.5);
      ctx.fillRect(p.r.l, y, Math.max(2, p.sx(Math.max(1e9, v)) - p.r.l), bh);
      ctx.font = FJ.font.text(12); ctx.fillStyle = k === 0 ? FJ.colors.text : FJ.colors['text-2']; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(label, p.r.l - 8, y + bh / 2);
      ctx.font = FJ.font.mono(11);
      const tx = p.sx(Math.max(1e9, v));
      if (tx + 76 < p.r.l + p.r.w) { ctx.textAlign = 'left'; ctx.fillStyle = FJ.colors.text; ctx.fillText(fmt.rate(v), tx + 6, y + bh / 2); }
      else { ctx.textAlign = 'right'; ctx.fillStyle = '#111214'; ctx.fillText(fmt.rate(v), tx - 6, y + bh / 2); }
    });
  }

  /* ---------- CMCD по состоянию плеера из героя ---------- */
  let cmPlayer = null;
  function paintCmcd() {
    const p = cmPlayer;
    if (!p || !cmcdPre) return;
    const last = p.segLog[p.segLog.length - 1];
    if (!last) return;
    const rg = asset.ladder[last.r];
    const mtp = p.samples.length ? Math.round(p.samples[p.samples.length - 1].bps / 1000 / 100) * 100 : 0;
    const k = ((last.K % asset.segCount) + asset.segCount) % asset.segCount;
    const nextK = (k + 1) % asset.segCount;
    const kv = [
      ['bl', Math.round(p.buffer * 10) * 100, 'буфер, мс (с шагом 100)'],
      ['br', rg.kbps, 'битрейт запрошенного объекта, кбит/с'],
      ['d', asset.segDur * 1000, 'длительность объекта, мс'],
      ['mtp', mtp, 'измеренная скорость, кбит/с (шаг 100)'],
      ['nor', `"seg_${String(nextK + 1).padStart(3, '0')}.m4s"`, 'следующий объект'],
      ['ot', 'v', 'тип объекта: видео'],
      ['sf', 'h', 'формат: HLS'],
      ['sid', `"${SID}"`, 'идентификатор сессии'],
      ['st', 'v', 'поток: VOD'],
      ['tb', asset.ladder[p.device.topRung].kbps, 'верхний доступный битрейт, кбит/с'],
    ];
    if (p.state === 'stalled') kv.splice(1, 0, ['bs', true, 'буфер опустел с прошлого запроса']);
    const pay = kv.map(([key, v]) => v === true ? key : `${key}=${v}`).join(',');
    const url = `https://cdn.example/film/${rg.name}/seg_${String(k + 1).padStart(3, '0')}.m4s?CMCD=${encodeURIComponent(pay)}`;
    cmcdPre.innerHTML = `<span class="c">GET</span> ${url.replace('?CMCD=', '?<span class="k">CMCD</span>=')}`;
    cmcdTbl.innerHTML = kv.map(([key, v, d]) => `<tr><td class="mono">${key}</td><td class="mono">${String(v).replace(/"/g, '')}</td><td style="white-space:normal;min-width:180px">${d}</td></tr>`).join('');
  }

  let t = 0;
  FJ.figure({
    id: 'scale', el: $('#fig-scale'),
    mount,
    start() {
      if (!cmPlayer) cmPlayer = new FJ.Player({ asset, device: FJ.devices.phone, trace: FJ.net.makeTrace('lte', 5), algoId: 'tput', startAt: 6 });
      paintCmcd();
    },
    frame(dt) {
      if (cmPlayer) cmPlayer.update(dt);
      t += dt; if (t > 0.5) { t = 0; paintCmcd(); }
    },
  });
})(window);

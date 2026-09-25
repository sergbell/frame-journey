/* =====================================================================
   10-film — тестовая короткометражка «Восемь планов».
   Кадр — детерминированная функция номера: film.render(i).
   Планы — шейдеры WebGL2, лидер и титры — Canvas 2D.
   1280×720, 24 кадра/с, 64 с = 1536 кадров.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;
  const W = 1280, H = 720, FPS = 24, DUR = 64, FRAMES = DUR * FPS;

  /* Таблица планов. Восемь «планов» — с dawn по credits; лидер и затемнение служебные. */
  const SHOTS = [
    { id: 'bars', name: 'Полосы', kind: '2d', from: 0, to: 1.5, service: true,
      test: 'Настроечная таблица SMPTE RP 219 в начале мастера' },
    { id: 'slate', name: 'Слейт', kind: '2d', from: 1.5, to: 3, service: true,
      test: 'Паспорт мастера: версия, формат, длительность' },
    { id: 'leader', name: 'Отсчёт', kind: '2d', from: 3, to: 6, service: true,
      test: '«2» на одном кадре ровно за 2 с до первого кадра действия' },
    { id: 'dawn', name: 'Рассвет над морем', kind: 'gl', from: 6, to: 13,
      test: 'Плавные градиенты: на малом битрейте появляются полосы (бандинг)' },
    { id: 'toon', name: 'Мультфильм', kind: 'gl', from: 13, to: 20,
      test: 'Плоская заливка: кодеку почти нечего передавать' },
    { id: 'rain', name: 'Ночной город, дождь', kind: 'gl', from: 20, to: 28,
      test: 'Тонкие быстрые струи и тёмные тона — дорогие детали' },
    { id: 'train', name: 'Из окна поезда', kind: 'gl', from: 28, to: 35,
      test: 'Параллакс: слои движутся с разной скоростью' },
    { id: 'close', name: 'Крупный план', kind: 'gl', from: 35, to: 42,
      test: 'Статика: почти всё предсказывается из прошлого кадра' },
    { id: 'archive', name: 'Архивная плёнка', kind: 'gl', from: 42, to: 49,
      test: 'Зерно новое в каждом кадре — самое дорогое для кодека' },
    { id: 'fire', name: 'Огонь и искры', kind: 'gl', from: 49, to: 56,
      test: 'Хаотичное движение частиц' },
    { id: 'credits', name: 'Титры', kind: '2d', from: 56, to: 62,
      test: 'Резкий текст: важнее разрешение, чем битрейт' },
    { id: 'fade', name: 'Затемнение', kind: '2d', from: 62, to: 64, service: true,
      test: 'Фейд: меняется каждый пиксель, но предсказуемо' },
  ];
  SHOTS.forEach((s, k) => { s.index = k; s.f0 = Math.round(s.from * FPS); s.f1 = Math.round(s.to * FPS); });
  const EIGHT = SHOTS.filter(s => !s.service);
  const shotOfFrame = new Uint8Array(FRAMES);
  SHOTS.forEach(s => { for (let f = s.f0; f < s.f1; f++) shotOfFrame[f] = s.index; });

  /* ------------------------------------------------------------------
     Шейдеры
     ------------------------------------------------------------------ */
  const VERT = `#version 300 es
  void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

  const HEAD = `#version 300 es
  precision highp float;
  uniform vec2 uRes; uniform float uT; uniform float uDur; uniform float uF;
  uniform sampler2D uTex;
  out vec4 o;
  float h11(float p){ p = fract(p*.1031); p *= p+33.33; p *= p+p; return fract(p); }
  float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
  vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
  float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
  float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
  float fbm3(vec2 p){ float s=0., a=.5; for(int i=0;i<3;i++){ s+=a*vn(p); p=p*2.07+vec2(5.1,1.3); a*=.5; } return s; }
  float AA(){ return 1.25/uRes.y; }
  vec2 P(){ return (gl_FragCoord.xy - .5*uRes)/uRes.y; }
  float vig(vec2 p, float k){ return 1. - k*dot(p*vec2(.62,1.), p*vec2(.62,1.)); }
  `;

  const FRAG = {};

  /* 1 · Рассвет над морем — градиенты и блики */
  FRAG.dawn = HEAD + `
  const float HZ = -.12;
  vec3 skyAt(vec2 p, vec2 sun, float t){
    float hy = max(p.y - HZ, 0.);
    vec3 zen = vec3(.07,.09,.24), mid = vec3(.50,.31,.45), hor = vec3(1.0,.57,.31);
    vec3 c = mix(hor, mid, smoothstep(0., .24, hy));
    c = mix(c, zen, smoothstep(.10, .66, hy));
    float sd = length(p - sun);
    c += vec3(1.,.60,.30)*exp(-sd*4.6)*.55 + vec3(1.,.86,.62)*exp(-sd*20.)*.55;
    float band = smoothstep(.07,.15,p.y) * smoothstep(.36,.20,p.y);
    float cl = fbm(vec2(p.x*1.5 + t*.013, p.y*8.5 + 3.));
    float cm = smoothstep(.50,.74,cl) * band;
    vec3 cc = mix(vec3(.50,.28,.40), vec3(1.,.74,.56), exp(-length(p-sun)*2.3));
    c = mix(c, cc, cm*.85);
    c = mix(c, vec3(1.,.94,.80), smoothstep(.051,.046,sd));
    return c;
  }
  void main(){
    float T = uT/uDur;
    vec2 p = P() * (1. - .04*T);
    vec2 sun = vec2(.22, HZ - .045 + .135*T);
    vec3 col;
    if (p.y > HZ) col = skyAt(p, sun, uT);
    else {
      float dy = HZ - p.y;
      float z = .055/dy;
      vec2 wp = vec2(p.x*z*3.2, z*1.15 + uT*.32);
      float w1 = fbm(wp*vec2(1.,2.3));
      float w2 = fbm(wp*vec2(2.2,4.1) + 7.);
      vec2 rp = vec2(p.x + (w1-.5)*.05*min(dy*7., 1.), HZ + dy*.85 + (w2-.5)*.012);
      vec3 refl = skyAt(rp, sun, uT);
      vec3 water = vec3(.035,.06,.11);
      float fres = .22 + .78*pow(1.-clamp(dy*2.6,0.,1.),3.);
      col = mix(water, refl, fres*.9);
      float gx = abs(p.x - sun.x);
      float path = exp(-gx*gx/(.0025 + dy*dy*1.1));
      float spark = pow(max(w2 - .47, 0.)*2.1, 3.);
      col += vec3(1.,.72,.44)*path*spark*2.4*smoothstep(0.,.015,dy);
      col *= mix(1., .82, smoothstep(.15,.45,dy));
    }
    col *= vig(p, .28);
    o = vec4(clamp(col,0.,1.),1.);
  }`;

  /* 2 · Мультфильм — плоская заливка и контуры */
  FRAG.toon = HEAD + `
  const vec3 INK = vec3(.11,.09,.15);
  float sdC(vec2 p, float r){ return length(p)-r; }
  float smin(float a, float b, float k){ float h = clamp(.5+.5*(b-a)/k,0.,1.); return mix(b,a,h)-k*h*(1.-h); }
  vec3 lay(vec3 c, float d, vec3 fill, float ol){
    float aa = AA();
    c = mix(c, fill, smoothstep(aa, -aa, d));
    return mix(c, INK, smoothstep(aa, -aa, abs(d) - ol));
  }
  float hill1(float x){ return -.06 + .075*sin(x*3.1 + 1.) + .028*sin(x*7.3 + .4); }
  float hill2(float x){ return -.24 + .055*sin(x*2.2 - .7) + .02*sin(x*5.9 + 2.); }
  float cloud(vec2 p){
    float d = sdC(p - vec2(-.07,0.), .048);
    d = smin(d, sdC(p - vec2(0.,.028), .066), .03);
    d = smin(d, sdC(p - vec2(.075,.004), .05), .03);
    return max(d, -(p.y + .03));
  }
  void main(){
    vec2 p = P(); float t = uT;
    vec3 c = mix(vec3(.60,.86,1.), vec3(.47,.78,.98), smoothstep(-.2,.5,p.y));
    vec2 sp = p - vec2(.56,.27);
    float ang = atan(sp.y, sp.x);
    float rays = step(.5, fract(ang/6.2831853*14.));
    float rr = length(sp);
    c = mix(c, vec3(1.,.90,.52), rays*smoothstep(.21,.20,rr)*smoothstep(.10,.11,rr)*.7);
    c = lay(c, sdC(sp,.085), vec3(1.,.82,.24), .0055);
    for (int i = 0; i < 3; i++){
      float fi = float(i);
      float cx = mod(-.95 + fi*.85 + t*.028*(1.+fi*.35), 2.2) - 1.1;
      c = lay(c, cloud((p - vec2(cx, .30 - fi*.075))/(1. - fi*.18))*(1. - fi*.18), vec3(1.), .0045);
    }
    c = lay(c, p.y - hill1(p.x), vec3(.52,.78,.42), .005);
    for (int i = 0; i < 5; i++){ // деревца на дальнем холме
      float fi = float(i); float tx = -.72 + fi*.37;
      float ty = hill1(tx);
      c = lay(c, max(abs(p.x - tx) - .006, max(p.y - ty - .05, ty - .005 - p.y)), vec3(.45,.30,.20), .003);
      c = lay(c, sdC(p - vec2(tx, ty + .07), .036), vec3(.30,.60,.30), .004);
    }
    c = lay(c, p.y - hill2(p.x), vec3(.40,.68,.32), .005);
    for (int i = 0; i < 9; i++){ // цветы
      float fi = float(i); float fx = -.82 + fi*.2 + .05*sin(fi*3.1);
      float fy = hill2(fx) - .045 - .03*h11(fi);
      vec3 pc = mix(vec3(1.,.45,.55), vec3(1.,.93,.4), step(.5, h11(fi*7.)));
      c = lay(c, sdC(p - vec2(fx, fy), .012), pc, .0028);
      c = mix(c, vec3(1.,.95,.7), smoothstep(AA(), -AA(), sdC(p - vec2(fx, fy), .004)));
    }
    // колобок: прыжки со сжатием и растяжением
    float x = -1.02 + t*.29;
    float ph = t*3.1;
    float hop = abs(sin(ph));
    float g = hill2(x);
    float sq = 1. - .22*smoothstep(.25,.0,hop);
    float st = 1. + .10*smoothstep(.35,.9,hop)*step(0., cos(ph)*sin(ph));
    vec2 sc = vec2(1./sq, sq*st);
    float r = .068;
    vec2 cen = vec2(x, g + r*sc.y + .17*hop);
    vec2 q = (p - cen)/sc;
    float sh = sdC((p - vec2(x, g - .004))*vec2(1., 4.), r*(1.1 - .5*hop));
    c = mix(c, c*.72, smoothstep(AA(), -AA(), sh)*.8);
    c = lay(c, sdC(q, r)*min(sc.x,sc.y), vec3(1.,.76,.26), .006);
    float blink = step(.06, fract(t*.45 + .3));
    for (int e = 0; e < 2; e++){
      vec2 ep = q - vec2(.018 + float(e)*.036, .018);
      c = lay(c, sdC(ep*vec2(1., mix(6., 1., blink)), .015), vec3(1.), .003);
      c = mix(c, INK, smoothstep(AA(), -AA(), sdC((ep - vec2(.004,-.002))*vec2(1., mix(6., 1., blink)), .0075))*blink);
    }
    c = mix(c, vec3(.93,.45,.32), smoothstep(AA(), -AA(), sdC((q - vec2(.058,-.012))*vec2(1.,1.4), .011))*.8);
    o = vec4(c,1.);
  }`;

  /* 3 · Ночной город под дождём — неон, отражения, струи */
  FRAG.rain = HEAD + `
  const float STREET = -.19;
  vec3 windows(vec2 p, float colw, float seed, float lit, float warm){
    vec2 g = vec2(p.x/colw*6., p.y*42.);
    vec2 id = floor(g); vec2 f = fract(g);
    float on = step(1. - lit, h21(id + seed));
    float frame = step(.18, f.x)*step(f.x, .82)*step(.25, f.y)*step(f.y, .78);
    vec3 wc = mix(vec3(.55,.75,1.), vec3(1.,.78,.45), step(1.-warm, h21(id*1.7 + seed)));
    float flick = .75 + .25*h21(id + floor(uF/37.));
    return wc*on*frame*flick;
  }
  vec3 city(vec2 p){
    vec3 c = mix(vec3(.018,.02,.045), vec3(.075,.055,.11), smoothstep(-.1,.5,p.y));
    c += vec3(.25,.10,.18)*exp(-abs(p.y - .02)*7.)*.25;
    // дальний ряд
    float cw = 1./13.;
    float cx = floor((p.x + 3.)/cw);
    float bh = STREET + .18 + .34*h11(cx*1.37);
    if (p.y < bh) {
      c = vec3(.035,.04,.07) + .02*h11(cx);
      vec2 lp = vec2(mod(p.x + 3., cw), p.y);
      c += windows(lp, cw, cx*3.1, .22, .6)*.35;
    }
    // ближний ряд
    float cw2 = .31;
    float cx2 = floor((p.x + 3.)/cw2);
    float bh2 = STREET + .12 + .26*h11(cx2*2.91 + 4.);
    float inCol = step(.03, mod(p.x + 3., cw2));
    if (p.y < bh2 && inCol > .5) {
      c = vec3(.02,.022,.04);
      vec2 lp = vec2(mod(p.x + 3., cw2), p.y);
      c += windows(lp, cw2*.8, cx2*7.3, .36, .7)*.8;
    }
    // неоновая вывеска на левом доме
    vec2 sp = (p - vec2(-.60, .07))/vec2(.46,.23) + .5;
    if (sp.x > 0. && sp.x < 1. && sp.y > 0. && sp.y < 1.){
      vec4 s = texture(uTex, vec2(sp.x, 1. - sp.y));
      float fl = step(.07, h11(floor(uF/2.)*.37)) * (.85 + .15*h11(uF));
      c += s.rgb*s.a*1.25*fl;
    }
    return c;
  }
  float rainLayer(vec2 p, float scale, float speed, float seed, float slant){
    vec2 q = vec2(p.x + p.y*slant, p.y)*scale;
    q.y += uT*speed;
    vec2 cell = vec2(1., 5.);
    vec2 id = floor(q/cell);
    vec2 f = q/cell - id - .5;
    float r = h21(id + seed);
    float x = (r - .5)*.7;
    float y = (h21(id + seed + 3.1) - .5)*.5;
    float d = abs(f.x - x)*cell.x;
    float mask = smoothstep(.055, .0, d) * smoothstep(.28, .0, abs(f.y - y));
    return mask * step(.35, r);
  }
  void main(){
    vec2 p = P();
    p.x += .03*sin(uT*.3) + uT*.006;
    vec3 col;
    if (p.y > STREET) col = city(p);
    else {
      float dy = STREET - p.y;
      float rip = (fbm3(vec2(p.x*9., dy*28. - uT*1.4)) - .5)*.05*(dy*4. + .2);
      vec2 rp = vec2(p.x + rip, STREET + dy*1.05);
      vec3 r1 = city(rp), r2 = city(rp + vec2(0., .012)), r3 = city(rp + vec2(0., .026));
      col = (r1*.5 + r2*.3 + r3*.2)*.62;
      col += vec3(.02,.02,.03);
      // брызги
      vec2 g = vec2(p.x*22., dy*60.);
      vec2 id = floor(g);
      float ph = fract(uT*1.7 + h21(id));
      vec2 f = fract(g) - .5;
      float ring = smoothstep(.06, .0, abs(length(f*vec2(1., 2.4)) - ph*.45))*(1. - ph)*step(.55, h21(id + 2.));
      col += vec3(.35,.4,.5)*ring*.35;
    }
    float rn = rainLayer(p, 5., 3.6, 1., .18)*.55 + rainLayer(p, 8., 4.8, 7., .20)*.35 + rainLayer(p, 13., 5.9, 13., .22)*.22;
    col += vec3(.62,.66,.78)*rn*.55 + vec3(.9,.3,.5)*rn*.08;
    col *= vig(p, .35);
    o = vec4(clamp(col,0.,1.),1.);
  }`;

  /* 4 · Из окна поезда — слои с разной скоростью */
  FRAG.train = HEAD + `
  float hillH(float x){ return .03 + .07*fbm3(vec2(x*1.8, 1.3)); }
  void main(){
    vec2 p = P(); float t = uT;
    vec3 c = mix(vec3(1.,.83,.62), vec3(.46,.63,.86), smoothstep(-.06,.46,p.y));
    float cl = fbm(vec2(p.x*1.4 + t*.03, p.y*3.2));
    c = mix(c, vec3(1.,.95,.9), smoothstep(.55,.8,cl)*smoothstep(.05,.3,p.y)*.7);
    // дальние холмы
    float fx = p.x + t*.035;
    if (p.y < hillH(fx)) c = mix(vec3(.50,.58,.70), vec3(.62,.66,.74), smoothstep(-.1,.08,p.y));
    // средний план: лесополоса
    float mx = p.x + t*.24;
    float th = -.05 + .06*fbm3(vec2(mx*6.,2.)) + .035*smoothstep(.55,.7,vn(vec2(mx*4.,5.)));
    if (p.y < th) {
      float sh = fbm3(vec2(mx*28., p.y*30.));
      c = mix(vec3(.12,.22,.12), vec3(.30,.42,.20), sh);
    }
    // поле с рядами
    if (p.y < -.075) {
      float dy = -.075 - p.y;
      float z = .09/dy;
      float u = p.x*z*1.4 + t*1.25*z*.25 + t*.9;
      float rows = .5 + .5*sin(u*14.);
      vec3 f1 = mix(vec3(.72,.62,.30), vec3(.55,.50,.22), rows);
      f1 = mix(f1, vec3(.42,.48,.20), smoothstep(.2,.6,fbm3(vec2(u*.8, z*.5))));
      c = f1 * mix(.8, 1.05, smoothstep(0.,.35,dy));
    }
    // ближние столбы и провода (размыты движением)
    float sp = 1.9;
    float period = .62;
    float u = fract((p.x + t*sp)/period);
    float px = abs(u - .5)*period;
    float blur = .045;
    float pole = smoothstep(.012 + blur, .012, px) * step(p.y, .42);
    c = mix(c, vec3(.16,.12,.10), pole*.9);
    for (int k = 0; k < 3; k++){
      float fk = float(k);
      float y0 = .40 - fk*.035;
      float sag = .06 - fk*.008;
      float wy = y0 - sag*(1. - pow(2.*u - 1., 2.));
      float d = abs(p.y - wy);
      c = mix(c, vec3(.12,.10,.10), smoothstep(.0022 + .001*fk, .0, d)*.85);
    }
    // трава у самого окна
    if (p.y < -.36) {
      float gx = p.x + t*3.2;
      float gr = fbm3(vec2(gx*3., p.y*40.));
      c = mix(c, vec3(.20,.30,.12) + gr*.15, smoothstep(-.36,-.42,p.y + .03*gr));
    }
    c *= vig(p, .22);
    o = vec4(clamp(c,0.,1.),1.);
  }`;

  /* 5 · Крупный план — чашка, пар, свеча, боке */
  FRAG.close = HEAD + `
  float sdBox(vec2 p, vec2 b){ vec2 d = abs(p)-b; return length(max(d,0.)) + min(max(d.x,d.y),0.); }
  void main(){
    vec2 p = P(); float t = uT;
    p += vec2(.012*sin(t*.35), .008*sin(t*.27+1.));
    vec3 c = mix(vec3(.05,.035,.03), vec3(.14,.09,.06), smoothstep(-.5,.5,p.y));
    for (int i = 0; i < 16; i++){
      float fi = float(i);
      vec2 bc = vec2(h11(fi*3.7)*1.9 - .95, h11(fi*9.1)*.62 - .02) + vec2(.01*sin(t*.2+fi), 0.);
      float br = .045 + .07*h11(fi*5.3);
      float d = length(p - bc);
      vec3 bcol = mix(vec3(1.,.62,.25), vec3(1.,.88,.62), h11(fi*1.9));
      float disc = smoothstep(br, br - .006, d);
      float rim = smoothstep(br, br - .012, d) - smoothstep(br - .012, br - .03, d);
      c += bcol*(disc*.16 + rim*.08)*(.6 + .4*h11(fi*11.));
    }
    // стол
    if (p.y < -.2) {
      float g = fbm(vec2(p.x*2.2 + fbm3(p*3.)*.6, p.y*46.));
      c = mix(vec3(.16,.09,.05), vec3(.30,.18,.10), g);
      c *= .75 + .5*exp(-length(p - vec2(.45,-.2))*2.);
    }
    // блюдце
    vec2 sp = (p - vec2(-.08,-.29))/vec2(.30,.055);
    float sd = length(sp) - 1.;
    c = mix(c, vec3(.83,.80,.74)*(.55 + .45*smoothstep(-1.,.4,sp.y)), smoothstep(.02,-.02,sd));
    // чашка
    vec2 q = p - vec2(-.08,-.12);
    float w = .15 - .035*smoothstep(.1,-.16,q.y);
    float body = sdBox(q, vec2(w, .15));
    body = max(body, length((q - vec2(0.,-.02))*vec2(1.,.55)) - .19);
    float hnd = abs(length((q - vec2(.19,.0))*vec2(1.,.85)) - .055) - .014;
    hnd = max(hnd, -(q.x - .15));
    float cup = min(body, hnd);
    float shade = .55 + .45*cos((q.x/w)*1.35 - .6);
    vec3 porc = vec3(.93,.90,.84)*shade;
    porc += vec3(1.,.8,.55)*pow(max(0., 1. - abs(q.x/w - .55)*3.), 3.)*.25;
    c = mix(c, porc, smoothstep(.003,-.003,cup));
    // чай
    vec2 tp = (q - vec2(0.,.15))/vec2(.15,.028);
    float te = length(tp) - 1.;
    c = mix(c, vec3(.93,.90,.84), smoothstep(.06,.0,te)*step(-.0, te + .06));
    c = mix(c, vec3(.32,.13,.04)*(.7 + .3*tp.y) + vec3(1.,.75,.4)*exp(-length(tp - vec2(.45,.25))*6.)*.5, smoothstep(.0,-.08,te));
    // пар
    vec2 st = p - vec2(-.08,.06);
    float col = exp(-pow(st.x + .03*sin(st.y*9. - t*1.3), 2.)/(.004 + st.y*st.y*.08));
    float steam = fbm(vec2(st.x*7., st.y*4. - t*.8)) * col * smoothstep(.0,.08,st.y) * smoothstep(.55,.15,st.y);
    c += vec3(.8,.75,.7)*steam*.28;
    // свеча
    vec2 cp = p - vec2(.47,-.2);
    float cand = sdBox(cp - vec2(0.,.11), vec2(.042, .11));
    c = mix(c, vec3(.92,.86,.74)*(.6 + .4*smoothstep(-.04,.03,cp.x)) + vec3(1.,.6,.2)*.08, smoothstep(.003,-.003,cand));
    float fl = .9 + .1*vn(vec2(t*6., 1.)) ;
    vec2 fp = (cp - vec2(.003*sin(t*7.), .27))/vec2(.018, .05*fl);
    float flame = length(fp*vec2(1., fp.y > 0. ? .8 : 1.6)) ;
    c += vec3(1.,.72,.3)*smoothstep(1.,.2,flame)*1.2 + vec3(1.,.95,.8)*smoothstep(.45,.0,flame);
    c += vec3(1.,.55,.2)*exp(-length(cp - vec2(0.,.27))*6.)*.22*fl;
    c *= vig(p, .42);
    o = vec4(clamp(c,0.,1.),1.);
  }`;

  /* 6 · Архивная плёнка — маяк, зерно, царапины, мерцание */
  FRAG.archive = HEAD + `
  void main(){
    vec2 fc = gl_FragCoord.xy;
    vec2 weave = (vec2(h11(uF*1.31), h11(uF*2.17)) - .5)*vec2(2.,3.)/uRes.y;
    vec2 p = P() + weave; float t = uT;
    float L = mix(.62, .82, smoothstep(-.1,.5,p.y));
    L -= .10*smoothstep(.55,.78,fbm(vec2(p.x*1.6 - t*.04, p.y*3.)));
    // море
    if (p.y < -.14) {
      float dy = -.14 - p.y;
      float w = fbm(vec2(p.x*7./(dy*6. + .3), dy*14. - t*.5));
      L = mix(.42, .30, smoothstep(0.,.3,dy)) + (w - .5)*.18;
    }
    // скала
    float cliff = -.14 + .22*smoothstep(.12,.36,p.x) + .03*fbm3(vec2(p.x*9., 1.));
    if (p.y < cliff && p.x > .1) L = .16 + .08*fbm3(p*20.);
    // маяк
    vec2 lp = p - vec2(.47, .08);
    float tw = .036 - .012*(lp.y + .12)/.3;
    if (abs(lp.x) < tw && lp.y > -.12 && lp.y < .18) L = mix(.86, .40, step(.5, fract((lp.y + .12)*8.)));
    if (abs(lp.x) < .028 && lp.y > .18 && lp.y < .225) L = .95;
    if (abs(lp.x) < .038 && lp.y > .225 && lp.y < .235) L = .2;
    // луч
    float ang = t*1.35;
    vec2 d = normalize(vec2(cos(ang), .12*sin(ang*.5)));
    vec2 rel = p - vec2(.47, .2);
    float along = dot(rel, d);
    float perp = abs(rel.x*d.y - rel.y*d.x);
    float beam = smoothstep(.02 + along*.16, 0., perp) * step(0., along) * exp(-along*1.2);
    L += beam*.35*(.55 + .45*cos(ang));
    L += .6*exp(-length(rel)*28.)*(.6 + .4*cos(ang));
    // плёнка: мерцание, зерно, царапины, пыль
    L *= 1. + (h11(uF*.37) - .5)*.12;
    float gr = (h21(floor(fc) + uF*37.1) - .5)*.24 + (h21(floor(fc*.5) + uF*11.3) - .5)*.14;
    L += gr;
    for (int k = 0; k < 2; k++){
      float fk = float(k);
      float seed = floor(uF/5.) + fk*13.;
      float xs = h11(seed*1.7);
      float on = step(.55, h11(seed*3.3));
      L += on*(h11(seed) > .5 ? .35 : -.25)*exp(-abs(fc.x - xs*uRes.x)/1.3)*step(.2, vn(vec2(fc.y*.02, seed)));
    }
    vec2 dg = floor(fc/14.);
    float dust = step(.9965, h21(dg + uF*3.7));
    L -= dust*smoothstep(4.,1.,length(fract(fc/14.)*14. - 7.))*.6;
    L *= vig(p, .75);
    L = clamp(L, 0., 1.);
    o = vec4(vec3(L*1.02, L, L*.94), 1.);
  }`;

  /* 7 · Огонь и искры */
  FRAG.fire = HEAD + `
  vec3 ramp(float h){
    return clamp(vec3(h*2.4, h*h*1.9 - .05, pow(h, 5.)*1.8 - .1), 0., 1.);
  }
  void main(){
    vec2 p = P(); float t = uT;
    float flick = .82 + .18*vn(vec2(t*5., 3.)) ;
    vec3 c = mix(vec3(.01,.012,.03), vec3(.03,.035,.08), smoothstep(-.2,.5,p.y));
    // силуэты деревьев
    float tr = .12 + .25*fbm3(vec2(p.x*3.,.5)) + .15*abs(p.x);
    if (p.y > tr - .05 && abs(p.x) > .35) c = mix(c, vec3(.0,.0,.01), smoothstep(tr - .05, tr, p.y + .03*fbm3(p*18.)));
    float light = exp(-length((p - vec2(0.,-.32))*vec2(.9,1.4))*2.3)*flick;
    c += vec3(.55,.22,.06)*light*.55;
    // земля
    if (p.y < -.34) c = mix(c, vec3(.05,.03,.02) + vec3(.4,.16,.05)*light*.6, .85);
    // поленья
    vec2 lq = p - vec2(0.,-.35);
    float logs = min(abs(lq.y - lq.x*.18) - .018, abs(lq.y + lq.x*.22) - .018);
    logs = max(logs, abs(lq.x) - .2);
    c = mix(c, vec3(.08,.04,.02) + vec3(.9,.3,.05)*smoothstep(.01,-.02,logs)*.4*flick, smoothstep(.004,-.004,logs));
    // пламя
    vec2 q = (p - vec2(0., -.36))*vec2(.62, .6);
    float n = fbm(vec2(q.x*5.5, q.y*4. - t*2.6));
    float n2 = fbm(vec2(q.x*11., q.y*8. - t*4.1) + 3.);
    float shape = 1. - smoothstep(.0, .55, length(vec2(q.x*(2.4 + q.y*5.), max(q.y, 0.)*1.25)));
    float heat = shape*(n*1.15 + n2*.35) - q.y*.9;
    heat = clamp(heat*1.35 - .25, 0., 1.)*step(-.02, q.y);
    c = mix(c, ramp(heat), smoothstep(.02,.25,heat));
    c += vec3(1.,.4,.1)*heat*.25;
    // дым
    float sm = fbm(vec2(q.x*3. + sin(q.y*2. + t)*.2, q.y*2. - t*.6))*smoothstep(.25,.6,q.y)*smoothstep(1.,.5,q.y)*smoothstep(.35,.05,abs(q.x));
    c = mix(c, vec3(.16,.14,.13), sm*.25);
    // искры
    for (int i = 0; i < 64; i++){
      float fi = float(i);
      float life = fract(t*(.28 + .2*h11(fi*1.3)) + h11(fi*7.31));
      vec2 s = vec2((h11(fi*3.1) - .5)*.3 + sin(life*5.5 + fi)*.08*life, -.28 + life*(.7 + .3*h11(fi*5.1)));
      float d = length(p - s);
      float a = (1. - life)*(.6 + .4*h11(fi + floor(t*9.)));
      c += vec3(1.,.62,.22)*a*(smoothstep(.0045,.0,d)*1.3 + exp(-d*140.)*.18);
    }
    c *= vig(p, .38);
    o = vec4(clamp(c,0.,1.),1.);
  }`;

  /* ------------------------------------------------------------------
     WebGL2
     ------------------------------------------------------------------ */
  let gl = null, glCanvas = null, programs = {}, tex = null;
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function initGL() {
    glCanvas = document.createElement('canvas');
    glCanvas.width = W; glCanvas.height = H;
    gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) return false;
    const vs = compile(gl.VERTEX_SHADER, VERT);
    for (const id in FRAG) {
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG[id]));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      programs[id] = { prog, u: {
        res: gl.getUniformLocation(prog, 'uRes'), t: gl.getUniformLocation(prog, 'uT'),
        dur: gl.getUniformLocation(prog, 'uDur'), f: gl.getUniformLocation(prog, 'uF'),
        tex: gl.getUniformLocation(prog, 'uTex') } };
    }
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, neonSign());
    gl.viewport(0, 0, W, H);
    return true;
  }

  /* Неоновая вывеска рисуется один раз и становится текстурой */
  function neonSign() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 512, 256);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '800 150px "Sofia Sans Extra Condensed", "Arial Narrow", sans-serif';
    const glow = (col, blur, a) => { x.shadowColor = col; x.shadowBlur = blur; x.globalAlpha = a; x.strokeStyle = col; x.lineWidth = 7; x.strokeText('КИНО', 256, 118); };
    glow('#ff2a5a', 40, .9); glow('#ff2a5a', 18, 1);
    x.shadowBlur = 0; x.globalAlpha = 1; x.lineWidth = 3; x.strokeStyle = '#ffd0dc'; x.strokeText('КИНО', 256, 118);
    x.font = '600 34px "JetBrains Mono", monospace';
    x.shadowColor = '#34e6ff'; x.shadowBlur = 16; x.fillStyle = '#b8f6ff';
    x.fillText('24 ЧАСА', 256, 214);
    return c;
  }

  function drawGL(shot, i) {
    const pr = programs[shot.id];
    gl.useProgram(pr.prog);
    gl.uniform2f(pr.u.res, W, H);
    gl.uniform1f(pr.u.t, i / FPS - shot.from);
    gl.uniform1f(pr.u.dur, shot.to - shot.from);
    gl.uniform1f(pr.u.f, i);
    if (pr.u.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(pr.u.tex, 0); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ------------------------------------------------------------------
     Canvas 2D: лидер, титры, затемнение
     ------------------------------------------------------------------ */
  const FONT_D = '"Sofia Sans Extra Condensed", "Arial Narrow", sans-serif';
  const FONT_T = '"Golos Text", "Segoe UI", sans-serif';
  const FONT_M = '"JetBrains Mono", ui-monospace, Menlo, monospace';

  /* SMPTE RP 219: 75 % полосы, ряды 2 и 3, PLUGE внизу */
  function drawBars(x) {
    const d = W / 8, c = (W - 2 * d) / 7;
    const h1 = H * 7 / 12, h2 = H / 12, h3 = H / 12;
    const g40 = '#666666', g15 = '#262626';
    const bars = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf'];
    x.fillStyle = g40; x.fillRect(0, 0, W, h1);
    bars.forEach((col, k) => { x.fillStyle = col; x.fillRect(Math.round(d + k * c), 0, Math.ceil(c) + 1, h1); });
    // ряд 2
    x.fillStyle = '#00ffff'; x.fillRect(0, h1, d, h2);
    x.fillStyle = '#ffffff'; x.fillRect(d, h1, c, h2);
    x.fillStyle = '#bfbfbf'; x.fillRect(d + c, h1, W - 2 * d - c, h2);
    x.fillStyle = '#0000ff'; x.fillRect(W - d, h1, d, h2);
    // ряд 3: жёлтый, ступенчатая шкала яркости, красный
    x.fillStyle = '#ffff00'; x.fillRect(0, h1 + h2, d, h3);
    const gr = x.createLinearGradient(d + c, 0, W - d, 0);
    gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff');
    x.fillStyle = '#000'; x.fillRect(d, h1 + h2, c, h3);
    x.fillStyle = gr; x.fillRect(d + c, h1 + h2, W - 2 * d - 2 * c, h3);
    x.fillStyle = '#fff'; x.fillRect(W - d - c, h1 + h2, c, h3);
    x.fillStyle = '#ff0000'; x.fillRect(W - d, h1 + h2, d, h3);
    // ряд 4: серый 15 %, чёрный, белый, чёрный, PLUGE (−2 %, 0, +2 %, 0, +4 %), чёрный, серый 15 %
    const y4 = h1 + h2 + h3, h4 = H - y4;
    x.fillStyle = g15; x.fillRect(0, y4, W, h4);
    let px = d;
    const seq = [['#000', 1.5 * c], ['#fff', 2 * c], ['#000', 5 / 6 * c], ['#000', c / 3], ['#000', c / 3], ['#050505', c / 3], ['#000', c / 3], ['#0a0a0a', c / 3], ['#000', c]];
    for (const [col, wdt] of seq) { x.fillStyle = col; x.fillRect(Math.round(px), y4, Math.ceil(wdt) + 1, h4); px += wdt; }
    x.fillStyle = g15; x.fillRect(W - d, y4, d, h4);
  }

  function drawSlate(x) {
    x.fillStyle = '#050506'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#ecebe6';
    x.textBaseline = 'alphabetic'; x.textAlign = 'left';
    x.font = `800 112px ${FONT_D}`;
    x.fillText('ВОСЕМЬ ПЛАНОВ', 120, 250);
    x.font = `400 30px ${FONT_T}`; x.fillStyle = '#a9aaae';
    x.fillText('тестовая короткометражка для кодека', 124, 300);
    x.fillStyle = '#34363b'; x.fillRect(124, 340, 1030, 2);
    const rows = [['ВЕРСИЯ', 'мастер v3'], ['ФОРМАТ', '1280 × 720 · 24p · Rec. 709 SDR'], ['ДЛИТЕЛЬНОСТЬ', '00:01:04:00 · 1536 кадров'], ['ЗВУК', 'нет'], ['ДАТА', '25.09.2026']];
    rows.forEach((r, k) => {
      x.font = `500 22px ${FONT_M}`; x.fillStyle = '#8f9197'; x.fillText(r[0], 124, 400 + k * 46);
      x.fillStyle = '#ecebe6'; x.fillText(r[1], 430, 400 + k * 46);
    });
  }

  /* Отсчёт в духе SMPTE Universal Leader: сектор-«радар», круги, цифра */
  function drawLeader(x, i) {
    const t = i / FPS;
    const twoFrame = Math.round(4 * FPS);
    if (i > twoFrame) { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); return; }
    const n = i === twoFrame ? 2 : 3;
    const ph = i === twoFrame ? 0 : (t - 3) % 1;
    x.fillStyle = '#6a6a6a'; x.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, R = 300;
    x.fillStyle = '#9a9a9a';
    x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, 900, -Math.PI / 2, -Math.PI / 2 + ph * Math.PI * 2); x.closePath(); x.fill();
    x.strokeStyle = '#1a1a1a'; x.lineWidth = 3;
    x.beginPath(); x.moveTo(0, cy); x.lineTo(W, cy); x.moveTo(cx, 0); x.lineTo(cx, H); x.stroke();
    x.strokeStyle = '#f2f2f2'; x.lineWidth = 7;
    x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 5; x.beginPath(); x.arc(cx, cy, R - 34, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `800 400px ${FONT_D}`;
    x.fillText(String(n), cx, cy + 20);
  }

  const CREDITS = [
    ['h', 'ВОСЕМЬ ПЛАНОВ'], ['s', 'тестовая короткометражка для кодека'], ['gap'],
    ['r', 'Рассвет', 'градиенты и бандинг'], ['r', 'Мультфильм', 'плоская заливка'], ['r', 'Ночной город', 'дождь и неон'],
    ['r', 'Поезд', 'движение и параллакс'], ['r', 'Крупный план', 'статика'], ['r', 'Архив', 'зерно плёнки'],
    ['r', 'Огонь', 'хаос частиц'], ['r', 'Титры', 'вы их читаете'], ['gap'],
    ['r', 'Кодек', 'H.264'], ['r', 'Лесенка', 'пять ступеней'], ['r', 'Сегменты', 'по две секунды'],
    ['r', 'Упаковка', 'CMAF'], ['r', 'Шифрование', 'cbcs'], ['r', 'Плеер', 'ваш браузер'], ['gap'],
    ['s', 'ни один пиксель не был снят камерой'],
  ];
  function creditsHeight() {
    let y = 0;
    for (const c of CREDITS) y += c[0] === 'h' ? 110 : c[0] === 'gap' ? 70 : c[0] === 's' ? 54 : 50;
    return y;
  }
  const CRED_H = creditsHeight();
  function drawCredits(x, i) {
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    const t = (i / FPS - 56) / 6;
    let y = H + 40 - t * (CRED_H + H * 0.62);
    x.textBaseline = 'alphabetic';
    for (const c of CREDITS) {
      if (c[0] === 'h') { x.font = `800 84px ${FONT_D}`; x.fillStyle = '#f4f3ee'; x.textAlign = 'center'; x.fillText(c[1], W / 2, y + 84); y += 110; }
      else if (c[0] === 's') { x.font = `400 26px ${FONT_T}`; x.fillStyle = '#b9bab6'; x.textAlign = 'center'; x.fillText(c[1], W / 2, y + 30); y += 54; }
      else if (c[0] === 'gap') y += 70;
      else {
        x.font = `400 26px ${FONT_T}`; x.fillStyle = '#9d9e9a'; x.textAlign = 'right'; x.fillText(c[1], W / 2 - 18, y + 30);
        x.font = `600 26px ${FONT_T}`; x.fillStyle = '#f4f3ee'; x.textAlign = 'left'; x.fillText(c[2], W / 2 + 18, y + 30);
        y += 50;
      }
    }
  }
  function drawFade(x, i) {
    const t = (i / FPS - 62) / 2;
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.globalAlpha = Math.max(0, 1 - t * 1.15);
    x.fillStyle = '#f4f3ee'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `800 120px ${FONT_D}`;
    x.fillText('КОНЕЦ', W / 2, H / 2 + 6);
    x.globalAlpha = 1;
  }

  /* Запасной рисунок, если WebGL2 недоступен */
  function drawFallback(x, shot, i) {
    const t = i / FPS - shot.from;
    const hue = { dawn: 24, toon: 200, rain: 250, train: 90, close: 30, archive: 0, fire: 12 }[shot.id] || 0;
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${hue},45%,${shot.id === 'archive' ? 60 : 22}%)`);
    g.addColorStop(1, `hsl(${hue + 30},55%,${shot.id === 'archive' ? 30 : 8}%)`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const r = FJ.rng(i * 7 + 1);
    for (let k = 0; k < 60; k++) { x.fillStyle = `hsla(${hue + r() * 60},70%,${40 + r() * 40}%,.5)`; x.fillRect((r() * W + t * 120 * (k % 5)) % W, r() * H, 6 + r() * 30, 6 + r() * 30); }
    x.fillStyle = '#fff'; x.font = `800 64px ${FONT_D}`; x.textAlign = 'center'; x.fillText(shot.name.toUpperCase(), W / 2, H / 2);
  }

  /* ------------------------------------------------------------------
     Публичный интерфейс
     ------------------------------------------------------------------ */
  const comp = document.createElement('canvas');
  comp.width = W; comp.height = H;
  const cx2 = comp.getContext('2d', { willReadFrequently: false });
  let glOk = false, ready = null;

  const film = {
    W, H, FPS, DUR, FRAMES, SEG: 2, shots: SHOTS, eight: EIGHT, canvas: comp,
    get glOk() { return glOk; },
    shotAt(i) { return SHOTS[shotOfFrame[Math.max(0, Math.min(FRAMES - 1, i))]]; },
    shotIndexAt(i) { return shotOfFrame[Math.max(0, Math.min(FRAMES - 1, i))]; },
    /* Кадр, на котором стоит «2» и 2-pop */
    TWO_POP: Math.round(4 * FPS),
    init() {
      if (ready) return ready;
      ready = (async () => {
        const fonts = ['800 100px "Sofia Sans Extra Condensed"', '400 26px "Golos Text"', '600 26px "Golos Text"', '500 22px "JetBrains Mono"', '600 34px "JetBrains Mono"'];
        try {
          if (document.fonts && document.fonts.load) {
            await Promise.race([Promise.all(fonts.map(f => document.fonts.load(f, 'ВОСЕМЬ ПЛАНОВ 0123'))), FJ.sleep(2500)]);
          }
        } catch (e) { /* без шрифтов тоже работаем */ }
        try { glOk = initGL(); } catch (e) { console.warn('WebGL2: ' + e.message); glOk = false; }
        return film;
      })();
      return ready;
    },
    /* Нарисовать кадр i в film.canvas */
    render(i) {
      i = Math.max(0, Math.min(FRAMES - 1, i | 0));
      const shot = SHOTS[shotOfFrame[i]];
      const x = cx2;
      x.save();
      if (shot.kind === 'gl') {
        if (glOk) { drawGL(shot, i); x.drawImage(glCanvas, 0, 0); }
        else drawFallback(x, shot, i);
      } else if (shot.id === 'bars') drawBars(x);
      else if (shot.id === 'slate') drawSlate(x);
      else if (shot.id === 'leader') drawLeader(x, i);
      else if (shot.id === 'credits') drawCredits(x, i);
      else drawFade(x, i);
      x.restore();
      return comp;
    },
  };
  FJ.film = film;
})(window);

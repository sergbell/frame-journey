/* =====================================================================
   01-charts — примитивы графиков на Canvas 2D.
   Одна шкала на оси, подписи только для значений, которые график достигает.
   ===================================================================== */
(function (root) {
  'use strict';
  const FJ = root.FJ;

  /* «Красивые» деления оси */
  FJ.ticks = function (min, max, count) {
    count = count || 5;
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const st = norm < 1.5 ? mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
    const out = [];
    for (let v = Math.ceil(min / st) * st; v <= max + st * 1e-9; v += st) out.push(+v.toFixed(12));
    return out;
  };

  class Plot {
    constructor(ctx, rect, x, y) {
      this.ctx = ctx; this.r = rect; this.x = x; this.y = y;
    }
    sx(v) {
      const { x, r } = this;
      if (x.log) return r.l + (Math.log(v) - Math.log(x.min)) / (Math.log(x.max) - Math.log(x.min)) * r.w;
      return r.l + (v - x.min) / (x.max - x.min) * r.w;
    }
    sy(v) {
      const { y, r } = this;
      if (y.log) return r.t + r.h - (Math.log(v) - Math.log(y.min)) / (Math.log(y.max) - Math.log(y.min)) * r.h;
      return r.t + r.h - (v - y.min) / (y.max - y.min) * r.h;
    }
    ix(px) { const { x, r } = this; return x.min + (px - r.l) / r.w * (x.max - x.min); }
    iy(py) { const { y, r } = this; return y.min + (r.t + r.h - py) / r.h * (y.max - y.min); }

    clip(fn) {
      const c = this.ctx, r = this.r;
      c.save(); c.beginPath(); c.rect(r.l, r.t - 1, r.w, r.h + 2); c.clip(); fn(c); c.restore();
    }

    gridY(ticks, color) {
      const c = this.ctx, r = this.r;
      c.strokeStyle = color || FJ.colors.line; c.lineWidth = 1;
      c.beginPath();
      for (const v of ticks) { const y = Math.round(this.sy(v)) + 0.5; c.moveTo(r.l, y); c.lineTo(r.l + r.w, y); }
      c.stroke();
    }
    gridX(ticks, color) {
      const c = this.ctx, r = this.r;
      c.strokeStyle = color || FJ.colors.line; c.lineWidth = 1;
      c.beginPath();
      for (const v of ticks) { const x = Math.round(this.sx(v)) + 0.5; c.moveTo(x, r.t); c.lineTo(x, r.t + r.h); }
      c.stroke();
    }
    labelsY(ticks, fmt, opts) {
      opts = opts || {};
      const c = this.ctx, r = this.r;
      c.font = FJ.font.mono(opts.size || 11); c.fillStyle = opts.color || FJ.colors.muted;
      c.textBaseline = 'middle';
      c.textAlign = opts.right ? 'left' : 'right';
      const x = opts.right ? r.l + r.w + 6 : r.l - 6;
      for (const v of ticks) c.fillText(fmt ? fmt(v) : String(v), x, this.sy(v));
    }
    labelsX(ticks, fmt, opts) {
      opts = opts || {};
      const c = this.ctx, r = this.r;
      c.font = FJ.font.mono(opts.size || 11); c.fillStyle = opts.color || FJ.colors.muted;
      c.textBaseline = 'top'; c.textAlign = 'center';
      for (const v of ticks) c.fillText(fmt ? fmt(v) : String(v), this.sx(v), r.t + r.h + 6);
    }
    frame(color) {
      const c = this.ctx, r = this.r;
      c.strokeStyle = color || FJ.colors['line-2']; c.lineWidth = 1;
      c.beginPath(); c.moveTo(r.l + 0.5, r.t); c.lineTo(r.l + 0.5, r.t + r.h + 0.5); c.lineTo(r.l + r.w, r.t + r.h + 0.5); c.stroke();
    }
    line(pts, color, width, dash) {
      if (!pts.length) return;
      const c = this.ctx;
      c.strokeStyle = color; c.lineWidth = width || 1.5; c.lineJoin = 'round'; c.lineCap = 'round';
      if (dash) c.setLineDash(dash);
      c.beginPath();
      pts.forEach((p, i) => { const X = this.sx(p[0]), Y = this.sy(p[1]); i ? c.lineTo(X, Y) : c.moveTo(X, Y); });
      c.stroke();
      if (dash) c.setLineDash([]);
    }
    /* Ступенчатая линия: значение держится до следующей точки */
    step(pts, color, width, xEnd) {
      if (!pts.length) return;
      const c = this.ctx;
      c.strokeStyle = color; c.lineWidth = width || 2; c.lineJoin = 'miter';
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const X = this.sx(pts[i][0]), Y = this.sy(pts[i][1]);
        if (i === 0) c.moveTo(X, Y); else { c.lineTo(X, this.sy(pts[i - 1][1])); c.lineTo(X, Y); }
      }
      const last = pts[pts.length - 1];
      c.lineTo(this.sx(xEnd != null ? xEnd : last[0]), this.sy(last[1]));
      c.stroke();
    }
    area(pts, color, base) {
      if (!pts.length) return;
      const c = this.ctx, b = this.sy(base == null ? this.y.min : base);
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(this.sx(pts[0][0]), b);
      for (const p of pts) c.lineTo(this.sx(p[0]), this.sy(p[1]));
      c.lineTo(this.sx(pts[pts.length - 1][0]), b);
      c.closePath(); c.fill();
    }
    dot(x, y, rad, color, stroke) {
      const c = this.ctx;
      c.beginPath(); c.arc(this.sx(x), this.sy(y), rad, 0, Math.PI * 2);
      c.fillStyle = color; c.fill();
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke(); }
    }
    text(x, y, s, o) {
      o = o || {};
      const c = this.ctx;
      c.font = o.font || FJ.font.mono(o.size || 11, o.weight);
      c.fillStyle = o.color || FJ.colors['text-2'];
      c.textAlign = o.align || 'left'; c.textBaseline = o.base || 'alphabetic';
      c.fillText(s, (o.px ? x : this.sx(x)) + (o.dx || 0), (o.px ? y : this.sy(y)) + (o.dy || 0));
    }
  }
  FJ.Plot = Plot;

  /* Скруглённый прямоугольник, если нет нативного */
  FJ.rrect = function (c, x, y, w, h, r) {
    if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================
 * charts.js —— 纯 SVG 手写图表（不依赖任何第三方库）
 * 对应原 VBA 的 CreateComparisonBarChart / CreateTrendChart
 * ========================================================= */
(function (App) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* 取一个好看的刻度上限 */
  function niceMax(v, ticks) {
    ticks = ticks || 5;
    if (v <= 0) return 10;
    var raw = v / ticks;
    var mag = Math.pow(10, Math.floor(Math.log10 ? Math.log10(raw) : Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10);
    var max = Math.ceil(v / step) * step;
    return { max: max, step: step };
  }

  function axisText(size) { return { 'font-size': size || 11, fill: '#5b6a77' }; }

  /**
   * 簇状柱形图
   * opt: { title, categories:[], series:[{name,color,data:[]}], width, height, unit }
   */
  function barChart(opt) {
    var W = opt.width || 900, H = opt.height || 360;
    var pt = 34, pb = 74, pl = 52, pr = 16;
    var pw = W - pl - pr, ph = H - pt - pb;
    var cats = opt.categories, series = opt.series;

    var maxV = 0, i, j;
    for (i = 0; i < series.length; i++)
      for (j = 0; j < series[i].data.length; j++)
        maxV = Math.max(maxV, Number(series[i].data[j]) || 0);
    var nm = niceMax(maxV * 1.12, 5);
    maxV = nm.max;

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H });

    if (opt.title) {
      svg.appendChild(el('text', { x: W / 2, y: 18, 'text-anchor': 'middle', 'font-size': 13.5, 'font-weight': 600, fill: '#1e2a33' }, opt.title));
    }

    // 网格与 Y 轴
    for (var v = 0; v <= maxV + 1e-9; v += nm.step) {
      var y = pt + ph - (v / maxV) * ph;
      svg.appendChild(el('line', { x1: pl, y1: y, x2: pl + pw, y2: y, stroke: '#e8eeec', 'stroke-width': 1 }));
      svg.appendChild(el('text', Object.assign({ x: pl - 7, y: y + 4, 'text-anchor': 'end' }, axisText(10)), String(Math.round(v))));
    }
    svg.appendChild(el('line', { x1: pl, y1: pt, x2: pl, y2: pt + ph, stroke: '#c9d4d0', 'stroke-width': 1 }));
    svg.appendChild(el('line', { x1: pl, y1: pt + ph, x2: pl + pw, y2: pt + ph, stroke: '#c9d4d0', 'stroke-width': 1 }));

    if (!cats.length) {
      svg.appendChild(el('text', { x: W / 2, y: pt + ph / 2, 'text-anchor': 'middle', 'font-size': 12, fill: '#8b96a3' }, '暂无可对比的数据'));
      return svg;
    }

    var gw = pw / cats.length;
    var bw = Math.min(26, gw * 0.32);
    var gap = 3;
    var totalW = series.length * bw + (series.length - 1) * gap;

    for (i = 0; i < cats.length; i++) {
      var cx = pl + gw * i + gw / 2;
      for (j = 0; j < series.length; j++) {
        var val = Number(series[j].data[i]) || 0;
        var hgt = Math.max(0, (val / maxV) * ph);
        var x = cx - totalW / 2 + j * (bw + gap);
        svg.appendChild(el('rect', {
          x: x, y: pt + ph - hgt, width: bw, height: hgt,
          fill: series[j].color, rx: 2
        }));
        if (val > 0) {
          svg.appendChild(el('text', {
            x: x + bw / 2, y: pt + ph - hgt - 4, 'text-anchor': 'middle',
            'font-size': 9.5, fill: series[j].color
          }, String(App.U.f1(val))));
        }
      }
      svg.appendChild(el('text', Object.assign({ x: cx, y: pt + ph + 18, 'text-anchor': 'middle' }, axisText(11)), cats[i]));
    }

    // 图例
    var lx = W / 2 - (series.length * 110) / 2;
    for (j = 0; j < series.length; j++) {
      svg.appendChild(el('rect', { x: lx + j * 110, y: H - 22, width: 11, height: 11, rx: 2, fill: series[j].color }));
      svg.appendChild(el('text', { x: lx + j * 110 + 17, y: H - 13, 'font-size': 11.5, fill: '#5b6a77' }, series[j].name));
    }
    if (opt.unit) {
      svg.appendChild(el('text', { x: pl, y: pt - 8, 'font-size': 10.5, fill: '#8b96a3' }, opt.unit));
    }
    return svg;
  }

  /**
   * 双轴折线图：左轴=成绩（红实线圆点），右轴=排名（蓝色虚线方点，反向刻度）
   * opt: { title, labels:[], score:[], rank:[], scoreLabel, rankLabel }
   */
  function dualLineChart(opt) {
    var W = opt.width || 900, H = opt.height || 380;
    var pt = 34, pb = 76, pl = 52, pr = 54;
    var pw = W - pl - pr, ph = H - pt - pb;
    var labels = opt.labels, sc = opt.score, rk = opt.rank;
    var n = labels.length, i;

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H });
    if (opt.title) {
      svg.appendChild(el('text', { x: W / 2, y: 18, 'text-anchor': 'middle', 'font-size': 13.5, 'font-weight': 600, fill: '#1e2a33' }, opt.title));
    }

    var maxS = 0, minS = Infinity;
    for (i = 0; i < n; i++) {
      var sv = Number(sc[i]) || 0;
      if (sv > 0) { maxS = Math.max(maxS, sv); minS = Math.min(minS, sv); }
    }
    if (minS === Infinity) { minS = 0; maxS = 100; }
    var ns = niceMax(maxS * 1.15, 5);
    var sTop = ns.max, sBot = Math.max(0, Math.floor((minS - (sTop - minS) * 0.25) / ns.step) * ns.step);
    if (sBot >= sTop) sBot = 0;

    var rkVals = [], rMin = Infinity, rMax = 0;
    for (i = 0; i < n; i++) {
      var rv = Number(rk[i]) || 0;
      if (rv > 0) { rkVals.push(i); rMin = Math.min(rMin, rv); rMax = Math.max(rMax, rv); }
    }
    /* 没有排名数据时不画右轴与排名图例（例如只展示「得分率」单折线） */
    var hasRank = rkVals.length > 0;
    if (!hasRank) { rMin = 1; rMax = Math.max(n, 5); }
    if (rMax === rMin) rMax = rMin + 1;

    function xs(i) { return n === 1 ? pl + pw / 2 : pl + (pw * i) / (n - 1); }
    function ys(v) { return pt + ph - ((v - sBot) / (sTop - sBot)) * ph; }
    // 排名反向：数值越小越靠上
    function yr(v) { return pt + ((v - rMin) / (rMax - rMin)) * ph; }

    // 成绩轴刻度
    for (var y = sBot; y <= sTop + 1e-9; y += ns.step) {
      var yy = ys(y);
      if (yy < pt - 1 || yy > pt + ph + 1) continue;
      svg.appendChild(el('line', { x1: pl, y1: yy, x2: pl + pw, y2: yy, stroke: '#e8eeec' }));
      svg.appendChild(el('text', Object.assign({ x: pl - 7, y: yy + 4, 'text-anchor': 'end' }, axisText(10)), String(Math.round(y))));
    }
    // 排名轴刻度（反向）
    if (hasRank) {
      var rs = Math.max(1, Math.round((rMax - rMin) / 4));
      for (var rv2 = rMin; rv2 <= rMax + 1e-9; rv2 += rs) {
        var y2 = yr(rv2);
        svg.appendChild(el('text', Object.assign({ x: pl + pw + 8, y: y2 + 4 }, axisText(10)), String(Math.round(rv2))));
      }
    }
    svg.appendChild(el('line', { x1: pl, y1: pt, x2: pl, y2: pt + ph, stroke: '#c9d4d0' }));
    svg.appendChild(el('line', { x1: pl, y1: pt + ph, x2: pl + pw, y2: pt + ph, stroke: '#c9d4d0' }));

    // 轴标题
    svg.appendChild(el('text', { x: pl - 34, y: pt - 8, 'font-size': 10.5, fill: '#c0392b' }, opt.scoreLabel || '成绩'));
    if (hasRank) {
      svg.appendChild(el('text', { x: pl + pw + 6, y: pt - 8, 'font-size': 10.5, fill: '#4472c4' }, opt.rankLabel || '排名'));
    }

    // 成绩线
    var d = '';
    for (i = 0; i < n; i++) {
      var v2 = Number(sc[i]) || 0;
      if (v2 <= 0) continue;
      d += (d ? ' L ' : 'M ') + xs(i) + ' ' + ys(v2);
    }
    if (d) svg.appendChild(el('path', { d: d, fill: 'none', stroke: '#c0392b', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    for (i = 0; i < n; i++) {
      var v3 = Number(sc[i]) || 0;
      if (v3 <= 0) continue;
      svg.appendChild(el('circle', { cx: xs(i), cy: ys(v3), r: 4, fill: '#fff', stroke: '#c0392b', 'stroke-width': 2.5 }));
      svg.appendChild(el('text', { x: xs(i), y: ys(v3) - 10, 'text-anchor': 'middle', 'font-size': 10, fill: '#c0392b' }, String(App.U.f1(v3))));
    }

    // 排名线
    var d2 = '';
    for (i = 0; i < rkVals.length; i++) {
      var idx = rkVals[i], rvr = Number(rk[idx]) || 0;
      d2 += (d2 ? ' L ' : 'M ') + xs(idx) + ' ' + yr(rvr);
    }
    if (d2) svg.appendChild(el('path', { d: d2, fill: 'none', stroke: '#4472c4', 'stroke-width': 2.2, 'stroke-dasharray': '6,4' }));
    for (i = 0; i < rkVals.length; i++) {
      var id2 = rkVals[i], rvv = Number(rk[id2]) || 0;
      svg.appendChild(el('rect', { x: xs(id2) - 3.5, y: yr(rvv) - 3.5, width: 7, height: 7, fill: '#fff', stroke: '#4472c4', 'stroke-width': 2 }));
      svg.appendChild(el('text', { x: xs(id2), y: yr(rvv) + 16, 'text-anchor': 'middle', 'font-size': 10, fill: '#4472c4' }, String(rvv)));
    }

    // X 轴标签
    for (i = 0; i < n; i++) {
      svg.appendChild(el('text', Object.assign({ x: xs(i), y: pt + ph + 18, 'text-anchor': 'middle' }, axisText(10.5)), labels[i]));
    }

    // 图例（无排名数据时只画成绩图例并居中）
    var lx = W / 2 - (hasRank ? 110 : 55);
    svg.appendChild(el('line', { x1: lx, y1: H - 16, x2: lx + 22, y2: H - 16, stroke: '#c0392b', 'stroke-width': 2.5 }));
    svg.appendChild(el('circle', { cx: lx + 11, cy: H - 16, r: 3.5, fill: '#fff', stroke: '#c0392b', 'stroke-width': 2 }));
    svg.appendChild(el('text', { x: lx + 28, y: H - 12, 'font-size': 11.5, fill: '#5b6a77' }, opt.scoreLabel || '成绩'));
    if (hasRank) {
      svg.appendChild(el('line', { x1: lx + 110, y1: H - 16, x2: lx + 132, y2: H - 16, stroke: '#4472c4', 'stroke-width': 2.2, 'stroke-dasharray': '6,4' }));
      svg.appendChild(el('rect', { x: lx + 118, y: H - 20, width: 7, height: 7, fill: '#fff', stroke: '#4472c4', 'stroke-width': 2 }));
      svg.appendChild(el('text', { x: lx + 138, y: H - 12, 'font-size': 11.5, fill: '#5b6a77' }, opt.rankLabel || '排名（越小越好）'));
    }
    return svg;
  }

  App.Chart = { bar: barChart, dualLine: dualLineChart };
})(window.App);

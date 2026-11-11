/* =========================================================
 * gradesize.js —— 年级人数解析（纯函数，可被 Node 直接调用）
 *
 * 优先级严格按用户要求：定位表 → 联网查询数据集 → 未知。
 *   1) 定位表：App.Locator.thresholds 中「届别 + 学校」匹配行，
 *      tb（二本B上限）近似该科类在校人数；未指定科类时物理类+历史类相加。
 *   2) 联网：App.GradeSizeData.map 里各校 2025 年招生计划（整届人数）。
 *   3) 都没有：n = null，note = '年级人数未知'。
 * ========================================================= */
(function (App) {
  'use strict';

  var G = App.GradeSize = App.GradeSize || {};

  /** 与 L.limit 同口径：空 / 非数字 / ≤0 视为未划线，返回 0 */
  function limit(v) {
    if (App.Locator && App.Locator.limit) return App.Locator.limit(v);
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  /** 定位表里「届别 + 学校」的全部匹配行 */
  function rowsOf(grade, school) {
    var list = (App.Locator && App.Locator.thresholds) || [];
    var g = String(grade || '').trim();
    var s = String(school || '').trim();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].grade || '').trim() === g && String(list[i].school || '').trim() === s) {
        out.push(list[i]);
      }
    }
    return out;
  }

  function pick(rows, track) {
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].track || '').trim() === track) return rows[i];
    }
    return null;
  }

  /**
   * 估算年级人数。
   * @param {Object} o {school, grade, track}
   * @returns {{n:(number|null), source:('locator'|'web'|null), note:string, detail:Object}}
   */
  G.estimate = function (o) {
    o = o || {};
    var school = String(o.school || '').trim();
    var grade = String(o.grade || '').trim();
    var track = String(o.track || '').trim();
    var res = {
      n: null, source: null, note: '年级人数未知', approxTrack: false,
      detail: { school: school, grade: grade, track: track, rows: [], mapHit: null }
    };

    /* ① 定位表：优先用阈值表里的二本B上限近似在校人数 */
    var rows = rowsOf(grade, school);
    res.detail.rows = rows;
    if (rows.length) {
      if (track) {
        var row = pick(rows, track);
        var tb = row ? limit(row.tb) : 0;
        if (tb > 0) {
          res.n = tb;
          res.source = 'locator';
          res.note = '定位表 · 该科类 二本B上限（近似该科类在校人数）';
          return res;
        }
      } else {
        var phy = limit(pick(rows, '物理类') ? pick(rows, '物理类').tb : 0);
        var his = limit(pick(rows, '历史类') ? pick(rows, '历史类').tb : 0);
        if (phy > 0 || his > 0) {
          res.n = phy + his;
          res.source = 'locator';
          res.note = '定位表 · 物理类+历史类 二本B上限合计';
          return res;
        }
      }
    }

    /* ② 联网查询数据集：各校 2025 年招生计划（整届人数） */
    var data = App.GradeSizeData || { map: {}, grade: '28届' };
    var map = data.map || {};
    if (school && Object.prototype.hasOwnProperty.call(map, school) && Number(map[school]) > 0) {
      res.n = Math.floor(Number(map[school]));
      res.source = 'web';
      res.note = '2025 年招生计划（联网查询，整届人数）';
      if (grade && grade !== '28届') res.note += '（按 2025 年计划估算）';
      /* 指定了科类却只能拿到整届数据：标注为近似值，避免把「整届」当「单科类」用 */
      if (track) {
        res.approxTrack = true;
        res.note += '；整届人数（含物理/历史两科类，非单科类人数），科类百分位为近似值';
      }
      res.detail.mapHit = { school: school, n: res.n, year: data.year || 2025, source: data.source || '' };
      return res;
    }

    /* ③ 未知 */
    return res;
  };
})(window.App);

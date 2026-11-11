/* =========================================================
 * analysis.js —— 成绩分析引擎（纯计算，不产出 HTML，便于单元测试）
 *
 * App.Analysis.build({target, classRows, gradeRows, studentRows, gradeSize, track})
 *   target      : 本次要分析的成绩记录
 *   classRows   : 同校同班同考试的全部记录
 *   gradeRows   : 同校同届同考试的全部记录（跨班级）
 *   studentRows : 该生历次考试记录（已按考试先后排序）
 *   gradeSize   : App.GradeSize.estimate(...) 的结果（可空）
 *   track       : '物理类' / '历史类' / ''
 *
 * 口径（高考 6 科 750 分制 + 动态选科识别）：
 *   full   = 该生已计入科目的满分之和（语数英 150×3 + 选科 100×门数，最多 3 门）
 *   passLine = round(full × 60%)（满配 450，仅语数英 270）
 *   rate   = 总分 / full —— 不同选科组合之间**唯一可比**的指标，排名一律按 rate
 *   classDiff / gradeDiff = 单科分数差（同科同满分，可直接相减）
 *   classRateDiff / gradeRateDiff = 得分率差（百分点/100），用于优势与薄弱判定
 *   0 分科目视为缺考（不计入分母）；选科超 3 门时多余科目进 dropped。
 * ========================================================= */
(function (App) {
  'use strict';

  var K = App.K, Score = App.Score, S = K.SUBJECTS;
  var RATE_GOOD = 0.75;   // 优势科目得分率门槛
  var RATE_WEAK = 0.60;   // 薄弱科目得分率门槛
  var RATE_GAP = 0.08;    // 与班均得分率相差 8 个百分点 → 视为显著落后

  var A = App.Analysis = App.Analysis || {};

  /* ---------- 数值小工具 ---------- */
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  /** 得分率 → 文本：保留 1 位小数、去掉多余的 .0（0.845 → 84.5%，0.85 → 85%） */
  function pctText(r) {
    var p = Math.round((Number(r) || 0) * 1000) / 10;
    return (Math.round(p) === p ? String(p) : p.toFixed(1)) + '%';
  }

  /** 百分位展示：0.0% 是合法值（极靠前），显示为「<0.1%」而不是「0%」 */
  function pctShow(p) {
    var n = Number(p) || 0;
    return n > 0 ? n + '%' : '<0.1%';
  }
  /** 分数差文案（单科） */
  function diffText(d, unit) {
    if (!isFinite(d) || d === 0) return '与均分持平';
    return (d > 0 ? '高于' : '低于') + unit + ' ' + App.U.f1(Math.abs(d)) + ' 分';
  }
  /** 得分率差文案（总分口径）：0.032 → 「高出班均得分率 3.2 个百分点」 */
  function rateDiffText(d, unit) {
    var p = Math.round((Number(d) || 0) * 1000) / 10;
    if (!isFinite(p) || p === 0) return '与' + unit + '得分率持平';
    return (p > 0 ? '高出' : '低于') + unit + '得分率 ' + App.U.f1(Math.abs(p)) + ' 个百分点';
  }

  /* 各科薄弱时的具体抓手（用于 summary.advice，点名科目 + 动作 + 频次） */
  var FIX = {
    '语文': '每天 15 分钟默写 5 个文言实词并回译 1 段课本原句，作文每两周写 1 篇完整提纲',
    '数学': '每天 20 分钟专练选填前 8 题（限时 15 分钟），导数与圆锥曲线只保第(1)问先拿稳 8 分',
    '英语': '每天 30 个高考 3500 词滚动复习（当天/次日/第 7 天），阅读每天 2 篇限时 16 分钟',
    '物理': '每天 3 道受力分析题必须画完整受力图，实验题按「原理—步骤—误差」三栏整理',
    '化学': '每天默写 10 个方程式（含离子方程式），每周 2 道工艺流程题按四步拆解',
    '政治': '每周 1 次 15 分钟时政梳理，主观题每周 2 题按「原理+材料+结论」限时作答',
    '历史': '每周补 1 个中外对照时间轴专题，材料题每天 1 题先划关键词再定答题层次',
    '地理': '每天判读 2 幅图表（等高线/气候/人口），区位分析每周 2 题按「自然+人文」列点',
    '生物': '每天精读 1 节教材黑体字与图表并默写概念，遗传题每周 3 题先写配子再算概率'
  };

  /* 优势科目的保持动作 */
  var KEEP = {
    '语文': '每周 1 篇限时作文 + 1 次古诗文默写自查',
    '数学': '每周 1 套 75 分钟「选填 + 前三道大题」的限时套卷',
    '英语': '每周 1 篇读后续写，固定轮换 5 个高级句式',
    '物理': '每周 2 道多过程综合题，重点练建模与分过程列式',
    '化学': '每周 2 道实验综合题，按「目的—原理—操作—结论」四栏复盘',
    '政治': '每周 1 道主观题限时 12 分钟，对照评分细则给自己的答案打分',
    '历史': '每周 1 道小论文题，固定「观点—论据—结论」三段式',
    '地理': '每周 1 道综合题，按「区域定位—要素分析—人地关系」写出完整链条',
    '生物': '每周 1 道遗传综合题 + 1 次教材概念自查'
  };

  /* 报告「优势与短板」两栏卡片要用的单句动作，业务口径与 FIX/KEEP 一致 */
  A.FIX = FIX;
  A.KEEP = KEEP;

  /**
   * 主入口
   * @param {Object} input 见文件头注释
   * @returns {Object} 纯数据对象
   */
  A.build = function (input) {
    input = input || {};
    var target = input.target || {};
    var classRows = input.classRows || [];
    var gradeRows = input.gradeRows && input.gradeRows.length ? input.gradeRows : classRows;
    var studentRows = (input.studentRows && input.studentRows.length) ? input.studentRows : [target];
    var gradeSize = input.gradeSize || null;

    /* ---------- 动态满分 / 及格线（由选科自动决定） ---------- */
    var fld = Score.fields(target);
    var total = Score.total(target);
    var full = fld.full;
    var passLine = fld.pass;
    /* 得分率只有一个实现来源：Score.totalRate()（内部 clamp 到 0..1，
     * 单科超满分等脏数据不会算出 104% 这种得分率） */
    var totalRate = Score.totalRate(target);

    var cst = Score.stat(classRows, 'total');
    var gst = Score.stat(gradeRows, 'total');
    var classAvgRate = cst.avgRate, gradeAvgRate = gst.avgRate;
    var classRateDiff = cst.count ? totalRate - classAvgRate : 0;
    var gradeRateDiff = gst.count ? totalRate - gradeAvgRate : 0;

    /* 年级总人数：定位表 / 联网数据优先，缺失时退回系统内有效人数 */
    var gradeTotal = (gradeSize && Number(gradeSize.n) > 0) ? Math.floor(Number(gradeSize.n)) : gst.count;

    /* 年级排名：教师录入的 totalRank 是校内排名，语义不变、优先级不变；
     * 系统内排名改按得分率比较（不同学生满分不同，绝对分不可直接比较） */
    var teacherRank = Number(target.totalRank) || 0;
    var sysRank = Score.rankByRate(gradeRows, target);
    var rank = 0, rankSource = 'none';
    if (teacherRank > 0) { rank = teacherRank; rankSource = 'teacher'; }
    else if (sysRank.valid) { rank = sysRank.rank; rankSource = 'system'; }
    var pct = Score.pctOf(rank, gradeTotal);
    /* 排名已录入但超出年级人数（或人数缺失）→ 百分位不可计算，禁止按 0 分档下结论。
     * 注意不能用 pct === 0 判断：pct 保留 1 位小数，第 1 名 / 3000 人 的合法结果就是 0.0%。 */
    var pctInvalid = rank > 0 && rank > gradeTotal;
    /* 班级排名恒由班级池按得分率计算 */
    var classRankObj = Score.rankByRate(classRows, target);
    var classRank = classRankObj.valid ? classRankObj.rank : 0;
    var classPct = Score.pctOf(classRank, classRankObj.total);

    /* ---------- 逐科：只处理「计入科目」 ---------- */
    var subjects = [], absent = [], dropped = [], i;
    for (i = 0; i < K.NUM_SUBJECTS; i++) {
      if (fld.all.indexOf(i) >= 0) continue;
      var outScore = Number(target.scores && target.scores[i]) || 0;
      if (outScore > 0) dropped.push(S[i]);   // 选科超 3 门被舍弃
      else absent.push(S[i]);                 // 缺考 / 未选
    }

    for (var n = 0; n < fld.all.length; n++) {
      var idx = fld.all[n];
      var score = Number(target.scores && target.scores[idx]) || 0;

      var subjFull = Score.fullOf(idx), subjPass = Score.passOf(idx);
      var rate = Score.rateOf(score, idx);
      var cstI = Score.stat(classRows, idx);
      var gstI = Score.stat(gradeRows, idx);
      var classDiff = cstI.count ? score - cstI.avg : 0;
      var gradeDiff = gstI.count ? score - gstI.avg : 0;
      var classRateDiffS = cstI.count ? rate - cstI.avgRate : 0;
      var gradeRateDiffS = gstI.count ? rate - gstI.avgRate : 0;

      var tRank = Number(target.ranks && target.ranks[idx]) || 0;
      var cRankObj = Score.rankOf(classRows, target, idx);
      var cRank = cRankObj.valid ? cRankObj.rank : 0;
      var gRankObj = tRank > 0
        ? { rank: tRank, total: gradeTotal, valid: true }
        : Score.rankOf(gradeRows, target, idx);
      var gRank = gRankObj.valid ? gRankObj.rank : 0;
      var gRankSource = tRank > 0 ? 'teacher' : (gRankObj.valid ? 'system' : 'none');
      var subjPct = Score.pctOf(gRank, gradeTotal);
      var subjPctInvalid = gRank > 0 && gRank > gradeTotal;
      var pctProp = gradeTotal > 0 && gRank > 0 ? gRank / gradeTotal : 1;
      var rankReliable = gRank > 0 && !subjPctInvalid;

      /* 优势：得分率达标 + 领先（班均/年级均按得分率差比较，跨 150/100 分制等价） */
      var isGood = rate >= RATE_GOOD &&
        (classRateDiffS > 0 || gradeRateDiffS > 0 || (rankReliable && pctProp <= 0.3));
      /* 薄弱：得分率低于 60%，或显著低于班均得分率（8 个百分点），或年级靠后且落后年级均率 */
      var isWeak = rate < RATE_WEAK ||
        (cstI.count > 0 && classRateDiffS <= -RATE_GAP) ||
        (rankReliable && gradeRateDiffS < 0 && pctProp > 0.7);
      var band = isGood ? 'good' : (isWeak ? 'weak' : 'mid');

      /* 可解释的原因，写实到数字 */
      var reasons = ['得分率 ' + pctText(rate)];
      if (score < subjPass) reasons.push('低于及格线 ' + App.U.f1(subjPass - score) + ' 分');
      else if (score > subjPass) reasons.push('高于及格线 ' + App.U.f1(score - subjPass) + ' 分');
      else reasons.push('正好达到及格线 ' + subjPass + ' 分');
      if (cstI.count) reasons.push(diffText(classDiff, '班均'));
      if (gstI.count) reasons.push(diffText(gradeDiff, '年级均'));
      if (gRank > 0) {
        reasons.push('年级第 ' + gRank + '/' + gradeTotal + ' 名' +
          (subjPctInvalid ? '（百分位待核对年级人数）' : '（前 ' + subjPct + '%）'));
      }
      if (cRank > 0) reasons.push('班级第 ' + cRank + ' 名');

      subjects.push({
        idx: idx, name: S[idx], full: subjFull, passLine: subjPass,
        score: score, rate: rate, passed: score >= subjPass,
        classAvg: cstI.count ? cstI.avg : 0, classN: cstI.count,
        classDiff: classDiff, classAvgRate: cstI.avgRate, classRateDiff: classRateDiffS,
        gradeAvg: gstI.count ? gstI.avg : 0, gradeN: gstI.count,
        gradeDiff: gradeDiff, gradeAvgRate: gstI.avgRate, gradeRateDiff: gradeRateDiffS,
        rankClass: cRank, classTotal: cRankObj.total, rankGrade: gRank, rankGradeSource: gRankSource,
        gradeTotal: gradeTotal, pct: subjPct, pctInvalid: subjPctInvalid,
        band: band, reasons: reasons
      });
    }

    /* 优势：按得分率降序；薄弱：按（及格线缺口 + 负差）降序 */
    var goodList = subjects.filter(function (s) { return s.band === 'good'; })
      .sort(function (a, b) { return b.rate - a.rate; });
    var weakList = subjects.filter(function (s) { return s.band === 'weak'; });
    weakList.sort(function (a, b) {
      var ka = Math.max(0, a.passLine - a.score) + Math.max(0, -a.classDiff) + Math.max(0, -a.gradeDiff);
      var kb = Math.max(0, b.passLine - b.score) + Math.max(0, -b.classDiff) + Math.max(0, -b.gradeDiff);
      return kb - ka;
    });
    var strengths = goodList.map(function (s) { return s.name; });
    var weaknesses = weakList.map(function (s) { return s.name; });

    /* ---------- 趋势（总分按得分率口径，跨考试可比） ---------- */
    var exams = studentRows.map(function (r) {
      var f = Score.fields(r);
      var t = Score.total(r);
      var sc = [], rk = [];
      for (var j = 0; j < K.NUM_SUBJECTS; j++) {
        sc.push(Number(r.scores && r.scores[j]) || 0);
        rk.push(Number(r.ranks && r.ranks[j]) || 0);
      }
      return {
        exam: String(r.exam || ''), total: t, full: f.full,
        rate: f.full > 0 ? Math.min(1, t / f.full) : 0,   // 与 Score.totalRate 同口径（clamp 0..1）
        totalRank: Number(r.totalRank) || 0, scores: sc, ranks: rk,
        subjectCount: f.all.length
      };
    });
    var firstExam = exams[0] || { total: total, full: full, rate: totalRate, totalRank: 0 };
    var lastExam = exams[exams.length - 1] || { total: total, full: full, rate: totalRate, totalRank: 0 };
    var totalDelta = exams.length >= 2 ? r1(lastExam.total - firstExam.total) : 0;
    var rateDelta = exams.length >= 2
      ? Math.round((lastExam.rate - firstExam.rate) * 1000) / 10 : 0;   // 百分点
    /* 名次差：正数 = 名次前进（数值变小）；两端都有排名才算，避免缺排名时误报后退 */
    var rankDelta = (exams.length >= 2 && firstExam.totalRank > 0 && lastExam.totalRank > 0)
      ? firstExam.totalRank - lastExam.totalRank : 0;

    var bySubject = [];
    for (var m = 0; m < K.NUM_SUBJECTS; m++) {
      var f0 = firstExam.scores ? firstExam.scores[m] : 0;
      var l0 = lastExam.scores ? lastExam.scores[m] : 0;
      var d0 = exams.length >= 2 ? r1(l0 - f0) : 0;
      var fr = firstExam.ranks ? firstExam.ranks[m] : 0;
      var lr = lastExam.ranks ? lastExam.ranks[m] : 0;
      var rr = (exams.length >= 2 && fr > 0 && lr > 0) ? fr - lr : 0;
      var dir = d0 > 0 ? 'up' : (d0 < 0 ? 'down' : 'flat');
      var concl;
      if (exams.length < 2) {
        concl = '仅 1 次考试，暂无法对比';
      } else {
        concl = '由 ' + App.U.f1(f0) + ' 分变为 ' + App.U.f1(l0) + ' 分（' + (d0 > 0 ? '+' : '') + App.U.f1(d0) + '）';
        if (rr !== 0) concl += '，班级排名' + (rr > 0 ? '前进 ' + rr + ' 名' : '后退 ' + Math.abs(rr) + ' 名');
        else if (fr > 0 && lr > 0) concl += '，班级排名持平';
        concl += d0 > 0 ? '，处于上升通道' : (d0 < 0 ? '，需要止跌' : '，保持稳定');
      }
      bySubject.push({
        idx: m, name: S[m], first: f0, last: l0, delta: d0,
        rankDelta: rr, dir: dir, conclusion: concl,
        counted: fld.all.indexOf(m) >= 0
      });
    }
    var trend = {
      exams: exams, totalDelta: totalDelta, rateDelta: rateDelta,
      rankDelta: rankDelta, bySubject: bySubject
    };

    /* ---------- 科目占比（只列计入科目，两个占比各自合计 100%） ----------
     * fullShare  = 该科满分 / 动态满分 × 100
     * scoreShare = 该科得分 / 总分 × 100
     */
    var share = fld.all.map(function (si) {
      var sc0 = Number(target.scores && target.scores[si]) || 0;
      var full0 = Score.fullOf(si);
      return {
        idx: si, name: S[si], full: full0, score: sc0,
        rate: Score.rateOf(sc0, si),
        fullShare: full > 0 ? full0 / full * 100 : 0,
        scoreShare: total > 0 ? sc0 / total * 100 : 0
      };
    });

    /* ---------- 班级 / 年级均分对比（单科比分数差，总分比得分率） ---------- */
    function cmpRows(statFn) {
      return subjects.map(function (s) {
        var st = statFn(s.idx);
        var avg = st.count ? st.avg : 0;
        return {
          idx: s.idx, name: s.name, score: s.score,
          avg: avg, diff: st.count ? s.score - avg : 0,
          rate: s.rate, avgRate: st.avgRate,
          rateDiff: st.count ? s.rate - st.avgRate : 0
        };
      });
    }
    var classCmp = {
      rows: cmpRows(function (i2) { return Score.stat(classRows, i2); }),
      total: {
        idx: 'total', name: '总分', score: total,
        avg: cst.count ? cst.avg : 0,
        diff: cst.count ? total - cst.avg : 0,
        rate: totalRate, avgRate: classAvgRate, rateDiff: classRateDiff
      }
    };
    var gradeCmp = {
      rows: cmpRows(function (i2) { return Score.stat(gradeRows, i2); }),
      total: {
        idx: 'total', name: '总分', score: total,
        avg: gst.count ? gst.avg : 0,
        diff: gst.count ? total - gst.avg : 0,
        rate: totalRate, avgRate: gradeAvgRate, rateDiff: gradeRateDiff
      }
    };

    /* ---------- 位次表（总分在前） ---------- */
    var rankTable = [{
      idx: 'total', name: '总分', score: total, full: full, rate: totalRate,
      rankClass: classRank, classTotal: classRankObj.total, classPct: classPct,
      rankGrade: rank, rankGradeSource: rankSource,
      gradeTotal: gradeTotal, pct: pct, pctInvalid: pctInvalid
    }];
    subjects.forEach(function (s) {
      rankTable.push({
        idx: s.idx, name: s.name, score: s.score, full: s.full, rate: s.rate,
        rankClass: s.rankClass, classTotal: s.classTotal, classPct: Score.pctOf(s.rankClass, s.classTotal),
        rankGrade: s.rankGrade, rankGradeSource: s.rankGradeSource,
        gradeTotal: s.gradeTotal, pct: s.pct, pctInvalid: s.pctInvalid
      });
    });

    /* ---------- 概述 ---------- */
    var passCount = subjects.filter(function (s) { return s.passed; }).length;
    var overview = {
      total: total,
      full: full,
      fullTotal: full,                            // 兼容旧字段名（语义 = 动态满分）
      passLine: passLine,
      passed: full > 0 && total >= passLine,
      totalRate: totalRate,
      complete: fld.complete,
      subjectCount: fld.all.length,
      coreCount: fld.coreCount,
      electiveCount: fld.electiveCount,
      missingCore: fld.missingCore.slice(),
      overflow: fld.overflow,
      droppedElectives: fld.dropped.slice(),
      classAvg: cst.count ? cst.avg : 0, classN: cst.count,
      classAvgRate: classAvgRate, classRateDiff: classRateDiff,
      gradeAvg: gst.count ? gst.avg : 0, gradeN: gst.count,
      gradeAvgRate: gradeAvgRate, gradeRateDiff: gradeRateDiff,
      classDiff: cst.count ? total - cst.avg : 0,
      gradeDiff: gst.count ? total - gst.avg : 0,
      rank: rank, rankSource: rankSource, rankTotal: gradeTotal, pct: pct, pctInvalid: pctInvalid,
      rankClass: classRank, classTotal: classRankObj.total, classPct: classPct,
      passCount: passCount, passTotal: fld.all.length,
      /* 超满分兜底：入口已截断，这里再判断一次，渲染层据此改用 min(total, full) */
      overfull: total > full
    };

    /* ---------- 成绩总结 ---------- */
    var meta = {
      school: String(target.school || ''), cls: String(target.cls || ''),
      grade: Score.gradeOf(target.cls), track: String(input.track || ''),
      exam: String(target.exam || ''), name: String(target.name || '')
    };

    var summary = buildSummary({
      meta: meta, overview: overview, subjects: subjects,
      goodList: goodList, weakList: weakList,
      absent: absent, dropped: dropped,
      trend: trend, total: total
    });

    return {
      meta: meta,
      overview: overview,
      subjects: subjects,
      strengths: strengths,
      weaknesses: weaknesses,
      absent: absent,
      dropped: dropped,
      trend: trend,
      share: share,
      classCmp: classCmp,
      gradeCmp: gradeCmp,
      rankTable: rankTable,
      summary: summary
    };
  };

  /* =========================================================
   * 成绩总结：精简版
   *   headline   1 句话（报告「一、成绩总览」的一句话结论）
   *   paragraphs 最多 2 段，每段不超过 2 句（结构化数据，供导出 / 其他视图复用）
   *   bullets    3~4 条（结构化数据，同上）
   *   advice     恰好 3 条（报告「五、优势与短板」底部「行动建议」）
   * 报告正文只用 headline 与 advice，避免与卡片/表格重复。
   * ========================================================= */
  function buildSummary(c) {
    var ov = c.overview, meta = c.meta;
    var rateTxt = pctText(ov.totalRate);
    /* 展示口径：超满分录入时统一按动态满分截断，避免出现「780 / 750」与负增量 */
    var shown = (ov.full > 0 && ov.total > ov.full) ? ov.full : ov.total;
    var gap = ov.passLine - shown;

    var headline = meta.name + '「' + meta.exam + '」总分 ' + App.U.f1(shown) + ' / ' + App.U.f1(ov.full) +
      '（得分率 ' + rateTxt + '），' + (ov.passed ? '已达' : '未达') + '及格线 ' + App.U.f1(ov.passLine) + ' 分';

    var paragraphs = [];

    /* ① 总分与相对位置（2 句内） */
    var p1 = '本次计入 ' + ov.subjectCount + ' 科（' +
      (ov.coreCount ? '语数英' : '语文/数学/英语未录全') +
      (ov.electiveCount ? ' + ' + ov.electiveCount + ' 门选科' : '') + '），合计 ' +
      App.U.f1(shown) + ' / ' + App.U.f1(ov.full) + ' 分，得分率 ' + rateTxt + '，' +
      (ov.passed
        ? '高出及格线 ' + App.U.f1(shown - ov.passLine) + ' 分'
        : '距及格线还差 ' + App.U.f1(gap) + ' 分') + '。';
    var parts = [];
    if (ov.classN) parts.push('班均得分率 ' + pctText(ov.classAvgRate) + '（本人' + rateDiffText(ov.classRateDiff, '班均') + '）');
    if (ov.gradeN) parts.push('年级均分得分率 ' + pctText(ov.gradeAvgRate));
    if (parts.length) p1 += parts.join('，') + '。';
    paragraphs.push(p1);

    /* ② 强项与短板（2 句内） */
    var goodTxt = c.goodList.length
      ? '优势科目 ' + c.goodList.slice(0, 3).map(function (s) {
        return s.name + '（得分率 ' + pctText(s.rate) + '）';
      }).join('、')
      : '暂无达到优势线（得分率 75%）的科目';
    var weakTxt = c.weakList.length
      ? '短板 ' + c.weakList.slice(0, 3).map(function (s) {
        return s.name + '（得分率 ' + pctText(s.rate) + '）';
      }).join('、')
      : '各科均未触发薄弱条件';
    var p2 = goodTxt + '；' + weakTxt + '。';
    var extra = [];
    if (c.absent.length) extra.push('本次缺考 ' + c.absent.join('、') + '（不计入分母）');
    if (c.dropped.length) extra.push('检测到 ' + (c.dropped.length + K.ELECTIVE_MAX) +
      ' 门选科成绩，按最高 ' + K.ELECTIVE_MAX + ' 门计入（' + c.dropped.join('、') + ' 未计入）');
    if (extra.length) p2 += extra.join('；') + '。';
    paragraphs.push(p2);

    /* ③ 要点：3~4 条，不重复段落里的长句 */
    var bullets = [];
    bullets.push('总分 ' + App.U.f1(shown) + ' / ' + App.U.f1(ov.full) + '（得分率 ' + rateTxt + '），' +
      (ov.passed ? '已达' : '未达') + '及格线 ' + App.U.f1(ov.passLine));
    if (ov.rank > 0) {
      bullets.push(ov.pctInvalid
        ? '年级排名 ' + ov.rank + ' / ' + ov.rankTotal + '（百分位待核对年级人数）'
        : '年级排名 ' + ov.rank + ' / ' + ov.rankTotal + '（前 ' + pctShow(ov.pct) + '）');
    } else if (ov.rankClass > 0) {
      bullets.push('班级排名 ' + ov.rankClass + ' / ' + ov.classTotal +
        (ov.classPct > 0 ? '（前 ' + pctShow(ov.classPct) + '）' : ''));
    } else {
      bullets.push('本次暂无可用排名数据（未录入总分排名，且同池样本不足）');
    }
    bullets.push('及格科目 ' + ov.passCount + ' / ' + ov.subjectCount + ' 科' +
      (ov.complete ? '（6 科齐全）' : '（选科未满 3 门或缺考）'));
    bullets.push('优势：' + (c.goodList.length ? c.goodList.map(function (s) { return s.name; }).join('、') : '暂无') +
      '　短板：' + (c.weakList.length ? c.weakList.map(function (s) { return s.name; }).join('、') : '暂无'));

    /* ④ 建议：恰好 3 条，短板优先 */
    var advice = [];
    var byRate = c.subjects.slice().sort(function (a, b) { return a.rate - b.rate; });
    var w1 = c.weakList[0] || byRate[0];
    if (w1) {
      var gapTxt = w1.passLine > w1.score
        ? '距及格线 ' + App.U.f1(w1.passLine - w1.score) + ' 分'
        : rateDiffText(w1.classRateDiff, '班均');
      advice.push('【' + w1.name + '】得分率 ' + pctText(w1.rate) + '，' + gapTxt + '：' +
        (FIX[w1.name] || '每天 25 分钟只做基础题') + '，两周内该科基础题正确率目标 ≥85%。');
    }
    var g1 = c.goodList[0];
    if (g1) {
      advice.push('【' + g1.name + '】得分率 ' + pctText(g1.rate) + '（' + rateDiffText(g1.classRateDiff, '班均') +
        '），是当前最稳的提分盘：' + (KEEP[g1.name] || '每周 1 套限时套卷保持手感') +
        '，只复盘错题思路卡点，不再重复刷已会的题。');
    } else if (byRate.length > 1) {
      var w2 = byRate[1];
      advice.push('【' + w2.name + '】得分率 ' + pctText(w2.rate) + '：' + (FIX[w2.name] || '每天 20 分钟做基础题') +
        '，下次考试该科目标先过及格线 ' + w2.passLine + ' 分。');
    }
    /* 第 3 条：位次/总分目标（按动态满分封顶；已满分时改为保持口径） */
    var stepTarget = Math.min(ov.full, shown + Math.max(10, Math.round(ov.full * 0.05)));
    if (ov.full > 0 && shown >= ov.full) {
      advice.push('目标：当前总分已达该组合满分 ' + App.U.f1(ov.full) + ' 分，目标转为保持与单科均衡，' +
        (ov.overfull ? '并先核对超分科目（本次录入总分高于满分）；' : '把时间投到最弱一科，避免长板回落；') +
        '每周至少 1 次限时套卷保持手感。');
    } else {
      advice.push('目标：把总分从 ' + App.U.f1(shown) + ' 提到 ' + App.U.f1(stepTarget) + ' 分（+' +
        App.U.f1(stepTarget - shown) + '，满分 ' + App.U.f1(ov.full) + '），' +
        (ov.rank > 0 && !ov.pctInvalid ? '年级名次从 ' + ov.rank + ' 名向前推进；' : '先把短板科目拉到及格线；') +
        '每晚按「短板 6 : 优势 4」分配自主时间，每周日复盘 1 次。');
    }
    while (advice.length < 3) {
      advice.push('错题当天清：每天睡前 15 分钟重做当天错题，同类错误连续 2 次全对才从错题本移除。');
    }
    advice = advice.slice(0, 3);

    return { headline: headline, paragraphs: paragraphs, bullets: bullets.slice(0, 4), advice: advice };
  }
})(window.App);

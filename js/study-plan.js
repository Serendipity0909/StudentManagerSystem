/* =========================================================
 * study-plan.js —— 下一阶段提分方案（结合院校定位目标）
 *
 * App.StudyPlan.build({target, analysis, loc, gradeRows, classRows})
 *   返回纯数据对象：目标档次 / 目标总分（含来源）/ 各科提分目标 / 里程碑 / 段落。
 *
 * 目标总分三条分支（旧的名次反推口径已废弃）：
 *   1) line     —— 主路径：当前总分之上最近的一条 26 届批次线（物理类 425/500/539/600/630，
 *                  历史类 440/500/546/600/630）；定位表只提供该档校内名次上限，不参与分数换算
 *   2) top      —— 已越过 985 线：不再有线可对标，转为「稳线 + 冲分」再提高 10 分
 *   3) fallback —— 物理、历史都无成绩、科类无法识别时的保底（按得分率档位缺口）
 *
 * 压线口径：总分恰好等于某条线时按「压线未稳」处理——该分数同分并列密集，
 *          不算已过线，目标直接落位上一档，避免把「刚好踩线」当成安全。
 * ========================================================= */
(function (App) {
  'use strict';

  var K = App.K, Score = App.Score;
  var P = App.StudyPlan = App.StudyPlan || {};

  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function r05(x) { return Math.round((Number(x) || 0) * 2) / 2; }

  /* =========================================================
   * 26 届高考实际批次线（目标设定的唯一分数线来源）
   *   tier 字段与 locator.js 的 L.TIERS[].name 对齐，用于取定位表名次上限；
   *   line 为该批次的最低录取控制分数线（总分口径）。
   * 说明：批次线是分数口径，定位表是名次口径。两者只在「同一档次」上对应，
   *      不能再用「每名分差 × 名次差」把名次换算成分数（同分并列时该换算失真）。
   * ========================================================= */
  var LINES26 = {
    '物理类': [
      { tier: '二本B', field: 'tb', name: '本科线（二本B）', line: 425 },
      { tier: '二本A', field: 'ta', name: '二本A线', line: 500 },
      { tier: '重点本科', field: 'ttk', name: '特控线（重点本科）', line: 539 },
      { tier: '双一流层次', field: 't211', name: '双一流线', line: 600 },
      { tier: '985层次', field: 't985', name: '985线', line: 630 }
    ],
    '历史类': [
      { tier: '二本B', field: 'tb', name: '本科线（二本B）', line: 440 },
      { tier: '二本A', field: 'ta', name: '二本A线', line: 500 },
      { tier: '重点本科', field: 'ttk', name: '特控线（重点本科）', line: 546 },
      { tier: '双一流层次', field: 't211', name: '双一流线', line: 600 },
      { tier: '985层次', field: 't985', name: '985线', line: 630 }
    ]
  };
  P.LINES26 = LINES26;      // 供测试与排查直接引用

  /** 科类：优先取定位器的判定结果，其次按「物理/历史是否有成绩」自动识别 */
  function resolveTrack(target, loc) {
    var t = loc && loc.track ? String(loc.track).trim() : '';
    if (t) return t;
    try {
      if (App.Locator && App.Locator.detectTrack) return App.Locator.detectTrack(target) || '';
    } catch (e) { /* 定位器未加载时按未识别处理 */ }
    return '';
  }

  /* =========================================================
   * 分科目、分档位的具体动作库
   *   base = 得分率 < 60%（补基础）
   *   mid  = 60% ~ 75%（题型专项）
   *   high = ≥ 75%（拔高）
   * 每条都带频次与可验收的量化标准。
   * ========================================================= */
  var ACTIONS = {
    '语文': {
      base: [
        '每天 20 分钟默写 10 个文言实词（配课本原句），连续 5 天默写正确率目标 ≥90%',
        '每周 3 篇信息类文本阅读，限时 15 分钟/篇，正确率目标 ≥70%',
        '作文素材每周积累 3 条时评，每条写 2 句自己的评论，周末抽查能复述，3 条中至少 2 条脱稿复述完整（复述完整度目标 ≥80%）'
      ],
      mid: [
        '文言文每天 5 个实词 + 1 句翻译，译文对照答案逐字改，两周后翻译题得分目标 ≥70%',
        '文学类文本每周 2 篇，按「手法—内容—效果」三栏整理答案，正确率目标 ≥80%',
        '作文每周 1 篇提纲 + 1 段开头结尾打磨，积累 3 个时评素材，提纲按「立意—结构—素材」三栏自评，三栏齐全率目标 100%'
      ],
      high: [
        '每周 1 篇完整限时作文（50 分钟），对照评分细则自评，作文目标稳定在 50 分以上（满分 60）',
        '每周 2 道古诗鉴赏压轴题，专攻「炼字 / 情感 / 手法」三类设问，得分率目标 ≥85%',
        '每两周 1 套语文限时套卷（150 分钟），作文以外题型失分控制 ≤10 分'
      ]
    },
    '数学': {
      base: [
        '每天 20 分钟专练选填前 8 题，限时 15 分钟，正确率目标 ≥90%',
        '导数 / 圆锥曲线只保第(1)问，先把每题 8 分拿稳：每周 2 次专项（每次 30 分钟），第(1)问正确率目标 ≥90%、单题得分不低于 8 分',
        '每周整理 1 次错题，按「计算失误 / 思路缺失 / 知识点漏洞」归类，同类型错题连续 2 次全对才算过关'
      ],
      mid: [
        '每天 25 分钟做 1 组中档题（数列 / 立几 / 概率），限时 20 分钟，正确率目标 ≥80%',
        '每周 2 套「选填 + 前三道大题」限时训练（75 分钟），得分目标较当前提高 10 分（150 分制）',
        '每周整理 1 次错题，只记思路卡点，同类题连续 2 次全对才算过关'
      ],
      high: [
        '每周 1 套完整限时套卷（120 分钟），压轴题至少完成第(1)问，总分目标较当前提高 10~15 分',
        '每周 3 道导数 / 圆锥曲线综合题，专练「设参—建模—讨论」的书写规范，三步齐全率目标 ≥90%',
        '错题本按章节归档，每周日重做 5 道，正确率目标 100%'
      ]
    },
    '英语': {
      base: [
        '词汇按高考 3500 词每天 30 个滚动复习（当天 / 次日 / 第 7 天），每周抽测正确率 ≥90%',
        '阅读每天 2 篇限时 16 分钟，错题回原文定位长难句，正确率目标 ≥70%（每篇错 ≤1 题）',
        '语法填空每天 1 篇，错题按「时态 / 非谓语 / 从句」归类，两周后正确率目标 ≥70%'
      ],
      mid: [
        '阅读每天 2 篇 + 1 篇七选五，限时 20 分钟，正确率目标 ≥80%',
        '续写每周 1 篇，固定 5 个高级句式轮换使用，单篇目标 18 分以上（满分 25）',
        '听力每天 1 套（20 分钟），错题精听 2 遍，目标错 ≤2 题'
      ],
      high: [
        '每周 1 套完整限时套卷（120 分钟），总分目标较当前提高 10 分',
        '读后续写每周 2 篇，重点练情节衔接与高级词汇，单篇目标 20 分以上（满分 25）',
        '完形每周 3 篇限时 15 分钟，错题回填上下文逻辑，正确率目标 ≥90%'
      ]
    },
    '物理': {
      base: [
        '受力分析与运动学每天 3 题画图规范训练，受力图必须标全力的方向，连续 5 天全对',
        '实验题按「原理—步骤—误差」三栏整理 6 个必考实验，每周复述 1 个，三栏齐全率目标 100%',
        '公式每天默写 5 条并配 1 道直接应用题，正确率目标 ≥90%'
      ],
      mid: [
        '每天 25 分钟做 1 组中档计算题（能量 / 动量 / 电场），限时 20 分钟，正确率目标 ≥80%',
        '实验题每周 2 道，按「原理—步骤—误差」三栏整理，误差分析至少写 2 条，三栏齐全且误差 ≥2 条才算达标（达标率目标 100%）',
        '每周 1 次错题重做（5 题），同类模型连续 2 次全对才算过关'
      ],
      high: [
        '每周 1 套限时套卷（75 分钟），压轴大题至少完成前两问，总分目标较当前提高 10 分（100 分制）',
        '每周 3 道多过程综合题，重点练「分过程列式 + 临界条件」，按步骤给分自评，过程分得分率目标 ≥80%',
        '实验设计题每周 1 道，写出完整步骤与误差来源，对照答案自评 ≥80%'
      ]
    },
    '化学': {
      base: [
        '方程式每天默写 10 个（含离子方程式），错 1 个补写 5 遍，连续 3 天全对',
        '元素化合物每天 1 个专题（性质—制备—用途）复述，周末抽测正确率 ≥85%',
        '选择题每天 10 道限时 10 分钟，错题标注知识点，正确率目标 ≥70%'
      ],
      mid: [
        '工艺流程题按「原料—目的—操作—产物」四步拆解，每周 2 题，四步齐全率目标 ≥90%',
        '实验题每周 2 道，按「目的—原理—装置—现象」四栏整理，四栏齐全率目标 100%',
        '每天 15 分钟专练电化学 / 平衡计算，限时完成，正确率目标 ≥80%'
      ],
      high: [
        '每周 1 套限时套卷（75 分钟），总分目标较当前提高 10 分（100 分制）',
        '每周 3 道工艺流程 / 实验综合题，专练答题模板与文字表述，对照答案踩分点覆盖目标 ≥85%',
        '错题按「概念 / 计算 / 表述」分类，每周日重做 5 题，正确率目标 100%'
      ]
    },
    '政治': {
      base: [
        '教材黑体字每天 1 节精读并默写 5 个核心概念，周末抽测正确率 ≥90%',
        '时政每周 1 次 15 分钟梳理，按「经济 / 政治 / 文化 / 哲学」归类，每个热点至少配 2 个原理（归类完整度目标 ≥90%）',
        '选择题每天 10 道限时 8 分钟，错题回教材定位，正确率目标 ≥70%'
      ],
      mid: [
        '主观题按「原理 + 材料 + 结论」三段式，每周 2 题限时 12 分钟，三段齐全率目标 100%、踩分点覆盖 ≥80%',
        '每周 1 次知识框架默写（1 个模块），框架完整度目标 ≥90%',
        '时政每周 1 次 15 分钟梳理，每个热点配 2 个可用的原理，抽测时原理与材料对应正确率目标 ≥90%'
      ],
      high: [
        '每周 1 套限时套卷（75 分钟），总分目标较当前提高 10 分（100 分制）',
        '每周 3 道主观题，对照评分细则给自己的答案打分，踩分点覆盖目标 ≥85%',
        '每两周整理 1 次易混概念对比表（如基本经济制度 / 分配制度），每对概念写 2 条区别并自测，辨析正确率目标 ≥90%'
      ]
    },
    '历史': {
      base: [
        '时间轴每周补 1 个专题（中外对照），默写 10 个关键时间节点，正确率目标 ≥90%',
        '材料题每天 1 题，先划关键词再定「背景—内容—影响」，三层齐全率目标 ≥80%',
        '教材目录每天复述 1 单元，说出 3 个核心结论，抽查结论准确率目标 ≥80%'
      ],
      mid: [
        '材料题每天 1 题限时 10 分钟，答题层次完整度目标 ≥80%',
        '每周 1 个专题时间轴 + 1 次阶段特征默写，时间轴节点 ≥10 个、默写正确率目标 ≥85%',
        '选择题每天 10 道限时 8 分钟，错题回教材定位，正确率目标 ≥80%'
      ],
      high: [
        '每周 1 套限时套卷（75 分钟），总分目标较当前提高 10 分（100 分制）',
        '每周 2 道小论文题，固定「观点—论据—结论」三段式，论点明确度自评 ≥85%',
        '每两周 1 次中外对比专题整理（同一时期政治 / 经济 / 文化三条线），三线齐全率目标 100%、每线至少 3 个史实'
      ]
    },
    '地理': {
      base: [
        '图表判读每天 2 图（等高线 / 气候 / 人口），写出判读结论，连续 5 天全对',
        '区位分析模板每周 2 题，按「自然 + 人文」列点，每题至少 4 个要点且含 2 条主导因素，要点覆盖目标 ≥80%',
        '区域地图每天认 1 个（经纬度—地形—气候），周末抽测正确率 ≥80%'
      ],
      mid: [
        '综合题每天 1 题限时 10 分钟，按「区域定位—要素分析—人地关系」写完整链条，三环齐全率目标 ≥85%',
        '图表判读每天 2 图，重点练等值线与统计图，正确率目标 ≥85%',
        '每周 2 道区位分析题，要点覆盖目标 ≥80%'
      ],
      high: [
        '每周 1 套限时套卷（75 分钟），总分目标较当前提高 10 分（100 分制）',
        '每周 3 道综合题，专练「原因—影响—措施」三类设问的答题模板，每类设问踩分点覆盖目标 ≥80%',
        '每两周整理 1 个区域专题（自然 / 人文 / 可持续），每个专题 ≥8 条素材，抽查能复述 ≥6 条（覆盖率目标 ≥75%）'
      ]
    },
    '生物': {
      base: [
        '教材黑体字与图表每天 1 节精读并默写概念，周末抽测正确率 ≥90%',
        '遗传题每周 3 题，先写配子再算概率，两步齐全率目标 100%、正确率 ≥80%',
        '选择题每天 10 道限时 8 分钟，错题回教材定位，正确率目标 ≥75%'
      ],
      mid: [
        '实验题每周 2 道，按「目的—原理—步骤—结论」四栏整理，四栏齐全率目标 100%',
        '遗传题每周 3 题，先写配子再算概率，正确率目标 ≥80%',
        '每天 15 分钟背 1 个模块的概念图，周末默写框架完整度 ≥90%'
      ],
      high: [
        '每周 1 套限时套卷（75 分钟），总分目标较当前提高 10 分（100 分制）',
        '每周 3 道遗传 / 调节综合题，专练「假设—推理—结论」的表达，三步齐全率目标 ≥85%',
        '实验设计题每周 1 道，写出自变量 / 因变量 / 无关变量，对照答案自评 ≥85%'
      ]
    }
  };

  function actionsOf(name, rate) {
    var lib = ACTIONS[name];
    var level = rate < 0.60 ? 'base' : (rate < 0.75 ? 'mid' : 'high');
    if (!lib) return ['每天 30 分钟专攻该科基础题，限时完成，正确率目标 ≥85%'];
    return lib[level].slice();
  }

  /**
   * 主入口
   * @param {Object} o {target, analysis, loc, gradeRows, classRows}
   */
  P.build = function (o) {
    o = o || {};
    var target = o.target || {};
    var analysis = o.analysis || {};
    var loc = o.loc || {};
    var gradeRows = o.gradeRows || [];
    var ov = analysis.overview || {};

    var cur = Number(ov.total);
    if (!isFinite(cur)) cur = Score.total(target);
    var curRank = Number(ov.rank) || 0;
    var gradeAvg = Number(ov.gradeAvg) || 0;

    /* ---------- 动态满分与「下一档」缺口 ----------
     * 满分 = 已计入科目的满分之和（6 科 750 / 3 科 450），由选科自动决定；
     * gap 取「及格线 / 得分率 70% / 得分率 80%」三档中距当前最近、且尚未达成的缺口。
     */
    var full = Number(ov.full);
    if (!isFinite(full) || full <= 0) full = Score.fullTotal(target);
    if (!(full > 0)) full = 0;
    var passLine = Number(ov.passLine);
    if (!isFinite(passLine) || passLine <= 0) passLine = Math.round(full * K.PASS_RATE);
    var curRate = full > 0 ? cur / full : 0;

    var gaps = [];
    if (cur < passLine) gaps.push({ name: '及格线', gap: passLine - cur });
    if (curRate < 0.70) gaps.push({ name: '得分率 70%', gap: full * 0.70 - cur });
    if (curRate < 0.80) gaps.push({ name: '得分率 80%', gap: full * 0.80 - cur });
    var nextTier = { name: '', gap: 0 };
    for (var gi = 0; gi < gaps.length; gi++) {
      if (!(nextTier.gap > 0) || gaps[gi].gap < nextTier.gap) nextTier = gaps[gi];
    }
    var tierNeed = nextTier.gap > 0 ? Math.max(1, Math.round(nextTier.gap)) : 10;

    /* ---------- 目标档次 ---------- */
    var tier = {
      ok: !!loc.ok,
      name: String(loc.tierName || ''),
      gap: Number(loc.gap) || 0,
      nextName: String(loc.nextName || ''),
      reachedTop: !!loc.reachedTop,
      noUpper: !!loc.noUpper,
      reason: String(loc.reason || '')
    };

    /* ---------- 目标总分：定位表档次 × 26 届批次线 ----------
     * 旧口径用「年级第 N 名的分数」或「每名分差」把名次反推成分数。同分并列大量存在时，
     * 一个分数往往对应几十人、名次与分数不再一一对应，反推出来的目标分不可靠，故废弃。
     * 新口径：
     *   ① 档次由定位表的排名判定（loc.tierName / nextName，已是「名次 ≤ 上限」的口径，不怕同分并列）；
     *   ② 目标分数直接取「上一档次」对应的 26 届实际批次线，不再做任何分差换算；
     *   ③ 若当前分数已越过该线（分数跑在名次前面），顺延到分数之上的最近一条线，
     *      避免目标分低于现有分数这种无效目标；
     *   ④ 定位表给不出档次（无排名/学校无数据）时，退回「分数之上的最近一条线」。
     */
    var track = resolveTrack(target, loc);
    var lines = LINES26[track] || null;   // 科类判定不出来时为 null → 不做批次线对标
    /* 展示口径：超满分脏数据按动态满分计，避免拿 780 去和 630 的线比较 */
    var cmp = full > 0 ? Math.min(cur, full) : cur;

    /* 当前分数落在哪条线（用于压线判定与文案） */
    var atIdx = -1, onLine = false;
    if (lines) {
      for (var li = 0; li < lines.length; li++) {
        if (cmp >= lines[li].line) {
          atIdx = li;
          onLine = (cmp === lines[li].line);   // 正好压在线上：该分段同分并列密集
        }
      }
    }
    var curLine = atIdx >= 0 ? lines[atIdx] : null;

    /* 定位表档次 → 目标线 */
    var lineOfTier = function (name) {
      if (!lines || !name) return null;
      for (var i = 0; i < lines.length; i++) if (lines[i].tier === name) return lines[i];
      return null;
    };
    var cutoffOf = function (ln) {
      if (!ln || !loc || !loc.row || !App.Locator || !App.Locator.limit) return 0;
      return App.Locator.limit(loc.row[ln.field]) || 0;
    };

    var nextLine = null, targetFromRank = false, rankOnEdge = false, cutoff = 0;
    if (lines && loc && loc.ok && !loc.reachedTop && loc.nextName) {
      var tl = lineOfTier(loc.nextName);
      if (tl && tl.line > cmp) {
        nextLine = tl;
        targetFromRank = true;
        cutoff = Number(loc.nextLimit) || cutoffOf(tl);
      }
    }
    /* 名次压线：排名正好等于「当前档次」的划线上限——按「上限 ≥ 排名」规则算进档，
     * 但同分并列时随时可能被挤出，需在文案里提示留余量 */
    if (loc && loc.ok && Number(loc.limit) > 0 && Number(loc.rank) === Number(loc.limit)) {
      rankOnEdge = true;
    }
    if (!nextLine && lines) {
      /* 无定位档次，或分数已越过名次目标线：按分数找最近一条线 */
      for (var lj = 0; lj < lines.length; lj++) {
        if (lines[lj].line > cmp) { nextLine = lines[lj]; break; }
      }
      if (nextLine) cutoff = cutoffOf(nextLine);
    }
    var lineOverFull = !!(nextLine && full > 0 && nextLine.line > full);

    var targetTotal = 0, source = 'fallback', note = '';
    if (nextLine && lines) {
      targetTotal = lineOverFull ? full : nextLine.line;
      source = 'line';
      note = targetFromRank
        ? '定位表按名次判定：当前 ' + (loc.tierName || '—') + '，升入「' + loc.nextName +
          '」需进入前 ' + (cutoff || loc.nextLimit) + ' 名；该档次对应 26 届' + track + '批次线 ' +
          nextLine.name + ' ' + nextLine.line + ' 分'
        : '26 届' + track + '批次线「' + nextLine.name + '」' + nextLine.line + ' 分（定位表未给出可用名次，按分数就近对标）';
      note += onLine
        ? '；当前 ' + App.U.f1(cmp) + ' 分正好压在「' + curLine.name + ' ' + curLine.line + ' 分」线上，' +
          '该分段同分并列密集、按「压线未稳」处理，目标直接落位上一档'
        : '；当前 ' + App.U.f1(cmp) + ' 分距该线 ' + App.U.f1(r1(nextLine.line - cmp)) + ' 分';
      if (rankOnEdge) {
        note += '；当前名次正好等于「' + (loc.tierName || '当前档次') + '」的划线上限 ' + loc.limit +
          ' 名，属于压线进档，同分并列时可能被挤出该档次，建议再多进约 ' +
          Math.max(1, Math.round(Number(loc.limit) * 0.03)) + ' 名留出余量';
      }
      if (lineOverFull) note += '；该组合动态满分仅 ' + App.U.f1(full) + ' 分，低于该线，已按满分封顶';
    } else if (lines) {
      /* 已越过最高批次线：不再有线可对标，转为稳线冲分 */
      var topLine = lines[lines.length - 1];
      source = 'top';
      targetTotal = Math.min(full, cmp + 10);
      note = '26 届' + track + '最高批次线为 985 线 ' + topLine.line + ' 分，当前 ' + App.U.f1(cmp) +
        ' 分已越线，目标转为「稳线 + 冲分」：再提高 10 分以扩大同批次院校与专业的选择空间';
    } else {
      /* 科类判定不出来：物理、历史都没有成绩，或两科同时有分（数据异常）。
       * 批次线分物理/历史两套，科类不明就不硬套，退回得分率档位并明确提示补录。 */
      targetTotal = Math.min(full, cur + tierNeed);
      source = 'fallback';
      note = '未能按成绩判定科类（物理、历史两科都没有成绩或同时有分），26 届批次线分物理类/历史类两套，' +
        '科类不明时不硬套；请补录物理或历史成绩后重新生成。' +
        (nextTier.gap > 0
          ? '当前暂按距「' + nextTier.name + '」的缺口 ' + App.U.f1(nextTier.gap) + ' 分设定'
          : '当前已达成得分率 80% 档位，暂按再提高 ' + tierNeed + ' 分设定');
    }
    if (!(targetTotal > cur)) targetTotal = Math.min(full, cur + tierNeed);
    if (full > 0 && targetTotal > full) targetTotal = full;
    targetTotal = r1(targetTotal);

    /* ---------- 总分增量（只在本生已计入科目内分摊，保证单科不超满分） ---------- */
    var deltaRaw = Math.max(0, r1(targetTotal - cur));
    var headroom = 0, activeIdx = [];
    var fld = Score.fields(target);
    for (var j = 0; j < fld.all.length; j++) {
      var jdx = fld.all[j];
      var sc0 = Number(target.scores && target.scores[jdx]) || 0;
      activeIdx.push(jdx);
      headroom += Math.max(0, Score.fullOf(jdx) - sc0);
    }
    headroom = Math.max(0, r1(headroom));
    var delta = Math.min(deltaRaw, headroom);
    var planFull = full > 0 ? full : r1(cur + delta);        // 该选科组合的天花板
    /* 目标总分 = min(该组合动态满分, 当前 + 增量)。
       单科超满分（历史脏数据）时 cur 可能已高于动态满分，故必须封顶，
       否则会出现「目标总分 780（动态满分 750，需提高 0 分）」这种自相矛盾的句子。 */
    targetTotal = Math.min(planFull, r1(cur + delta));
    delta = Math.max(0, r1(targetTotal - cur));
    var atFull = full > 0 && cur >= full;                    // 已达/超过该组合的动态满分
    var overFull = full > 0 && cur > full;                   // 真·超满分（历史脏数据）
    if (atFull) {
      delta = 0;
      targetTotal = r1(planFull);
      note = overFull
        ? '已满分（该组合满分 ' + App.U.f1(planFull) + ' 分），但录入总分 ' + r1(cur) + ' 分属超满分录入，需先核对超分科目；目标转为保持与单科均衡'
        : '已达该组合满分（' + App.U.f1(planFull) + ' 分），目标转为保持与单科均衡';
    }

    /* ---------- 分摊到科目：w_i = full_i × (1.25 − rate_i) ---------- */
    var weights = [], sumW = 0;
    for (var k = 0; k < activeIdx.length; k++) {
      var idx = activeIdx[k];
      var s = Number(target.scores[idx]) || 0;
      var fullI = Score.fullOf(idx);
      var rate = Score.rateOf(s, idx);
      var w = Math.max(0, fullI * (1.25 - rate));
      weights.push({ idx: idx, w: w });
      sumW += w;
    }
    if (!(sumW > 0)) {
      for (var q = 0; q < weights.length; q++) weights[q].w = 1;
      sumW = weights.length || 1;
    }

    var perSubject = weights.map(function (it) {
      var idx2 = it.idx;
      var s2 = Number(target.scores[idx2]) || 0;
      var full2 = Score.fullOf(idx2);
      var alloc = delta * it.w / sumW;
      var room = Math.max(0, full2 - s2);
      alloc = Math.min(alloc, room);
      alloc = Math.min(r05(alloc), r05(room));
      return {
        idx: idx2, name: K.SUBJECTS[idx2], cur: s2,
        goal: r1(s2 + alloc), delta: alloc,
        rate: Score.rateOf(s2, idx2), full: full2,
        priority: 3,
        actions: actionsOf(K.SUBJECTS[idx2], Score.rateOf(s2, idx2))
      };
    });

    /* 舍入误差补齐：按权重从大到小，逐科补足剩余额度 */
    var sumAlloc = perSubject.reduce(function (a, x) { return a + x.delta; }, 0);
    var residual = r1(delta - sumAlloc);
    if (Math.abs(residual) > 0.001) {
      var order = perSubject.slice().sort(function (a, b) {
        return b.full * (1.25 - b.rate) - a.full * (1.25 - a.rate);
      });
      for (var n = 0; n < order.length && Math.abs(residual) > 0.001; n++) {
        var it2 = order[n];
        var room2 = Math.max(0, it2.full - it2.cur - it2.delta);
        if (residual > 0) {
          var add = Math.min(residual, room2);
          if (add > 0) { it2.delta = r1(it2.delta + add); it2.goal = r1(it2.cur + it2.delta); residual = r1(residual - add); }
        } else {
          var sub = Math.min(-residual, it2.delta);
          if (sub > 0) { it2.delta = r1(it2.delta - sub); it2.goal = r1(it2.cur + it2.delta); residual = r1(residual + sub); }
        }
      }
      /* 极端情况（可提升空间已被现实分数占满）：以实际分摊额为准，保证口径自洽 */
      if (Math.abs(residual) > 0.001) {
        delta = r1(perSubject.reduce(function (a, x) { return a + x.delta; }, 0));
        targetTotal = Math.min(planFull, r1(cur + delta));   // 仍需动态满分封顶
      }
    }

    /* ---------- 优先级：按提分额降序 1/2/3 ---------- */
    var ranked = perSubject.slice().sort(function (a, b) { return b.delta - a.delta; });
    for (var p = 0; p < ranked.length; p++) ranked[p].priority = Math.min(3, p + 1);
    perSubject.sort(function (a, b) { return a.idx - b.idx; });

    /* ---------- 里程碑 ---------- */
    var milestones = [];
    var midTotal = Math.min(planFull, r1(cur + delta * 0.6));   // 中间节点同样不得超满分
    /* 名次节点直接取定位表：目标批次线的校内名次上限（不再用「当前名次 − 缺口」反推）；
     * 已越最高线时没有「上一档」，改用当前档次的上限作为「保持」底线 */
    var keepRankMode = !nextLine && !!(loc && loc.ok && Number(loc.limit) > 0);
    var endRank = cutoff > 0 ? cutoff : (keepRankMode ? Number(loc.limit) : 0);
    var midRank = 0;
    if (endRank > 0) {
      midRank = keepRankMode
        ? endRank                                    // 保档场景两个节点用同一底线，避免「前 50」与「前 300」自相矛盾
        : (curRank > endRank
          ? Math.max(endRank, Math.round(curRank - (curRank - endRank) * 0.6))
          : (curRank > 0 ? curRank : endRank));
    }
    /* 名次未知（curRank=0 且定位表无划线）时不能拼出「前 0 名」，统一改为待补充排名 */
    var midRankTxt = midRank > 0 ? (keepRankMode ? '名次保持在前 ' + midRank + ' 名' : '名次进入前 ' + midRank + ' 名')
      : '名次目标待补充排名后确定';
    var endRankTxt = endRank > 0 ? (keepRankMode ? '年级名次保持在前 ' + endRank + ' 名' : '年级名次进入前 ' + endRank + ' 名')
      : '名次目标待补充排名后确定';
    var goalLabel = nextLine ? ('「' + nextLine.name + '」' + nextLine.line + ' 分') : '';
    milestones.push({
      when: '下一次考试',
      rank: midRank,
      total: midTotal,
      note: nextLine
        ? '总分先到 ' + midTotal + ' 分（完成目标增量 60%），' + midRankTxt + '，为达到' + goalLabel + '铺路'
        : '总分先到 ' + midTotal + ' 分，' + midRankTxt + '，稳住当前' + (source === 'top' ? ' 985 线以上' : '成绩') + '水平'
    });
    milestones.push({
      when: '本学期末',
      rank: endRank,
      total: targetTotal,
      note: nextLine
        ? '总分达到 ' + targetTotal + ' 分，即达到' + goalLabel + '，' + endRankTxt + '，可报考该批次院校'
        : '总分达到 ' + targetTotal + ' 分，' + endRankTxt +
          (source === 'top' ? '，在最高批次内扩大院校与专业选择空间' : '，巩固当前批次')
    });

    /* ---------- 段落 ---------- */
    var paragraphs = [];
    if (tier.ok && tier.gap > 0 && !tier.reachedTop && !tier.noUpper) {
      paragraphs.push('目标档次：当前可报「' + tier.name + '」，只需再超越 ' + tier.gap +
        ' 名同学（进入前 ' + loc.nextLimit + ' 名）即可升到「' + tier.nextName + '」。' +
        (curRank > 0 ? '你现在的年级名次是 ' + curRank + ' 名，' : ''));
    } else if (tier.reachedTop) {
      paragraphs.push('目标档次：本次排名已达到表内最高档次「' + tier.name +
        '」，不再设定更高名次目标，重点转为院校与专业选择（按近三年录取位次分「冲 / 稳 / 保」三档）。');
    } else if (tier.noUpper) {
      paragraphs.push('目标档次：当前已是本届本校有划线的最高档次「' + tier.name +
        '」，上方档次未划线，提分目标改为「稳住档次 + 扩大同档位专业选择空间」。');
    } else {
      paragraphs.push('目标档次：本次未能按院校定位器判定档次（' +
        (tier.reason === 'no-school' ? '定位表暂无该学校数据' : (tier.reason === 'no-rank' ? '缺少总分排名' : '排名未达表内最低线')) +
        '），提分目标改按 26 届批次线设定，不再用名次反推分数。');
    }

    if (atFull) {
      paragraphs.push('目标总分：' + targetTotal + ' 分（该组合动态满分 ' + App.U.f1(planFull) + ' 分）。' +
        (overFull
          ? '当前录入总分 ' + r1(cur) + ' 分，比满分高出 ' + App.U.f1(r1(cur - planFull)) +
            ' 分，属超满分录入，需先核对超分科目；目标转为保持与单科均衡，不再叠加提分量。依据：' + note + '。'
          : '当前已满分，目标转为保持与单科均衡，不再叠加提分量。依据：' + note + '。'));
    } else {
      paragraphs.push('目标总分：' + targetTotal + ' 分（当前 ' + App.U.f1(cmp) + ' 分，动态满分 ' + App.U.f1(full) +
        ' 分，需提高 ' + App.U.f1(delta) + ' 分）。依据：' + note + '。');
    }

    var top = ranked.slice(0, 3).filter(function (x) { return x.delta > 0; });
    if (top.length) {
      paragraphs.push('增量分配：' + top.map(function (x) {
        return x.name + ' +' + App.U.f1(x.delta) + ' 分（' + App.U.f1(x.cur) + ' → ' + App.U.f1(x.goal) + '）';
      }).join('、') + '；其余科目以保持为主。分配权重 = 计入科目满分 ×（1.25 − 当前得分率），' +
        '同样得分的百分率下，满分越高的科目分到越多增量。');
    } else {
      paragraphs.push('增量分配：当前各科已接近满分，无需再分摊提分额，保持训练节奏即可。');
    }

    paragraphs.push('执行节奏：每天固定 2 个 25 分钟的专项时段（先补 priority 1 的科目），' +
      '每周日 1 次错题复盘 + 1 次限时套卷，每两周按「下一次考试」里程碑核对一次进度；' +
      '若某科连续两周未达成动作里的量化验收标准，就把该科时段延长 10 分钟并下调当日题量。');

    return {
      tier: tier,
      targetTotal: targetTotal,
      targetTotalSource: source,
      track: track,
      trackAssumed: !track,           // 科类未判定（物理/历史无成绩或同时有分），未套用批次线
      targetLine: nextLine ? { tier: nextLine.tier, name: nextLine.name, line: nextLine.line } : null,
      curLine: curLine ? { tier: curLine.tier, name: curLine.name, line: curLine.line } : null,
      onLine: onLine,                 // 当前分正好压在某条批次线上
      targetFromRank: targetFromRank, // 目标线由定位表档次决定（否则按分数就近对标）
      rankOnEdge: rankOnEdge,         // 名次正好卡在该档上限
      rankCutoff: cutoff,             // 目标档次的定位表名次上限（0 = 未划线）
      delta: delta,
      perSubject: perSubject,
      milestones: milestones,
      paragraphs: paragraphs
    };
  };
})(window.App);

/* =========================================================
 * locator.js —— 模块：院校定位（查询定位器）
 * 依据《26号查询定位器》的阈值表，按「届别 + 学校 + 科类 + 校内总分排名」
 * 判定该生当前可报考的院校层次，并给出距上一档次的名次差与提分建议。
 * 依赖：core.js（App.U / App.Score / App.K）、data-locator.js（App.Locator 数据）
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Score = App.Score, S = App.K.SUBJECTS;
  var L = App.Locator = App.Locator || {};

  /* ---------- 档次定义：顺序即判定顺序（从高到低，不可调换） ---------- */
  L.TIERS = [
    { name: '985层次', field: 't985', label: '985上限' },
    { name: '双一流层次', field: 't211', label: '双一流上限' },
    { name: '重点本科', field: 'ttk', label: '特控上限' },
    { name: '二本A', field: 'ta', label: '二本A上限' },
    { name: '二本B', field: 'tb', label: '二本B上限' }
  ];

  /* 科目固定顺序里物理、历史的下标（core.js 的 K.SUBJECTS） */
  var IDX_PHY = S.indexOf('物理');
  var IDX_HIS = S.indexOf('历史');

  /* 用户手动选择的科类（按学生唯一键保存，换学生自动失效） */
  var manual = { key: '', track: '' };

  /* 阈值索引：(届别 + 学校 + 科类) -> 阈值行，只建一次 */
  var indexCache = null;
  function index() {
    if (indexCache) return indexCache;
    indexCache = {};
    var list = L.thresholds || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      indexCache[thKey(t.grade, t.school, t.track)] = t;
    }
    return indexCache;
  }
  function thKey(grade, school, track) {
    return String(grade || '').trim() + '|' + String(school || '').trim() + '|' + String(track || '').trim();
  }

  /**
   * 名次上限规范化：空 / null / 非数字 / 0 都视为「未划线」返回 0。
   * @param {*} v 原始上限值
   * @returns {number} >0 表示有效上限，0 表示该档没有划线
   */
  L.limit = function (v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  };

  /**
   * 从班级字段里取届别：统一委托 Score.gradeOf（core.js 内的同一套逻辑），
   * 类字段本身就是届别（如「28届」）时原样返回；形如「28届高三3班」时抽出「28届」，
   * 取不到就返回 trim 后的原值（交给阈值表去匹配，匹配不上会给出提示）。
   * @param {string} cls 记录的班级字段
   * @returns {string}
   */
  L.gradeOf = function (cls) {
    if (Score && Score.gradeOf) return Score.gradeOf(cls);
    var s = String(cls || '').replace(/\s|\u3000/g, '');
    var m = s.match(/(\d{1,2})届/);
    return m ? (m[1] + '届') : String(cls || '').trim();
  };

  /**
   * 科类判定：物理 > 0 记物理类；否则历史 > 0 记历史类；
   * 两者都有分或都缺考（0）时返回空串，交由用户在界面上手动选择。
   * @param {Object} rec 成绩记录
   * @returns {string} '物理类' | '历史类' | ''
   */
  L.detectTrack = function (rec) {
    var phy = IDX_PHY >= 0 ? (Number(rec.scores[IDX_PHY]) || 0) : 0;
    var his = IDX_HIS >= 0 ? (Number(rec.scores[IDX_HIS]) || 0) : 0;
    if (phy > 0 && his <= 0) return '物理类';
    if (his > 0 && phy <= 0) return '历史类';
    return '';
  };

  /**
   * 取该生最终用于定位的科类：自动判定优先，判定不了时读用户手选值。
   * @param {Object} rec 成绩记录
   * @returns {{track: string, auto: boolean}}
   */
  L.trackOf = function (rec) {
    var auto = L.detectTrack(rec);
    if (auto) return { track: auto, auto: true };
    var k = Score.key(rec);
    return { track: (manual.key === k ? manual.track : ''), auto: false };
  };

  /** 记录用户手动选择的科类（按学生唯一键隔离） */
  L.chooseTrack = function (rec, track) {
    manual.key = Score.key(rec);
    manual.track = track || '';
  };

  /** 取该档次对应的大学参考名单（展示时去重，保持原顺序） */
  L.schoolsOf = function (tierName) {
    var list = L.universities || [], out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i].tier !== tierName) continue;
      var arr = list[i].schools || [];
      for (var j = 0; j < arr.length; j++) {
        var nm = String(arr[j] || '').trim();
        if (!nm || seen[nm]) continue;
        seen[nm] = 1;
        out.push(nm);
      }
    }
    return out;
  };

  /**
   * 阈值表里实际收录的学校名单（去重、保持原顺序）。
   * 只用于给「暂无该学校数据」这条提示配一行浅色辅助信息，不参与任何匹配。
   * @param {string} [grade] 指定届别时只返回该届有的学校
   * @returns {Array<string>}
   */
  L.supportedSchools = function (grade) {
    var list = L.thresholds || [], out = [], seen = {};
    var g = grade ? String(grade).trim() : '';
    for (var i = 0; i < list.length; i++) {
      if (g && String(list[i].grade || '').trim() !== g) continue;
      var nm = String(list[i].school || '').trim();
      if (!nm || seen[nm]) continue;
      seen[nm] = 1;
      out.push(nm);
    }
    return out;
  };

  /**
   * 核心：档次判定。
   * 规则：按 985 → 双一流 → 特控 → 二本A → 二本B 的顺序，
   *      取「第一个满足 上限 ≥ 排名」的档次（数据非严格单调，必须顺序取首个命中，不能排序取最大）。
   * @param {Object} o {grade, school, track, rank}
   * @returns {Object} res —— ok=true 时含 tier/tierIdx/limit/next/gap 等；ok=false 时含 reason
   */
  L.locate = function (o) {
    o = o || {};
    var rank = Number(o.rank);
    var res = {
      ok: false, reason: '', rank: (isFinite(rank) && rank > 0) ? Math.floor(rank) : 0,
      grade: String(o.grade || '').trim(), school: String(o.school || '').trim(),
      track: String(o.track || '').trim(), row: null,
      tierIdx: -1, tierName: '', limit: 0,
      nextIdx: -1, nextName: '', nextLimit: 0, gap: 0,
      reachedTop: false,   // 已在最高档「985层次」
      noUpper: false,      // 上方档次全部未划线（无法计算名次差）
      schools: []
    };
    if (!res.track) { res.reason = 'no-track'; return res; }

    var row = index()[thKey(res.grade, res.school, res.track)];
    if (!row) { res.reason = 'no-school'; return res; }
    res.row = row;

    if (!res.rank) { res.reason = 'no-rank'; return res; }

    // 顺序扫描：首个「上限 ≥ 排名」的档次即为当前可报层次
    for (var i = 0; i < L.TIERS.length; i++) {
      var lim = L.limit(row[L.TIERS[i].field]);
      if (lim > 0 && lim >= res.rank) {
        res.ok = true;
        res.tierIdx = i;
        res.tierName = L.TIERS[i].name;
        res.limit = lim;
        res.schools = L.schoolsOf(res.tierName);
        break;
      }
    }
    if (!res.ok) { res.reason = 'below-min'; return res; }

    // 上一档次：从当前档往高走，找第一个「有划线」的档次
    for (var j = res.tierIdx - 1; j >= 0; j--) {
      var up = L.limit(row[L.TIERS[j].field]);
      if (up > 0) {
        res.nextIdx = j;
        res.nextName = L.TIERS[j].name;
        res.nextLimit = up;
        res.gap = res.rank - up;      // 需要再超越的名次数（上限 < 排名，恒 > 0）
        break;
      }
    }
    // 上方没有任何「有划线」的档次：
    //   已在 985层次 → 已达最高档次；否则属于上方档次未划线，不能说「已达最高档次」
    if (res.nextIdx < 0) {
      if (res.tierIdx === 0) res.reachedTop = true;
      else res.noUpper = true;
    }
    return res;
  };

  /**
   * 针对「达成下一档次」的后续学习建议（具体到科目、名次、趋势，不说套话）。
   * @param {Object} target 当前学生本次记录
   * @param {Array} classRows 同校同班同考试的所有记录
   * @param {Array} studentRows 该生历次考试（按考试顺序）
   * @param {Object} loc L.locate 的结果
   * @returns {Array<string>} 建议条目
   */
  L.advice = function (target, classRows, studentRows, loc) {
    var tips = [];
    var rank = loc.rank;

    /* 1）名次目标：把「还需提升 N 名」落到具体名次上 */
    if (loc.reachedTop) {
      tips.push('名次目标：当前排名 ' + rank + ' 名，已达到表内最高档次「' + loc.tierName +
        '」，后续重点放在院校与专业选择上：在参考名单内按近三年录取位次分「冲 / 稳 / 保」三档填报，' +
        '保底院校的录取位次要低于自己当前排名。');
    } else if (loc.noUpper) {
      tips.push('名次目标：当前排名 ' + rank + ' 名，已是本届本校有划线的最高档次「' + loc.tierName +
        '」；上方「985层次」本届未划线，暂无更靠前的名次目标，' +
        '建议把精力放在同档次院校的专业选择上（参考名单里挑录取位次与自己匹配度最高的专业组）。');
    } else {
      tips.push('名次目标：当前排名 ' + rank + ' 名，只需再超越 ' + loc.gap + ' 名同学（进入前 ' +
        loc.nextLimit + ' 名），即可由「' + loc.tierName + '」升到「' + loc.nextName +
        '」，本次到下次考试之间把总分再往上推一点即可达成。');
    }

    /* 2）历次排名参照：用已有记录算进步幅度，判断目标是否现实 */
    var prevRank = 0, prev = null;
    for (var i = studentRows.length - 2; i >= 0; i--) {
      var r = Number(studentRows[i].totalRank) || 0;
      if (r > 0) { prevRank = r; prev = studentRows[i]; break; }
    }
    if (prev && prevRank > 0 && !loc.reachedTop && !loc.noUpper) {
      var moved = prevRank - rank;                 // 正数=名次进步
      if (moved > 0) {
        tips.push('进步参照：上次「' + prev.exam + '」排名 ' + prevRank + ' 名，本次前进了 ' + moved +
          ' 名；按这个幅度，再考 ' + Math.max(1, Math.ceil(loc.gap / moved)) + ' 次即可跨进「' +
          loc.nextName + '」（还需 ' + loc.gap + ' 名）。');
      } else if (moved < 0) {
        tips.push('进步参照：上次「' + prev.exam + '」排名 ' + prevRank + ' 名，本次后退了 ' +
          Math.abs(moved) + ' 名；先止住退步再谈提升，否则「' + loc.nextName + '」的 ' +
          loc.gap + ' 名差距会被继续拉大。');
      } else {
        tips.push('进步参照：与上次「' + prev.exam + '」排名持平（同为 ' + prevRank +
          ' 名），需要在下一次考试里至少再追回 ' + loc.gap + ' 名才能摸到「' + loc.nextName + '」线。');
      }
    }

    /* 3）薄弱科目：低于班均最多的科目优先，直接沿用成绩报告里的单科口径 */
    var subs = [];
    for (var k = 0; k < S.length; k++) {
      var sc = Number(target.scores[k]) || 0;
      if (sc <= 0) continue;                       // 0 分视为缺考，不参与统计
      var st = Score.stat(classRows, k);
      if (!st.count) continue;
      subs.push({ idx: k, name: S[k], score: sc, diff: sc - st.avg, rank: Number(target.ranks[k]) || 0, stat: st });
    }
    subs.sort(function (a, b) { return a.diff - b.diff; });
    var weak = subs.filter(function (x) { return x.diff < 0; }).slice(0, 3);

    if (weak.length) {
      var parts = [];
      for (var w = 0; w < weak.length; w++) {
        var it = weak[w];
        var trend = Score.history(studentRows, it.idx, it.score);
        var adv = Score.advice(it.idx, it.score, it.diff, trend.desc);
        if (adv.indexOf(it.name) === 0) adv = adv.slice(it.name.length);   // 去掉重复出现的科目名
        parts.push('【' + it.name + '】' + U.f1(it.score) + ' 分，低于班均 ' + U.f1(Math.abs(it.diff)) +
          ' 分' + (it.rank ? '，班排 ' + it.rank : '') + '，' + (trend.conclusion || '暂无历史趋势') +
          '：' + adv);
      }
      tips.push('提分抓手（优先补这 ' + weak.length + ' 科，它们是拉低总分、挡住名次的主因）：' + parts.join('；'));
    } else if (subs.length) {
      var low = subs.slice(0, 2).map(function (x) { return x.name; });
      tips.push('各科均不低于班均，短板不明显；冲' + (loc.reachedTop ? '更高位次' : '「' + loc.nextName + '」') +
        '可把 ' + low.join('、') + ' 的难题得分率再往上提，用优势科目拉开与同分段考生的差距。');
    } else {
      tips.push('本次考试没有有效科目成绩，无法定位薄弱科目；请先补全各科分数，再做提分规划。');
    }

    /* 4）总分位置：与班均的差值，说明提分空间有多大 */
    var tSt = Score.stat(classRows, 'total');
    if (tSt.count) {
      var d = Score.total(target) - tSt.avg;
      tips.push('总分位置：本次总分 ' + Score.total(target) + ' 分，班级均分 ' + U.f1(tSt.avg) + ' 分，' +
        (d >= 0 ? '高出 ' + U.f1(d) + ' 分，可继续扩大优势' : '还差 ' + U.f1(Math.abs(d)) +
          ' 分，把这部分补回来就是最直接的提分空间') + '。');
    }

    if (!loc.reachedTop && !loc.noUpper) {
      tips.push('一句话目标：还需提升约 ' + loc.gap + ' 名，锁定「' + loc.nextName +
        '」；下次考试前把上面几科的薄弱知识点逐条清零，是最快的提名次路径。');
    }
    return tips;
  };

  /* ---------- 展示：嵌入成绩分析报告的「院校定位」区块 ---------- */
  /**
   * @param {Object} target 当前学生本次记录
   * @param {Array} classRows 同班记录
   * @param {Array} studentRows 该生历次记录
   * @returns {string} HTML
   */
  L.sectionHTML = function (target, classRows, studentRows) {
    return '<div class="r-sec">院校定位（查询定位器）</div><div class="r-body">' +
      L.bodyHTML(target, classRows, studentRows) + '</div>';
  };

  /**
   * 定位区块正文（不含外层 r-sec / r-body 包装）
   * 供成绩报告「六、阶段规划」内嵌使用，避免出现第二个章节标题。
   */
  L.bodyHTML = function (target, classRows, studentRows) {
    var Ue = U.esc;
    var grade = L.gradeOf(target.cls);
    var tk = L.trackOf(target);
    var h = '';

    /* 定位条件一行：届别 / 学校 / 科类 / 排名，科类判定不了时给下拉 */
    h += '<div class="loc-head"><div class="loc-cond">' +
      '<span class="chip ch-blue">' + Ue(grade) + '</span>' +
      '<span class="chip ch-blue">' + Ue(target.school) + '</span>' +
      '<span class="chip ch-blue">' + Ue(tk.track || '科类待选') + '</span>' +
      '<span class="muted">校内总分排名：' + (Number(target.totalRank) > 0 ? '<b>' + Ue(target.totalRank) + '</b> 名' : '未填写') + '</span>' +
      '</div>';
    if (!tk.track) {
      h += '<div class="loc-choose"><span>该生物理、历史成绩无法自动判定科类，请先选择：</span>' +
        '<select id="loc-track" class="loc-sel"><option value="">（请选择科类）</option>' +
        '<option value="物理类">物理类</option><option value="历史类">历史类</option></select></div>';
    }
    h += '</div>';

    // 29届因扩招，定位器原始数据本身误差较大，结果仅供参考
    if (grade === '29届') {
      h += '<div class="loc-note">29届扩招，定位器原始数据误差较大，本结果仅供参考，不建议现在给 29届 使用。</div>';
    }

    if (!tk.track) {
      h += '<div class="loc-empty">请先选择科类（物理类 / 历史类），选择后立即按该科类重新定位。</div>';
      return h;
    }

    var loc = L.locate({ grade: grade, school: target.school, track: tk.track, rank: target.totalRank });

    if (loc.reason === 'no-school') {
      var sup = L.supportedSchools(grade);
      h += '<div class="loc-empty">暂无该学校数据，无法查询' +
        '<span class="muted">（阈值表内没有「' + Ue(grade) + ' · ' + Ue(target.school) + ' · ' + Ue(tk.track) + '」这组条件）</span></div>' +
        '<div class="loc-note">当前支持：' + (sup.length ? Ue(sup.join('、')) : '阈值表暂无数据') +
        '（共 ' + sup.length + ' 所；按「学校」字段去掉前后空格后精确匹配，别名、简称不会自动映射）</div>';
      return h;
    }
    if (loc.reason === 'no-rank') {
      h += '<div class="loc-empty">暂无该学生总分排名，无法定位' +
        '<span class="muted">（录入成绩时填写「总分排名」后即可自动定位）</span></div>';
      return h;
    }
    if (!loc.ok) {
      h += '<div class="loc-empty">当前排名暂未达到表内最低档次线' +
        '<span class="muted">（本次排名 ' + Ue(loc.rank) + ' 名，' + Ue(grade) + ' ' + Ue(target.school) +
        ' ' + Ue(tk.track) + ' 的二本B上限为 ' + (L.limit(loc.row && loc.row.tb) || '未划线') + ' 名）</span></div>';
      return h;
    }

    /* ① 当前可报层次 + 大学参考名单（可折叠，名单长也不撑破版面） */
    h += '<div class="loc-box">';
    h += '<div class="loc-row"><div class="loc-k">当前可报考层次</div>' +
      '<div class="loc-v"><span class="loc-tier">' + Ue(loc.tierName) + '</span>' +
      '<span class="muted">（' + Ue(grade) + ' ' + Ue(target.school) + ' ' + Ue(tk.track) +
      '：排名 ≤ ' + loc.limit + ' 名可报该层次' +
      '）</span></div></div>';

    var names = loc.schools;
    h += '<div class="loc-row"><div class="loc-k">大学参考名单</div><div class="loc-v">';
    if (!names.length) {
      h += '<span class="muted">该档次暂无参考名单</span>';
    } else {
      h += '<details class="loc-univ"><summary>展开「' + Ue(loc.tierName) + '」参考院校（' + names.length + ' 所）</summary>' +
        '<div class="loc-list">' + names.map(function (n) {
          return '<span class="chip ch-gray">' + Ue(n) + '</span>';
        }).join('') + '</div></details>';
    }
    h += '</div></div>';

    /* ② 距上一档次的名次差 */
    h += '<div class="loc-row"><div class="loc-k">距下一档次</div><div class="loc-v">' +
      (loc.reachedTop
        ? '<span class="chip ch-green">已达最高档次</span><span class="muted">（' + Ue(loc.tierName) + ' 之上暂无更高档次）</span>'
        : (loc.noUpper
          ? '<span class="chip ch-gray">上方档次未划线</span><span class="muted">（985层次 本届本校未设上限，暂不计算名次差）</span>'
          : '还需再提升 <b class="loc-gap">' + loc.gap + '</b> 名（进入前 ' + loc.nextLimit + ' 名）可上「' +
          Ue(loc.nextName) + '」')) +
      '</div></div>';
    h += '</div>';

    /* 档次阈值一览（便于核对，不占版面） */
    h += '<details class="loc-univ loc-th"><summary>查看该条件的档次阈值（排名上限）</summary>' +
      '<div class="tbl-wrap" style="max-height:none"><table><thead><tr><th>档次</th>' +
      '<th class="num">排名上限</th><th>该生是否达到</th></tr></thead><tbody>';
    for (var i = 0; i < L.TIERS.length; i++) {
      var lim = L.limit(loc.row[L.TIERS[i].field]);
      var hit = (lim > 0 && lim >= loc.rank);
      var isCur = (i === loc.tierIdx);
      h += '<tr' + (isCur ? ' style="background:#fffbea;font-weight:600"' : '') + '><td>' +
        Ue(L.TIERS[i].name) + '</td><td class="num">' + (lim > 0 ? lim : '<span class="muted">未划线</span>') +
        '</td><td>' + (lim <= 0 ? '<span class="muted">—</span>'
          : (hit ? '<span class="chip ch-green">达标</span>' : '<span class="chip ch-gray">差 ' + (loc.rank - lim) + ' 名</span>')) +
        '</td></tr>';
    }
    h += '</tbody></table></div></details>';

    /* ③ 达成下一档次的学习建议 */
    var tips = L.advice(target, classRows, studentRows, loc);
    var goalName = (loc.reachedTop || loc.noUpper) ? loc.tierName : loc.nextName;
    h += '<div class="r-sec" style="padding-left:0">' +
      (loc.reachedTop ? '保持「' : (loc.noUpper ? '稳住「' : '达成「')) + Ue(goalName) +
      '」的后续学习建议</div>' +
      '<div class="summary"><ol class="loc-tips">' + tips.map(function (t) {
        return '<li>' + Ue(t) + '</li>';
      }).join('') + '</ol></div>';

    return h;
  };
})(window.App);

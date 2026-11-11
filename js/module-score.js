/* =========================================================
 * module-score.js —— 模块①：成绩管理
 * 完整复刻原 .xlsm 的 11 项功能：录入窗体 / 实时总分 / Upsert /
 * 自动排序重编号 / 一键清空 / 下拉刷新 / 对比表 / 对比柱状图 /
 * 双轴趋势图 / 中文分析报告 / 班级考试统计
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Score = App.Score, Store = App.Store, K = App.K, Modal = App.Modal, Toast = App.Toast;
  var S = K.SUBJECTS;
  var Ue = U.esc;      // 报告各章节共用的转义函数
  var RANK_MAX = 9999; // 年级人数未知时的排名上限（防止「排名 99999」这类脏数据）

  var state = {
    tab: 'entry',
    q: { school: '', cls: '', name: '', exam: '' },
    trend: 'total',
    master: { school: '', cls: '', exam: '', kw: '', showRank: false },
    statExam: '',
    reportOpen: false,
    /* 年级人数手动覆盖：键 =「学校|届别」，值 = 人数（仅本机本次会话） */
    gradeN: {}
  };

  /* ---------- 小工具 ---------- */
  function opts(list, sel, placeholder) {
    var h = '<option value="">' + U.esc(placeholder || '（全部）') + '</option>';
    for (var i = 0; i < list.length; i++) {
      h += '<option value="' + U.esc(list[i]) + '"' + (list[i] === sel ? ' selected' : '') + '>' + U.esc(list[i]) + '</option>';
    }
    return h;
  }
  function byCond(list, cond) { return Score.filter(list, cond); }
  function allRecords() { return Store.data.records; }

  /* ---------- 编辑权限（账号级：只读/停用/已删除的账号不能改动数据） ---------- */
  function canEdit() {
    if (!App.Sync || !App.Sync.canEdit) return true;      // 未接入云端时不受限
    return App.Sync.canEdit() !== false;
  }
  function editDeniedMsg() {
    var S = App.Sync;
    // 未登录（且云端可用）：任何录入 / 修改 / 删除都不放行
    if (S && S.state && S.state.enabled && !S.state.signedIn) {
      return '请先登录后再进行录入、修改或删除成绩。';
    }
    var st = (S && S.profile() || {}).status;
    if (st === 'deleted') return '账号已被管理员删除，无法修改数据。';
    if (st === 'blocked') return '账号已被管理员停用，无法修改数据。';
    if (st === 'readonly') return '你的账号是「只读」权限，可以查看但不能录入或修改成绩。';
    return '当前账号没有编辑权限。';
  }
  function guardEdit() {
    if (!canEdit()) {
      Toast(editDeniedMsg(), 'warn', 5000);
      return false;
    }
    /* L4 写入校验（唯一出口 App.Perm.assertWrite）：
       T6 起 score 对管理员与教师同等放行，只由账号状态决定 —— readonly / blocked /
       未登录一律拒绝，toast「无操作权限」 */
    if (App.Perm && !App.Perm.assertWrite('score')) return false;
    return true;
  }

  /* ---------- 图标 ---------- */
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M7 20v-5"/>' +
    '<path d="M12 20V8"/><path d="M17 20v-9"/></svg>';

  /* =========================================================
   * 录入窗体
   * ========================================================= */
  function openForm(existing, onDone) {
    if (!guardEdit()) return null;      // 统一鉴权入口：未登录 / 只读 / 停用都不放行
    var body = document.createElement('div');
    var names = Object.keys(Store.data.records.reduce(function (a, r) { a[r.name] = 1; return a; }, {})).sort(U.zh);

    body.innerHTML =
      '<div id="live-hint" class="live-hint">已计入 0 科　·　满分 0　·　及格线 0　·　当前得分率 0%</div>' +
      '<div class="form-grid">' +
      '  <label class="f">学生姓名 *<input name="name" list="nm" autocomplete="off"><datalist id="nm">' +
      names.map(function (n) { return '<option value="' + U.esc(n) + '">'; }).join('') + '</datalist></label>' +
      '  <label class="f">所在学校 *<input name="school" autocomplete="off"></label>' +
      '  <label class="f">班级 *<input name="cls" autocomplete="off"></label>' +
      '  <label class="f">考试名称 *<input name="exam" list="ex" autocomplete="off"><datalist id="ex">' +
      Object.keys(Store.data.records.reduce(function (a, r) { a[r.exam] = 1; return a; }, {})).sort(U.zh)
        .map(function (n) { return '<option value="' + U.esc(n) + '">'; }).join('') + '</datalist></label>' +
      '</div>' +
      '<div class="subj-head"><div>科目</div><div style="text-align:center">成绩</div><div style="text-align:center">单科排名</div></div>' +
      '<div id="subj-rows" style="max-height:290px;overflow:auto">' +
      S.map(function (s, i) {
        return '<div class="subj-grid"><div>' + s + '<span class="muted" style="font-size:11px"> / ' +
          Score.fullOf(i) + '</span></div>' +
          '<input type="number" min="0" max="' + Score.fullOf(i) + '" step="0.5" data-s="' + i +
          '" placeholder="0" title="满分 ' + Score.fullOf(i) + ' 分">' +
          '<input type="number" min="1" step="1" data-r="' + i + '" placeholder="留空"></div>';
      }).join('') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:14px;margin-top:14px;padding-top:12px;border-top:1px solid #eef3f1">' +
      '  <div style="font-size:13px;color:#5b6a77">计入总分</div>' +
      '  <div id="live-total" style="font-size:26px;font-weight:700;color:#c0392b;line-height:1">0</div>' +
      '  <div style="flex:1"></div>' +
      '  <label class="f" style="width:120px">总分排名<input type="number" min="1" step="1" name="totalRank" placeholder="选填"></label>' +
      '</div>' +
      '<div class="muted" style="margin-top:8px">没有成绩的科目请留空或填 0：语数英为必考，选考科目有分即计入，' +
      '超过 3 门时取分数最高的 3 门；未填写的科目不计入分母（不会拉低得分率）。</div>' +
      '<div id="form-err"></div>';

    var totalRankInput = body.querySelector('[name=totalRank]');

    /* 实时计分提示条：随输入变化显示动态满分 / 及格线 / 得分率，并提示选科超 3 门 */
    function readScores() {
      var scratch = { scores: [] };
      body.querySelectorAll('[data-s]').forEach(function (inp, i) {
        scratch.scores[i] = parseFloat(inp.value) || 0;
      });
      return scratch;
    }

    function paintHint(scratch) {
      var box = body.querySelector('#live-hint');
      if (!box) return;
      var f = Score.fields(scratch);
      var t = Score.total(scratch);
      var rate = f.full > 0 ? Math.round(t / f.full * 1000) / 10 : 0;
      var html = '已计入 <b>' + f.all.length + '</b> 科　·　满分 <b>' + f.full + '</b>　·　及格线 <b>' + f.pass +
        '</b>　·　当前得分率 <b>' + rate + '%</b>';
      if (f.overflow) {
        html += '<span class="live-warn">已选 ' + f.electivePool.length + ' 门选科，将按最高 ' +
          K.ELECTIVE_MAX + ' 门计入（' + f.dropped.join('、') + ' 暂不计入）</span>';
      }
      if (f.missingCore.length) {
        html += '<span class="live-warn">必考科目未录：' + f.missingCore.join('、') + '（不计入分母）</span>';
      }
      /* 单科超满分：不静默截断总分，但明确提示（得分率按 100% 计） */
      var over = [];
      f.all.forEach(function (i2) {
        var v = Number(scratch.scores[i2]) || 0;
        var cap = Score.fullOf(i2);
        if (v > cap) over.push(S[i2] + ' ' + U.f1(v) + '/' + cap);
      });
      if (over.length) {
        html += '<span class="live-warn">超出满分：' + over.join('、') +
          '（该科得分率按 100% 计，请核对分数）</span>';
      }
      box.innerHTML = html;
    }

    function liveTotal() {
      var scratch = readScores();
      /* 与保存口径一致：只累加「已计入」科目（语数英 + 最高 3 门选科） */
      body.querySelector('#live-total').textContent = U.f1(Score.total(scratch));
      paintHint(scratch);
    }
    body.addEventListener('input', function (e) {
      if (e.target.hasAttribute('data-s')) liveTotal();
    });

    if (existing) {
      body.querySelector('[name=name]').value = existing.name;
      body.querySelector('[name=school]').value = existing.school;
      body.querySelector('[name=cls]').value = existing.cls;
      body.querySelector('[name=exam]').value = existing.exam;
      body.querySelectorAll('[data-s]').forEach(function (inp, i) {
        inp.value = existing.scores[i] ? existing.scores[i] : '';
      });
      body.querySelectorAll('[data-r]').forEach(function (inp, i) {
        inp.value = existing.ranks[i] ? existing.ranks[i] : '';
      });
      if (existing.totalRank) totalRankInput.value = existing.totalRank;
      liveTotal();
    }

    /* 提交逻辑：返回 true 表示成功 */
    function submit() {
      var get = function (n) { return String(body.querySelector('[name=' + n + ']').value || '').trim(); };
      var err = body.querySelector('#form-err');
      err.innerHTML = '';
      function fail(msg, focusSel) {
        err.innerHTML = '<div class="err">' + U.esc(msg) + '</div>';
        var t = focusSel && body.querySelector(focusSel);
        if (t) t.focus();
        return false;
      }

      var rec = Score.newRecord();
      rec.name = get('name'); rec.school = get('school');
      rec.cls = get('cls'); rec.exam = get('exam');

      if (!rec.name) return fail('姓名不能为空！', '[name=name]');
      if (!rec.school) return fail('学校不能为空！', '[name=school]');
      if (!rec.cls) return fail('班级不能为空！', '[name=cls]');
      if (!rec.exam) return fail('考试名称不能为空！', '[name=exam]');

      var ok = true;
      var clamped = [];                        // 保存前截断的记录：只提示一次，不入库

      /* 排名上限：年级人数已知就用它（名次不可能超过年级人数），
         未知时退回合理上限 RANK_MAX，避免「排名 99999」这类脏数据。 */
      function rankCap() {
        var grade = Score.gradeOf(rec.cls);
        var key = String(rec.school || '').trim() + '|' + grade;
        var manual = Number(state.gradeN[key]) || 0;
        return manual > 0 ? manual : RANK_MAX;
      }

      body.querySelectorAll('[data-s]').forEach(function (inp, i) {
        var v = String(inp.value).trim();
        if (v === '') { rec.scores[i] = 0; return; }
        if (!isFinite(Number(v))) { fail(S[i] + '成绩必须为数字！', '[data-s="' + i + '"]'); ok = false; return; }
        var num = Number(v);
        if (num < 0) { fail(S[i] + '成绩不能为负数！', '[data-s="' + i + '"]'); ok = false; return; }
        var cap = Score.fullOf(i);
        if (num > cap) {                       // 超出单科满分：按满分截断，输入框同步回写
          num = cap;
          inp.value = String(cap);
          clamped.push(S[i] + '最高 ' + cap + ' 分，已按 ' + cap + ' 计');
        }
        rec.scores[i] = num;
      });
      if (!ok) return false;

      var rCap = rankCap();                    // 排名上限：年级人数已知则用它，未知按合理上限
      body.querySelectorAll('[data-r]').forEach(function (inp, i) {
        var v = String(inp.value).trim();
        if (v === '') { rec.ranks[i] = 0; return; }
        if (!isFinite(Number(v))) { fail(S[i] + '排名必须为数字！', '[data-r="' + i + '"]'); ok = false; return; }
        var num = Math.floor(Number(v));
        if (num < 1) { fail(S[i] + '排名必须为大于 0 的整数！', '[data-r="' + i + '"]'); ok = false; return; }
        if (rCap > 0 && num > rCap) {
          num = rCap;
          inp.value = String(rCap);
          clamped.push(S[i] + '排名上限 ' + rCap + ' 名，已按 ' + rCap + ' 名计');
        }
        rec.ranks[i] = num;
      });
      if (!ok) return false;

      var tr = String(totalRankInput.value).trim();
      if (tr !== '') {
        if (!isFinite(Number(tr))) return fail('总分排名必须为数字！', '[name=totalRank]');
        var tn = Math.floor(Number(tr));
        if (tn < 1) return fail('总分排名必须为大于 0 的整数！', '[name=totalRank]');
        if (rCap > 0 && tn > rCap) {
          tn = rCap;
          totalRankInput.value = String(rCap);
          clamped.push('总分排名上限 ' + rCap + ' 名，已按 ' + rCap + ' 名计');
        }
        rec.totalRank = tn;
      }
      if (existing) rec.id = existing.id;

      var res = Score.upsert(rec);
      /* 兜底：即便上面的表单校验被绕过（如二次封装调用），Store 也会再截一遍；
         这里把兜底命中项一并告知用户，避免「填 110 存成 100」被当成 bug。 */
      if (res.clamped && res.clamped.length) {
        res.clamped.forEach(function (name) {
          var cap2 = Score.fullOf(S.indexOf(name));
          var line = name + '最高 ' + cap2 + ' 分，已按 ' + cap2 + ' 计';
          if (clamped.indexOf(line) < 0) clamped.push(line);
        });
      }
      if (clamped.length) Toast(clamped.join('；'), 'warn', 5200);

      Toast(res.mode === 'update'
        ? '已更新 ' + rec.name + ' 在「' + rec.exam + '」的成绩记录'
        : '录入成功！' + rec.name + ' 「' + rec.exam + '」总分 ' + Score.total(rec) + ' 分，已自动写入总表',
        res.mode === 'update' ? 'warn' : 'ok');
      App.render();
      return true;
    }

    var mask = Modal.open({
      title: existing ? '修改成绩记录' : '成绩录入',
      body: body, okText: existing ? '保存修改' : '提交录入', cancelText: '取消',
      onOk: submit
    });

    /* 连续录入：保留学校/班级/考试，只清空姓名与各科成绩 */
    if (!existing) {
      var cont = document.createElement('button');
      cont.textContent = '提交并继续录入下一位';
      cont.className = 'primary';
      cont.style.marginRight = 'auto';
      cont.addEventListener('click', function () {
        var keep = {
          school: body.querySelector('[name=school]').value,
          cls: body.querySelector('[name=cls]').value,
          exam: body.querySelector('[name=exam]').value
        };
        if (!submit()) return;
        body.querySelector('[name=name]').value = '';
        body.querySelector('[name=totalRank]').value = '';
        body.querySelectorAll('[data-s]').forEach(function (i) { i.value = ''; });
        body.querySelectorAll('[data-r]').forEach(function (i) { i.value = ''; });
        body.querySelector('#form-err').innerHTML = '';
        liveTotal();
        body.querySelector('[name=name]').focus();
      });
      mask.querySelector('footer').insertBefore(cont, mask.querySelector('footer').firstChild);
    }
    setTimeout(function () { body.querySelector('[name=name]').focus(); }, 60);
    return mask;
  }

  /* =========================================================
   * Tab 1：录入
   * ========================================================= */
  function renderEntry() {
    var recent = allRecords().slice().sort(function (a, b) {
      return new Date(b.ts) - new Date(a.ts);
    }).slice(0, 8);

    var h = '<div class="grid g2">';
    h += '<div class="card"><h3>快捷录入<span class="h-note">与原 Excel「快捷录入成绩」按钮一致</span></h3>' +
      '<button class="primary btn-lg" id="open-form" style="width:100%;padding:14px">打开成绩录入窗体</button>' +
      '<div class="muted" style="margin-top:10px">支持<b>连续录入</b>：提交后自动保留学校/班级/考试名称，' +
      '只需换姓名即可录下一位同学。</div></div>';
    h += '<div class="card"><h3>使用说明</h3><ol class="muted" style="font-size:12.5px;line-height:1.9;padding-left:18px">' +
      '<li>在窗体中输入姓名、学校、班级、考试名称及各科成绩和排名</li>' +
      '<li>选科由成绩自动识别：语数英必考，选考科目有分即计入，超过 3 门取最高 3 门</li>' +
      '<li>满分与及格线随选科门数动态变化（满配 6 科 750 分 / 及格 450 分）</li>' +
      '<li>姓名、学校、班级、考试名称为必填项</li>' +
      '<li>没有成绩的科目留空或填 0，未填科目不计入分母，不会拉低得分率</li>' +
      '<li>录入后自动写入成绩总表并按「学校 → 班级 → 考试先后 → 得分率」排序</li>' +
      '<li>同一名学生在同一考试重复录入将<b>自动覆盖更新</b>（保留原始录入时间）</li>' +
      '</ol></div></div>';

    h += '<div class="card"><h3>最近录入<span class="h-note">最近 8 条</span></h3>';
    if (!recent.length) {
      h += '<div class="empty">还没有任何成绩记录，点击上方按钮开始录入。</div>';
    } else {
      h += '<div class="tbl-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>学校</th><th>班级</th>' +
        '<th>考试</th><th class="num">总分</th><th class="num">总分排名</th></tr></thead><tbody>';
      recent.forEach(function (r) {
        h += '<tr><td class="muted">' + U.esc(U.hms(r.ts)) + '</td><td>' + U.esc(r.name) + '</td>' +
          '<td>' + U.esc(r.school) + '</td><td>' + U.esc(r.cls) + '</td><td>' + U.esc(r.exam) + '</td>' +
          '<td class="num"><b>' + Score.total(r) + '</b></td>' +
          '<td class="num">' + (r.totalRank ? r.totalRank : '-') + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '</div>';
    return h;
  }
  function bindEntry(host) {
    var b = host.querySelector('#open-form');
    if (b) b.addEventListener('click', function () { if (guardEdit()) openForm(null, null); });
  }

  /* =========================================================
   * Tab 2：成绩总表
   * ========================================================= */
  function masterRowsData() {
    var list = allRecords();
    var f = state.master;
    var rows = list.filter(function (r) {
      if (f.school && r.school !== f.school) return false;
      if (f.cls && r.cls !== f.cls) return false;
      if (f.exam && r.exam !== f.exam) return false;
      if (f.kw && (r.name || '').indexOf(f.kw) < 0) return false;
      return true;
    });
    return Score.sort(rows);
  }

  function renderMaster() {
    var all = allRecords();
    var oAll = Score.options(all);
    var f = state.master;
    var edit = canEdit();
    var clsList = f.school ? oAll.classes.filter(function (c) {
      return all.some(function (r) { return r.school === f.school && r.cls === c; });
    }) : oAll.classes;
    var rows = masterRowsData();

    var h = '<div class="card"><h3>成绩总表<span class="h-note">共 ' + rows.length + ' 条 / 全部 ' + all.length + ' 条</span></h3>';
    h += '<div class="toolbar">' +
      '<label class="f">学校<select id="f-school">' + opts(oAll.schools, f.school) + '</select></label>' +
      '<label class="f">班级<select id="f-cls">' + opts(clsList, f.cls) + '</select></label>' +
      '<label class="f">考试<select id="f-exam">' + opts(oAll.exams, f.exam) + '</select></label>' +
      '<label class="f">姓名搜索<input id="f-kw" value="' + U.esc(f.kw) + '" placeholder="输入姓名关键字"></label>' +
      '<label class="f" style="flex-direction:row;align-items:center;gap:6px;font-size:12.5px">' +
      '<input type="checkbox" id="f-rank"' + (f.showRank ? ' checked' : '') + ' style="width:auto">显示单科排名</label>' +
      '<button id="reset-filter" class="ghost">重置筛选</button>' +
      '<div style="flex:1"></div>' +
      '<button id="exp-csv">导出 CSV</button>' +
      '<button id="exp-xlsx">导出 Excel</button>' +
      '</div>';

    if (!rows.length) {
      h += '<div class="empty">没有符合条件的记录。</div></div>';
      return h;
    }

    h += '<div class="tbl-wrap"><table><thead><tr><th class="c">序号</th><th>姓名</th><th>学校</th><th>班级</th><th>考试</th>';
    S.forEach(function (s) { h += '<th class="num">' + s + '</th>'; });
    if (f.showRank) S.forEach(function (s) { h += '<th class="num">' + s + '<br>排名</th>'; });
    h += '<th class="num">总分</th><th class="num">总排名</th><th>录入时间</th><th class="c">操作</th></tr></thead><tbody>';

    rows.forEach(function (r, i) {
      h += '<tr><td class="c muted">' + (i + 1) + '</td><td><b>' + U.esc(r.name) + '</b></td>' +
        '<td>' + U.esc(r.school) + '</td><td>' + U.esc(r.cls) + '</td><td>' + U.esc(r.exam) + '</td>';
      S.forEach(function (s, j) {
        var v = Number(r.scores[j]) || 0;
        var cap = Score.fullOf(j);
        var bad = v > 0 && v < Score.passOf(j);      // 单科及格线：语数英 90，其余 60
        var over = v > cap;                          // 超过满分：脏数据，标橙提示
        var style = over ? ' style="color:#c8892e;font-weight:600"'
          : (bad ? ' style="color:#c0392b;font-weight:600"' : '');
        h += '<td class="num"' + style + (over ? ' title="超过满分 ' + cap + ' 分，得分率按 100% 计"' : '') + '>' +
          (v || '-') + '</td>';
      });
      if (f.showRank) S.forEach(function (s, j) {
        h += '<td class="num muted">' + (Number(r.ranks[j]) || '-') + '</td>';
      });
      h += '<td class="num"><b>' + Score.total(r) + '</b></td>' +
        '<td class="num">' + (r.totalRank || '-') + '</td>' +
        '<td class="muted">' + U.esc(U.hms(r.ts)) + '</td>' +
        '<td class="c">' + (edit
        ? '<button class="ghost" data-edit="' + r.id + '" style="padding:2px 8px">修改</button> ' +
          '<button class="ghost" data-del="' + r.id + '" style="padding:2px 8px;color:#c0392b">删除</button>'
        : '<span class="chip ch-gray" title="' + U.esc(editDeniedMsg()) + '">只读</span>') +
        '</td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="muted" style="margin-top:8px;font-size:11.5px">' +
      '总分 = 已计入科目之和（语数英 + 最高 3 门选科），满分随选科门数动态变化（满配 6 科 750 分，仅语数英 450 分）；' +
      '单科分数标红表示低于及格线（语数英 90 / 选科 60）。</div></div>';
    return h;
  }

  function bindMaster(host) {
    var f = state.master;
    function set(k, el) { return function () { f[k] = el.value; App.render(); }; }
    var fs = host.querySelector('#f-school'), fc = host.querySelector('#f-cls'),
      fe = host.querySelector('#f-exam'), fk = host.querySelector('#f-kw'), fr = host.querySelector('#f-rank');
    if (fs) fs.addEventListener('change', set('school', fs));
    if (fc) fc.addEventListener('change', set('cls', fc));
    if (fe) fe.addEventListener('change', set('exam', fe));
    if (fr) fr.addEventListener('change', function () { f.showRank = fr.checked; App.render(); });
    // 姓名搜索：输入法组字期间（拼音未上屏）不发起查询，
    // 仅在汉字确认上屏（compositionend）或用户直接输入/回车后，按已提交的姓名内容匹配
    if (fk) U.onCommitted(fk, function (v) {
      var kw = String(v || '').trim();
      if (kw === f.kw) return;
      f.kw = kw;
      App.render();
      var again = document.getElementById('f-kw');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 220);
    var rs = host.querySelector('#reset-filter');
    if (rs) rs.addEventListener('click', function () {
      state.master = { school: '', cls: '', exam: '', kw: '', showRank: f.showRank }; App.render();
    });

    var ec = host.querySelector('#exp-csv'), ex = host.querySelector('#exp-xlsx');
    if (ec) ec.addEventListener('click', function () {
      App.X.downloadCSV('成绩总表_' + U.nowStr().replace(/[-: ]/g, '') + '.csv', masterExportRows());
      Toast('已导出 CSV', 'ok');
    });
    if (ex) ex.addEventListener('click', function () {
      App.X.downloadXLSX('成绩总表_' + U.nowStr().replace(/[-: ]/g, '') + '.xlsx',
        [{ name: '成绩总表', rows: masterExportRows() }]);
      Toast('已导出 Excel（列结构与原 .xlsm 完全一致）', 'ok');
    });

    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!guardEdit()) return;
        var id = b.getAttribute('data-edit');
        var rec = allRecords().filter(function (r) { return r.id === id; })[0];
        if (rec) openForm(JSON.parse(JSON.stringify(rec)), null);
      });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!guardEdit()) return;
        var id = b.getAttribute('data-del');
        var rec = allRecords().filter(function (r) { return r.id === id; })[0];
        Modal.confirm('确定删除 <b>' + U.esc(rec.name) + '</b> 在「' + U.esc(rec.exam) + '」的成绩记录吗？<br>此操作不可撤销。',
          function () { Score.remove(id); Toast('已删除该条记录', 'ok'); App.render(); }, true);
      });
    });
  }

  /** 导出用：与原 Excel 27 列结构完全一致 */
  function masterExportRows() {
    var head = ['序号', '姓名', '学校', '班级', '考试名称'];
    S.forEach(function (s) { head.push(s, s + '排名'); });
    head.push('总分', '总分排名', '录入时间');
    var rows = [head];
    Score.sort(masterRowsData()).forEach(function (r, i) {
      var row = [i + 1, r.name, r.school, r.cls, r.exam];
      for (var j = 0; j < K.NUM_SUBJECTS; j++) {
        row.push(Number(r.scores[j]) || 0);
        row.push(Number(r.ranks[j]) || 0);
      }
      row.push(Score.total(r), r.totalRank || 0, U.hms(r.ts));
      rows.push(row);
    });
    return rows;
  }

  /* =========================================================
   * Tab 3：查询分析（对比表 + 柱状图 + 趋势图 + 分析报告）
   * ========================================================= */
  function renderQuery() {
    var all = allRecords(), oAll = Score.options(all), q = state.q;
    if (!all.length) return '<div class="card"><div class="empty">成绩总表暂无数据，请先在「录入」页录入成绩。</div></div>';

    var clsList = q.school ? oAll.classes.filter(function (c) {
      return all.some(function (r) { return r.school === q.school && r.cls === c; });
    }) : oAll.classes;
    var pool = all.filter(function (r) {
      return (!q.school || r.school === q.school) && (!q.cls || r.cls === q.cls);
    });
    var nameList = Object.keys(pool.reduce(function (a, r) { a[r.name] = 1; return a; }, {})).sort(U.zh);
    var examList = Object.keys(pool.reduce(function (a, r) { a[r.exam] = 1; return a; }, {})).sort(U.zh);

    var h = '<div class="card"><h3>查询条件<span class="h-note">四级联动，对应原「刷新选项」按钮（本版本自动实时刷新）</span></h3>' +
      '<div class="toolbar">' +
      '<label class="f">学校<select id="q-school">' + opts(oAll.schools, q.school, '请选择') + '</select></label>' +
      '<label class="f">班级<select id="q-cls">' + opts(clsList, q.cls, '请选择') + '</select></label>' +
      '<label class="f">姓名<select id="q-name">' + opts(nameList, q.name, '请选择') + '</select></label>' +
      '<label class="f">考试<select id="q-exam">' + opts(examList, q.exam, '请选择') + '</select></label>' +
      '<button id="q-run" class="primary">生成成绩分析报告</button>' +
      '</div></div>';

    if (!q.school || !q.cls || !q.name || !q.exam) {
      return h + '<div class="card"><div class="empty">请选择学校、班级、姓名和考试名称。</div></div>';
    }

    var target = byCond(all, { school: q.school, cls: q.cls, name: q.name, exam: q.exam })[0];
    if (!target) {
      return h + '<div class="card"><div class="empty">未找到 ' + U.esc(q.name) + ' 在「' + U.esc(q.exam) + '」中的成绩记录。</div></div>';
    }
    var classRows = byCond(all, { school: q.school, cls: q.cls, exam: q.exam });
    // 历史记录：按总表规范顺序（考试先后）
    var studentRows = Score.sort(byCond(all, { school: q.school, cls: q.cls, name: q.name }));

    /* 对比表 */
    h += '<div class="card"><h3>① 成绩对比班级均分<span class="h-note">' + classRows.length + ' 名同学参与本次统计</span></h3>';
    h += '<div class="tbl-wrap" style="max-height:none"><table><thead><tr><th>科目</th><th class="num">学生成绩</th>' +
      '<th class="num">单科排名</th><th class="num">班级均分</th><th class="num">差异</th>' +
      '<th class="num">班级最高</th><th class="num">班级最低</th><th class="num">有效人数</th></tr></thead><tbody>';
    var countedIdx = Score.fields(target).all;
    S.forEach(function (s, i) {
      var sc = Number(target.scores[i]) || 0;
      var st = Score.stat(classRows, i);
      var used = countedIdx.indexOf(i) >= 0;
      h += '<tr' + (used ? '' : ' class="muted"') + '><td>' + s + (used ? '' : ' <span class="chip ch-gray">未计入</span>') + '</td>' +
        '<td class="num"' + (used && sc < Score.passOf(i) ? ' style="color:#c0392b;font-weight:600"' : '') + '>' + (sc || '-') + '</td>' +
        '<td class="num">' + (Number(target.ranks[i]) || '-') + '</td>' +
        '<td class="num">' + (st.count ? U.f1(st.avg) : '-') + '</td>' +
        '<td class="num">' + (used && st.count ? diffCell(sc - st.avg) : '<span class="muted">-</span>') + '</td>' +
        '<td class="num">' + (st.max === null ? '-' : U.f1(st.max)) + '</td>' +
        '<td class="num">' + (st.min === null ? '-' : U.f1(st.min)) + '</td>' +
        '<td class="num">' + st.count + '</td></tr>';
    });
    var tSt = Score.stat(classRows, 'total');
    /* 总分：不同学生选科门数不同，满分可能不同 → 差异按「得分率」对比 */
    var myRate = Score.totalRate(target);
    var tRateDiffPp = tSt.count ? Math.round((myRate - tSt.avgRate) * 1000) / 10 : 0;
    var tFull = Score.fullTotal(target);
    h += '<tr style="background:#fffbea;font-weight:600"><td>总分</td>' +
      '<td class="num">' + U.f1(Math.min(Score.total(target), tFull)) + ' <span class="muted">/ ' + U.f1(tFull) + '</span></td>' +
      '<td class="num">' + (target.totalRank || '-') + '</td>' +
      '<td class="num">' + (tSt.count ? U.f1(tSt.avg) + ' <span class="muted">· ' + rateText(tSt.avgRate) + '</span>' : '-') + '</td>' +
      '<td class="num">' + (tSt.count ? diffCell(tRateDiffPp) : '-') + '</td>' +
      '<td class="num">' + (tSt.max === null ? '-' : U.f1(tSt.max)) + '</td>' +
      '<td class="num">' + (tSt.min === null ? '-' : U.f1(tSt.min)) + '</td>' +
      '<td class="num">' + tSt.count + '</td></tr>';
    h += '</tbody></table></div>';
    h += '<div class="muted" style="margin-top:6px;font-size:11.5px">' +
      '总分口径：语数英 + 最高 3 门选科，满分随选科门数动态变化，因此总分行的差异以<b>得分率差（百分点）</b>表示；' +
      '未填写的科目不计入分母。单元格红色表示该科低于及格线。</div>';
    h += '<div id="chart-bar" style="margin-top:14px"></div></div>';

    /* 趋势图 */
    h += '<div class="card"><h3>② 历史趋势<span class="h-note">共 ' + studentRows.length + ' 次考试记录</span></h3>' +
      '<div class="toolbar"><label class="f" style="min-width:150px">查看科目' +
      '<select id="trend-sel"><option value="total"' + (state.trend === 'total' ? ' selected' : '') + '>总分</option>' +
      S.map(function (s, i) {
        return '<option value="' + i + '"' + (String(state.trend) === String(i) ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select></label></div>' +
      '<div id="chart-trend"></div></div>';

    /* 报告 */
    h += '<div class="no-print" style="margin-bottom:14px">' +
      '<button id="btn-report" class="primary">生成 / 刷新分析报告</button> ' +
      '<button id="btn-print">打印 / 导出 PDF</button></div>' +
      '<div id="report-area">' + (state.reportOpen ? reportHTML(target, classRows, studentRows) : '') + '</div>';

    function diffCell(d) {
      var cls = d > 0 ? 'ch-green' : (d < 0 ? 'ch-red' : 'ch-gray');
      return '<span class="chip ' + cls + '">' + (d > 0 ? '+' : '') + U.f1(d) + '</span>';
    }
    return h;
  }

  function bindQuery(host) {
    var q = state.q;
    function onChange(sel, key) {
      sel.addEventListener('change', function () {
        q[key] = sel.value;
        if (key === 'school') q.cls = '';
        App.render();
      });
    }
    ['school', 'cls', 'name', 'exam'].forEach(function (k) {
      var el = host.querySelector('#q-' + k);
      if (el) onChange(el, k);
    });
    var ts = host.querySelector('#trend-sel');
    if (ts) ts.addEventListener('change', function () { state.trend = ts.value; App.render(); });

    var all = allRecords();
    if (!q.school || !q.cls || !q.name || !q.exam) return;
    var target = byCond(all, { school: q.school, cls: q.cls, name: q.name, exam: q.exam })[0];
    if (!target) return;
    var classRows = byCond(all, { school: q.school, cls: q.cls, exam: q.exam });
    var studentRows = Score.sort(byCond(all, { school: q.school, cls: q.cls, name: q.name }));

    var cb = host.querySelector('#chart-bar');
    if (cb) {
      /* 只画「计入科目」的绝对分对比（同科同满分才可比）；
       * 总分因选科门数不同满分不同，跨组合只看得分率，见报告「一、成绩总览」 */
      var cats = [], mine = [], avg = [];
      Score.fields(target).all.forEach(function (i) {
        var sc = Number(target.scores[i]) || 0;
        var st = Score.stat(classRows, i);
        cats.push(S[i]); mine.push(sc); avg.push(Math.round(st.avg * 10) / 10);
      });
      cb.appendChild(App.Chart.bar({
        title: target.name + ' — 「' + target.exam + '」各科成绩对比班级均分（总分请见报告得分率）',
        categories: cats,
        series: [{ name: '学生成绩', color: '#c0392b', data: mine }, { name: '班级均分', color: '#4472c4', data: avg }]
      }));
    }

    var ct = host.querySelector('#chart-trend');
    if (ct) {
      if (studentRows.length < 2) {
        ct.innerHTML = '<div class="empty">该学生只有一次考试成绩，无法生成趋势图。</div>';
      } else {
        var idx = state.trend, isTotal = idx === 'total';
        var label = isTotal ? '总分得分率' : S[Number(idx)];
        var labels = [], sc = [], rk = [];
        studentRows.forEach(function (r) {
          labels.push(r.exam);
          /* 总分口径用得分率（不同考试选科门数可能不同，绝对分不可直接比） */
          sc.push(isTotal
            ? Math.round(Score.totalRate(r) * 1000) / 10
            : (Number(r.scores[Number(idx)]) || 0));
          rk.push(isTotal ? (r.totalRank || 0) : (Number(r.ranks[Number(idx)]) || 0));
        });
        ct.appendChild(App.Chart.dualLine({
          title: target.name + ' — ' + label + '历史趋势',
          labels: labels, score: sc, rank: rk,
          scoreLabel: isTotal ? '得分率(%)' : label + '成绩', rankLabel: label + '排名'
        }));
      }
    }

    var br = host.querySelector('#btn-report');
    if (br) br.addEventListener('click', function () {
      state.reportOpen = true; App.render();
      setTimeout(function () {
        var ra = document.getElementById('report-area');
        if (ra) ra.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    });
    /* 科类手动切换：物理/历史都缺考或都有分时，选完立即重算并保持报告展开 */
    var lts = host.querySelector('#loc-track');
    if (lts && App.Locator && App.Locator.chooseTrack) {
      lts.addEventListener('change', function () {
        App.Locator.chooseTrack(target, lts.value);
        state.reportOpen = true;
        App.render();
        setTimeout(function () {
          var el = document.getElementById('report-area');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
      });
    }
    /* ---------- 报告内趋势图（得分率单折线）与年级人数覆盖 ---------- */
    var trendBox = host.querySelector('#an-chart-trend');
    if (trendBox) {
      var grade = Score.gradeOf(target.cls);
      var gKey2 = String(target.school || '').trim() + '|' + grade;
      var tk2 = (App.Locator && App.Locator.trackOf) ? App.Locator.trackOf(target) : { track: '' };
      var est2 = (App.GradeSize && App.GradeSize.estimate)
        ? App.GradeSize.estimate({ school: target.school, grade: grade, track: tk2.track || '' })
        : { n: null, source: null, note: '年级人数未知' };
      var manual2 = Number(state.gradeN[gKey2]) || 0;
      var gs2 = manual2 > 0 ? { n: manual2, source: 'manual', note: '手动填写' } : est2;
      var gradeRows2 = Score.gradePool(Store.data.records, target);
      var an2 = null;
      try {
        an2 = App.Analysis.build({
          target: target, classRows: classRows, gradeRows: gradeRows2,
          studentRows: studentRows, gradeSize: gs2, track: tk2.track || ''
        });
      } catch (e) {
        if (console && console.error) console.error('报告图表数据计算失败', e);
      }

      if (an2) {
        var exs = an2.trend.exams || [];
        if (exs.length < 2) {
          trendBox.innerHTML = '<div class="empty">只有一次考试记录，暂不生成趋势图。</div>';
        } else {
          trendBox.appendChild(App.Chart.dualLine({
            title: target.name + ' — 总分得分率趋势',
            labels: exs.map(function (e) { return e.exam; }),
            score: exs.map(function (e) { return Math.round((e.rate || 0) * 1000) / 10; }),
            rank: exs.map(function () { return 0; }),
            scoreLabel: '得分率(%)', rankLabel: '总分排名'
          }));
        }
      }
    }

    var gnInput = host.querySelector('#an-graden');
    var gnBtn = host.querySelector('#an-graden-apply');
    if (gnBtn) {
      gnBtn.addEventListener('click', function () {
        var v = Math.floor(Number(gnInput && gnInput.value));
        if (!(v > 0)) { Toast('请输入大于 0 的整数年级人数', 'warn'); return; }
        var key = String(target.school || '').trim() + '|' + Score.gradeOf(target.cls);
        state.gradeN[key] = v;
        state.reportOpen = true;                 // 重渲染后保持报告展开
        var content = document.getElementById('content');
        var top = content ? content.scrollTop : 0;
        App.render();
        setTimeout(function () {
          var c = document.getElementById('content');
          if (c) c.scrollTop = top;              // 保住滚动位置
        }, 0);
        Toast('年级人数已按 ' + v + ' 人重新计算百分位', 'ok');
      });
    }

    var bp = host.querySelector('#btn-print');
    if (bp) bp.addEventListener('click', function () { window.print(); });
  }

  /* ---------- 院校定位区块（数据/算法都在 locator.js，这里只负责拼接与容错） ---------- */
  function locatorSection(target, classRows, studentRows) {
    if (!App.Locator) return '';
    var fn = App.Locator.bodyHTML || App.Locator.sectionHTML;
    if (!fn) return '';
    try {
      return fn(target, classRows, studentRows);
    } catch (e) {
      if (console && console.error) console.error('院校定位渲染失败', e);
      return '<div class="loc-empty">院校定位渲染失败，请刷新后重试。</div>';
    }
  }

  /* =========================================================
   * 中文分析报告（高考 6 科 750 分制 · 动态选科口径 · 六节）
   * 章节：一 成绩总览 / 二 各科表现 / 三 位次 / 四 趋势 /
   *      五 优势与短板 / 六 阶段规划（含院校定位结论）
   * 每个章节独立 try/catch：任一模块异常只影响该章节，不整页崩。
   * ========================================================= */
  var SOURCE_TEXT = {
    teacher: '教师录入', system: '系统内计算', manual: '手动填写', none: '—',
    locator: '定位表', web: '联网查询'
  };

  /** 章节外壳 + 容错：fn 抛错时只降级该章节 */
  function secWrap(title, label, fn) {
    var body;
    try {
      body = fn();
    } catch (e) {
      if (console && console.error) console.error(label + '渲染失败', e);
      body = '<div class="an-note">' + U.esc(label) + '渲染失败，请刷新后重试</div>';
    }
    return '<div class="r-sec">' + title + '</div><div class="r-body">' + body + '</div>';
  }

  function rateText(r) { return (Math.round((Number(r) || 0) * 1000) / 10) + '%'; }

  /** 得分率 → 数值百分比（保留 1 位，用于条形宽度与数字展示） */
  function ratePct(r) { return Math.round((Number(r) || 0) * 1000) / 10; }

  /**
   * 展示口径的总分：超满分时按动态满分截断，保证「总分 / 满分」不出现 780/750。
   * 入口已截断，这里只兜底历史脏数据。
   */
  function shownTotal(ov) {
    var t = Number(ov && ov.total) || 0;
    var f = Number(ov && ov.full) || 0;
    return (f > 0 && t > f) ? f : t;
  }

  /** 条形颜色语义：达标绿（≥60%）/ 临界琥珀（55%~60%）/ 薄弱红（<55%） */
  function toneOf(rate) {
    var r = Number(rate) || 0;
    if (r >= 0.60) return 'good';
    if (r >= 0.55) return 'amber';
    return 'weak';
  }

  /** 报告内 KPI 小卡 */
  function anKpi(k, v, d) {
    return '<div class="an-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
      (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  }

  /** 得分率条形：填充 + 60% 及格基准虚线 + 班均竖标 */
  function rateBar(rate, avgRate, label) {
    var w = Math.max(0, Math.min(100, ratePct(rate)));
    var a = avgRate === null || avgRate === undefined ? null : Math.max(0, Math.min(100, ratePct(avgRate)));
    var h = '<div class="rate-bar">' +
      '<div class="rate-fill ' + toneOf(rate) + '" style="width:' + w + '%"></div>' +
      '<div class="rate-base" style="left:60%" title="及格基准 60%"></div>';
    if (a !== null) {
      h += '<div class="rate-avg" style="left:' + a + '%" title="' + Ue(label || '班均') + '得分率 ' + a + '%"></div>';
    }
    return h + '</div>';
  }

  /* 百分位展示：0.0% 是合法值（极靠前的名次），显示为「<0.1%」而非「0%」。
   * 直接内联而不抽公共函数：tools/smoke-analysis.js 会按函数切片单独求值渲染函数，
   * 增加外部依赖会让切片式测试取不到符号。 */

  function reportHTML(target, classRows, studentRows) {
    var grade = Score.gradeOf(target.cls);
    var gradeRows = Score.gradePool(Store.data.records, target);
    var tk = (App.Locator && App.Locator.trackOf) ? App.Locator.trackOf(target) : { track: '' };
    var track = tk.track || '';

    /* 年级人数：手动覆盖 > 定位表 > 联网数据 > 未知 */
    var gKey = String(target.school || '').trim() + '|' + grade;
    var est = (App.GradeSize && App.GradeSize.estimate)
      ? App.GradeSize.estimate({ school: target.school, grade: grade, track: track })
      : { n: null, source: null, note: '年级人数未知' };
    var manualN = Number(state.gradeN[gKey]) || 0;
    var gradeSize = manualN > 0
      ? { n: manualN, source: 'manual', note: '手动填写（在「三、位次」可随时修改）' }
      : est;

    var an = null, anErr = null;
    try {
      an = App.Analysis.build({
        target: target, classRows: classRows, gradeRows: gradeRows,
        studentRows: studentRows, gradeSize: gradeSize, track: track
      });
    } catch (e) {
      anErr = e;
      if (console && console.error) console.error('成绩分析引擎失败', e);
    }

    var loc = null;
    if (App.Locator && App.Locator.locate) {
      try {
        loc = App.Locator.locate({ grade: grade, school: target.school, track: track, rank: target.totalRank });
      } catch (e2) { loc = null; }
    }

    var h = '<div class="report"><div class="r-title">成绩分析报告</div>';

    /* ---------- 基本信息 ---------- */
    h += '<div class="r-body" style="padding-top:14px"><table style="width:auto"><tr>' +
      '<td class="muted" style="width:80px">学生：</td><td><b>' + Ue(target.name) + '</b></td>' +
      '<td class="muted" style="width:80px">学校：</td><td>' + Ue(target.school) + '</td>' +
      '<td class="muted" style="width:110px">班级（届别）：</td><td>' + Ue(target.cls) +
      (grade && grade !== target.cls ? ' <span class="chip ch-blue">' + Ue(grade) + '</span>' : '') + '</td></tr>' +
      '<tr><td class="muted">考试：</td><td>' + Ue(target.exam) + '</td>' +
      '<td class="muted">生成时间：</td><td colspan="3">' + Ue(U.nowStr()) + '</td></tr></table></div>';

    if (anErr) {
      h += secWrap('一、成绩总览', '成绩总览', function () { throw anErr; });
      h += secWrap('二、各科表现', '各科表现', function () { throw anErr; });
      h += secWrap('三、位次', '位次', function () { throw anErr; });
      h += secWrap('四、趋势', '趋势', function () { throw anErr; });
      h += secWrap('五、优势与短板', '优势与短板', function () { throw anErr; });
      h += secWrap('六、阶段规划', '阶段规划', function () { throw anErr; });
    } else {
      h += sectionOverview(an, target);
      h += sectionSubjects(an);
      h += sectionRank(an, gradeSize);
      h += sectionTrend(an, target);
      h += sectionGoodWeak(an);
      h += sectionPlan(target, an, loc, gradeRows, classRows, studentRows);
    }

    h += '<div class="r-body muted" style="padding-bottom:14px;font-size:11.5px;line-height:1.8">' +
      '统计口径：选科由成绩数据自动识别——语数英为必考，选考科目取分数最高的 3 门计入总分；' +
      '未收集到的科目（0 分 / 未填）不计入分母，避免拉低得分率。' +
      '得分率 = 总分 ÷ 动态满分（满配 6 科 750 分、及格线 450 分；仅语数英 3 科时为 450 分 / 270 分）。' +
      '不同选科组合之间只比得分率，不比绝对分。</div>';
    h += '</div>';
    return h;
  }

  /* ---------- 一、成绩总览 ---------- */
  function sectionOverview(an, target) {
    return secWrap('一、成绩总览', '成绩总览', function () {
      var ov = an.overview;
      var tone = ov.passed ? (ov.totalRate >= 0.75 ? 'an-good' : 'an-mid') : 'an-weak';
      var showT = shownTotal(ov);              // 超满分时显示 min(total, full)

      /* 大号总分 + 及格线标记 + 得分率进度条 */
      var h = '<div class="an-total ' + tone + '">' +
        '<div class="an-total-v">' + U.f1(showT) +
        '<span> / ' + U.f1(ov.full) + '</span></div>' +
        '<div class="an-total-d">' + (ov.passed ? '已达' : '未达') + '及格线 ' + U.f1(ov.passLine) + ' 分（' +
        (ov.passed ? '高 ' + U.f1(showT - ov.passLine) : '差 ' + U.f1(ov.passLine - showT)) + ' 分）</div>' +
        (ov.overfull
          ? '<div class="an-total-d" style="color:#c8892e">检测到超满分录入，得分率已按满分截断</div>'
          : '') +
        '</div>';

      h += '<div class="an-rate">' + rateBar(ov.totalRate, ov.classN ? ov.classAvgRate : null, '班均') +
        '<div class="an-rate-txt">得分率 <b>' + ratePct(ov.totalRate) + '%</b>' +
        '　·　及格基准 60%　·　竖标为班均得分率 ' + rateText(ov.classAvgRate) + '</div></div>';

      /* KPI：位次 / 及格科目 / 选科构成 */
      h += '<div class="an-grid">';
      h += anKpi('班级位次', ov.rankClass > 0 ? ov.rankClass + ' <span style="font-size:13px;color:#8b96a3">/ ' + ov.classTotal + '</span>' : '—',
        ov.rankClass > 0
          ? '前 ' + (ov.classPct > 0 ? ov.classPct + '%' : '<0.1%') + ' · 按得分率排名'
          : '班级样本不足，暂不排名');
      h += anKpi('年级位次', ov.rank > 0 ? ov.rank + ' <span style="font-size:13px;color:#8b96a3">/ ' + ov.rankTotal + '</span>' : '—',
        ov.rank > 0
          ? (ov.pctInvalid ? '百分位待核对年级人数' : '前 ' + (ov.pct > 0 ? ov.pct + '%' : '<0.1%')) +
            ' · ' + (ov.rankSource === 'teacher' ? '校内录入排名' : '系统内按得分率计算')
          : '未录入总分排名，且年级样本不足');
      h += anKpi('及格科目', ov.passCount + ' <span style="font-size:13px;color:#8b96a3">/ ' + ov.subjectCount + '</span>',
        '单科线：语数英 90 · 选科 60');
      h += anKpi('计分构成', '语数英 ' + ov.coreCount + ' + 选科 ' + ov.electiveCount,
        ov.complete ? '6 科齐全（满分 ' + U.f1(ov.full) + '）' : '未满 3 门选科，满分 ' + U.f1(ov.full));
      h += '</div>';

      /* 一句话结论 */
      h += '<div class="an-note">' + Ue(an.summary.headline) + '。</div>';

      var notes = [];
      if (ov.overflow) {
        notes.push('检测到 ' + (ov.droppedElectives.length + K.ELECTIVE_MAX) + ' 门选科成绩，按最高 ' +
          K.ELECTIVE_MAX + ' 门计入（' + ov.droppedElectives.join('、') + ' 未计入）。');
      }
      if (ov.missingCore && ov.missingCore.length) {
        notes.push('必考科目未录入：' + ov.missingCore.join('、') + '（不计入分母，得分率仍按已计入科目计算）。');
      }
      /* 脏数据：总分超过动态满分（单科填超满分）时明确说清展示与计分口径 */
      if (ov.overfull) {
        notes.push('检测到超满分录入，得分率已按满分截断（录入总分 ' + U.f1(ov.total) + ' 高于动态满分 ' +
          U.f1(ov.full) + '，报告按 ' + U.f1(ov.full) + ' 计），请核对对应科目成绩。');
      }
      if (notes.length) h += '<div class="an-note" style="border-left-color:#c8892e;background:#fdf8ee">' + Ue(notes.join('')) + '</div>';
      return h;
    });
  }

  /* ---------- 二、各科表现 ---------- */
  function sectionSubjects(an) {
    return secWrap('二、各科表现', '各科表现', function () {
      var ov = an.overview;
      var h = '<div class="tbl-wrap" style="max-height:none"><table class="an-table"><thead><tr>' +
        '<th>科目</th><th class="num">得分 / 满分</th><th class="num">得分率</th>' +
        '<th style="min-width:220px">得分率（虚线 60% 及格基准，竖标班均）</th><th class="num">班均</th>' +
        '</tr></thead><tbody>';

      an.subjects.forEach(function (s) {
        h += '<tr><td><b>' + Ue(s.name) + '</b></td>' +
          '<td class="num">' + U.f1(s.score) + ' <span class="muted">/ ' + s.full + '</span></td>' +
          '<td class="num">' + rateText(s.rate) + '</td>' +
          '<td>' + rateBar(s.rate, s.classN ? s.classAvgRate : null, '班均') + '</td>' +
          '<td class="num muted">' + (s.classN ? U.f1(s.classAvg) + ' · ' + rateText(s.classAvgRate) : '—') + '</td></tr>';
      });

      /* 总分行 */
      h += '<tr style="background:#fffbea;font-weight:600"><td>总分</td>' +
        '<td class="num">' + U.f1(shownTotal(ov)) + ' / ' + U.f1(ov.full) + '</td>' +
        '<td class="num">' + rateText(ov.totalRate) + '</td>' +
        '<td>' + rateBar(ov.totalRate, ov.classN ? ov.classAvgRate : null, '班均') + '</td>' +
        '<td class="num muted">' + (ov.classN ? U.f1(ov.classAvg) + ' · ' + rateText(ov.classAvgRate) : '—') + '</td></tr>';
      h += '</tbody></table></div>';

      /* 未计入科目：一行小字说明 */
      var skip = [];
      if (an.absent && an.absent.length) skip.push('缺考 / 未选：' + an.absent.join('、'));
      if (an.dropped && an.dropped.length) {
        skip.push('超 3 门舍弃：' + an.dropped.join('、') + '（已按最高 3 门计入）');
      }
      if (skip.length) {
        h += '<div class="muted" style="margin-top:6px;font-size:11.5px">未计入：' + Ue(skip.join('　·　')) +
          '。这些科目不计入分母，因此不会拉低得分率。</div>';
      }
      h += '<div class="muted" style="margin-top:4px;font-size:11.5px">' +
        '颜色语义：绿 = 已达 60% 及格基准，琥珀 = 临界（55%~60%），红 = 薄弱（&lt;55%）。</div>';
      return h;
    });
  }

  /* ---------- 五、优势与短板 ---------- */
  function sectionGoodWeak(an) {
    return secWrap('五、优势与短板', '优势与短板', function () {
      var FIX = (App.Analysis && App.Analysis.FIX) || {};
      var KEEP = (App.Analysis && App.Analysis.KEEP) || {};

      var good = an.subjects.filter(function (s) { return s.band === 'good'; })
        .sort(function (a, b) { return b.rate - a.rate; }).slice(0, 3);
      var weak = an.subjects.filter(function (s) { return s.band === 'weak'; })
        .sort(function (a, b) { return a.rate - b.rate; }).slice(0, 3);

      function col(list, tone, tag, lib, emptyTxt) {
        var h = '<div>' +
          '<div class="an-sub">' + tag + '<span class="muted">' +
          (tone === 'good' ? '得分率 ≥75% 且领先均分，最多 3 条' : '得分率 &lt;60% 或显著低于班均，最多 3 条') +
          '</span></div>';
        if (!list.length) return h + '<div class="an-note">' + Ue(emptyTxt) + '</div></div>';
        h += list.map(function (s) {
          return '<div class="an-card an-' + tone + '">' +
            '<div class="an-card-h"><b>' + Ue(s.name) + '</b>' +
            '<span class="an-tag an-' + tone + '">' + U.f1(s.score) + ' / ' + s.full + '</span>' +
            '<span class="muted" style="font-size:11.5px">得分率 ' + rateText(s.rate) +
            (s.classN ? '（' + (s.classRateDiff >= 0 ? '高' : '低') + '班均 ' +
              U.f1(Math.abs(s.classRateDiff) * 100) + ' 个百分点）' : '') + '</span></div>' +
            '<div class="an-card-m">' + Ue(lib[s.name] || (tone === 'good'
              ? '每周 1 套限时套卷保持手感' : '每天 20 分钟只做基础题，先把正确率做到 85%')) + '。</div>' +
            '</div>';
        }).join('');
        return h + '</div>';
      }

      var advice = (an.summary && an.summary.advice) || [];
      var foot = advice.length
        ? '<div class="an-sub">行动建议<span class="muted">3 条，可当天执行</span></div>' +
          '<ol class="an-advice">' + advice.map(function (a) { return '<li>' + Ue(a) + '</li>'; }).join('') + '</ol>'
        : '';

      return '<div class="grid g2">' +
        col(good, 'good', '优势科目', KEEP, '本次没有达到优势线的科目，缺少能稳定拉开差距的强项。') +
        col(weak, 'weak', '短板科目', FIX, '各科均未触发薄弱条件，短板不明显，提分重点转向高分段。') +
        '</div>' + foot;

    });
  }

  /* ---------- 四、趋势 ---------- */
  function sectionTrend(an, target) {
    return secWrap('四、趋势', '趋势', function () {
      var exams = an.trend.exams || [];
      if (exams.length < 2) {
        return '<div class="an-note">仅 1 次考试记录，暂不生成趋势图；再录入一次考试后即可看到得分率与总分的进退。</div>';
      }
      var first = exams[0], last = exams[exams.length - 1];
      /* 展示口径：单次考试总分也按各自动态满分截断（历史脏数据兜底），增量随之重算 */
      var cap1 = first.full > 0 ? first.full : first.total;
      var cap2 = last.full > 0 ? last.full : last.total;
      var t1 = Math.min(first.total, cap1);
      var t2 = Math.min(last.total, cap2);
      var dTotal = Math.round((t2 - t1) * 10) / 10;
      var dRate = an.trend.rateDelta;
      var h = '<div id="an-chart-trend"></div>';

      /* 结论 1：总分与得分率变化 */
      h += '<div class="an-note">共 ' + exams.length + ' 次考试：总分由 ' + U.f1(t1) + ' 变为 ' +
        U.f1(t2) + '（' + (dTotal > 0 ? '+' : '') + U.f1(dTotal) + ' 分），得分率 ' +
        rateText(first.rate) + ' → ' + rateText(last.rate) + '（' + (dRate > 0 ? '+' : '') + U.f1(dRate) + ' 个百分点）。</div>';

      /* 结论 2：进退科目（只列计入科目） */
      var ups = an.trend.bySubject.filter(function (x) { return x.counted && x.dir === 'up'; });
      var downs = an.trend.bySubject.filter(function (x) { return x.counted && x.dir === 'down'; });
      var flatCnt = an.trend.bySubject.filter(function (x) { return x.counted && x.dir === 'flat'; }).length;
      var seg = [];
      seg.push('进步科目：' + (ups.length
        ? ups.map(function (x) { return x.name + '（+' + U.f1(x.delta) + '）'; }).join('、')
        : '无'));
      seg.push('退步科目：' + (downs.length
        ? downs.map(function (x) { return x.name + '（' + U.f1(x.delta) + '）'; }).join('、')
        : '无'));
      if (flatCnt) seg.push('持平 ' + flatCnt + ' 科');
      h += '<div class="an-note">' + Ue(seg.join('　·　')) + '。' +
        (an.trend.rankDelta !== 0
          ? '总分排名' + (an.trend.rankDelta > 0 ? '前进 ' + an.trend.rankDelta + ' 名' : '后退 ' + Math.abs(an.trend.rankDelta) + ' 名') + '。'
          : '') + '</div>';
      return h;
    });
  }

  /* ---------- 三、位次 ---------- */
  function sectionRank(an, gradeSize) {
    return secWrap('三、位次', '位次', function () {
      var ov = an.overview;
      var srcTxt = ov.rankSource === 'teacher' ? '校内录入排名'
        : (ov.rankSource === 'system' ? '系统内按得分率计算' : '暂无排名');

      /* 班级 / 年级并列展示，附百分位 */
      var h = '<div class="an-grid">';
      h += anKpi('班级排名', ov.rankClass > 0 ? ov.rankClass + ' <span style="font-size:13px;color:#8b96a3">/ ' + ov.classTotal + '</span>' : '—',
        ov.rankClass > 0
          ? '百分位 前 ' + (ov.classPct > 0 ? ov.classPct + '%' : '<0.1%') + '（按得分率）'
          : '班级有效样本不足');
      h += anKpi('年级排名', ov.rank > 0 ? ov.rank + ' <span style="font-size:13px;color:#8b96a3">/ ' + ov.rankTotal + '</span>' : '—',
        ov.rank > 0
          ? (ov.pctInvalid ? '百分位待核对年级人数' : '百分位 前 ' + (ov.pct > 0 ? ov.pct + '%' : '<0.1%')) + ' · ' + srcTxt
          : '未录入总分排名，且年级样本不足');
      h += anKpi('计分口径', '按得分率排名',
        '不同选科组合满分不同，位次只比得分率，不比绝对分');
      h += '</div>';

      h += '<div class="tbl-wrap" style="max-height:none"><table class="an-table"><thead><tr>' +
        '<th>科目 / 总分</th><th class="num">成绩</th><th class="num">得分率</th>' +
        '<th class="num">班级排名</th><th class="num">班级百分位</th>' +
        '<th class="num">年级排名</th><th class="num">年级百分位</th><th>年级排名来源</th></tr></thead><tbody>';
      an.rankTable.forEach(function (r) {
        var src = SOURCE_TEXT[r.rankGradeSource] || '—';
        h += '<tr' + (r.idx === 'total' ? ' style="background:#fffbea;font-weight:600"' : '') + '>' +
          '<td>' + (r.idx === 'total' ? '<b>总分</b>' : Ue(r.name)) + '</td>' +
          '<td class="num">' + U.f1(r.score) + (r.full ? ' <span class="muted">/ ' + r.full + '</span>' : '') + '</td>' +
          '<td class="num">' + rateText(r.rate) + '</td>' +
          '<td class="num">' + (r.rankClass > 0 ? r.rankClass : '—') + '</td>' +
          '<td class="num muted">' + (r.rankClass > 0 && r.classPct > 0 ? '前 ' + r.classPct + '%' : '—') + '</td>' +
          '<td class="num">' + (r.rankGrade > 0 ? r.rankGrade : '—') + '</td>' +
          '<td class="num">' + (r.rankGrade > 0 && !r.pctInvalid
            ? '前 ' + (r.pct > 0 ? r.pct + '%' : '<0.1%') : '—') + '</td>' +
          '<td class="muted">' + src + '</td></tr>';
      });
      h += '</tbody></table></div>';

      /* 排名超出年级人数：表下给一行口径提示，不改写年级人数 */
      var bad = an.rankTable.filter(function (r) { return r.pctInvalid; });
      if (bad.length) {
        var b0 = bad[0];
        var names = bad.length > 2
          ? (b0.idx === 'total' ? '总分' : b0.name) + '等 ' + bad.length + ' 项'
          : bad.map(function (r) { return r.idx === 'total' ? '总分' : r.name; }).join('、');
        h += '<div class="an-note" style="color:#c0392b">' + Ue(names) + '已录入排名 ' + b0.rankGrade +
          ' 超出年级人数 ' + b0.gradeTotal + '，百分位暂不计算（显示「—」），请核对「年级人数」或排名。</div>';
      }

      var n = gradeSize && Number(gradeSize.n) > 0 ? Math.floor(Number(gradeSize.n)) : 0;
      var noteSrc = gradeSize && gradeSize.note ? gradeSize.note : '年级人数未知';
      h += '<div class="an-note">年级人数来源：<b>' + (n > 0 ? n + ' 人' : '未知') + '</b> · ' + Ue(noteSrc) + '。' +
        (n > 0 ? '百分位 = 名次 ÷ 年级人数，越小越靠前。' : '') + '</div>';
      if (!n) {
        h += '<div class="an-note">年级人数未知：已按系统内 ' + an.overview.gradeN +
          ' 人计算，请填写实际年级人数以提高百分位准确度。</div>';
      }
      h += '<div class="an-note no-print">手动覆盖年级人数（写入本机本次会话，仅影响百分位计算）：' +
        '<input id="an-graden" type="number" min="1" step="1" value="' + (n > 0 ? n : '') +
        '" placeholder="如 1200" style="width:110px;margin:0 6px">' +
        '<button id="an-graden-apply" class="ghost">应用</button>' +
        (n > 0 ? ' <span class="muted">当前生效：' + n + ' 人 · ' + Ue(SOURCE_TEXT[gradeSize.source] || gradeSize.source || '') + '</span>' : '') +
        '</div>';
      return h;
    });
  }

  /* ---------- 六、阶段规划（提分目标 + 院校定位结论） ---------- */
  function sectionPlan(target, an, loc, gradeRows, classRows, studentRows) {
    return secWrap('六、阶段规划', '阶段规划', function () {
      if (!App.StudyPlan || !App.StudyPlan.build) return '<div class="an-note">提分方案模块未加载。</div>';
      var plan = App.StudyPlan.build({
        target: target, analysis: an, loc: loc, gradeRows: gradeRows, classRows: classRows
      });
      var ov = an.overview;
      var SRC = {
        line: '26 届批次线 · 定位表名次',
        top: '已越 985 线 · 稳线冲分',
        fallback: '科类未识别 · 按得分率档位'
      };
      /* 目标总分的副标题：优先显示对标的具体批次线（物理/历史 + 档位 + 分数线） */
      var tgtSub = plan.targetLine
        ? '26 届' + (plan.track || '') + ' · ' + plan.targetLine.name + ' ' + plan.targetLine.line + ' 分'
        : (SRC[plan.targetTotalSource] || plan.targetTotalSource);
      var h = '';

      /* 目标总分三件套 */
      h += '<div class="an-grid">' +
        anKpi('当前总分', U.f1(shownTotal(ov)) + ' <span style="font-size:13px;color:#8b96a3">/ ' + U.f1(ov.full) + '</span>',
          '得分率 ' + rateText(ov.totalRate)) +
        anKpi('目标总分', U.f1(plan.targetTotal), Ue(tgtSub)) +
        anKpi('需提高', plan.delta > 0 ? '+' + U.f1(plan.delta) : '0',
          plan.delta > 0 ? '只在本生已计入科目内分摊，单科不超满分' : '已达该组合满分，目标转为保持与单科均衡') +
        '</div>';

      /* 提分目标表：≤5 行 */
      var allNeed = plan.perSubject.filter(function (x) { return x.delta > 0; })
        .sort(function (a, b) { return a.priority - b.priority; });
      var need = allNeed.slice(0, 5);
      h += '<div class="an-sub">提分目标<span class="muted">按优先级排序，最多 5 行</span></div>';
      if (need.length) {
        h += '<div class="tbl-wrap" style="max-height:none"><table class="an-table"><thead><tr>' +
          '<th>科目</th><th class="num">当前</th><th class="num">目标</th><th class="num">差距</th>' +
          '<th>一句话动作</th></tr></thead><tbody>';
        need.forEach(function (x) {
          var act = (x.actions && x.actions.length) ? x.actions[0] : '每天 20 分钟只做该科基础题，正确率目标 ≥85%';
          h += '<tr><td><b>' + Ue(x.name) + '</b></td>' +
            '<td class="num">' + U.f1(x.cur) + ' <span class="muted">/ ' + x.full + '</span></td>' +
            '<td class="num">' + U.f1(x.goal) + '</td>' +
            '<td class="num" style="color:#c0392b;font-weight:600">+' + U.f1(x.delta) + '</td>' +
            '<td class="advice">' + Ue(act) + '</td></tr>';
        });
        h += '</tbody></table></div>';
        var sumNeed = allNeed.reduce(function (a, x) { return a + x.delta; }, 0);
        h += '<div class="muted" style="margin-top:6px;font-size:11.5px">' +
          (allNeed.length > need.length ? '表中仅列前 ' + need.length + ' 项，' : '') +
          '全部提分缺口合计 +' + U.f1(sumNeed) + ' 分（与上方「需提高 ' + U.f1(plan.delta) +
          ' 分」一致）；未列出的科目以保持为主。</div>';
      } else {
        h += '<div class="an-note">当前各科已无明确提分缺口，保持现有训练节奏即可。</div>';
      }

      /* 院校定位结论 */
      var tierTxt;
      if (plan.tier.ok) {
        tierTxt = '当前可报「' + plan.tier.name + '」' +
          (plan.tier.reachedTop
            ? '，已达表内最高档次，后续以院校/专业选择为主。'
            : (plan.tier.noUpper
              ? '，上方档次未划线，目标改为稳住当前档次并扩大专业选择空间。'
              : '，再超越 ' + plan.tier.gap + ' 名（进入前 ' + (loc && loc.nextLimit ? loc.nextLimit : '—') +
                ' 名）即可升到「' + plan.tier.nextName + '」。'));
      } else {
        tierTxt = '院校定位未给出可用档次（' +
          (plan.tier.reason === 'no-school' ? '定位表暂无该学校数据'
            : (plan.tier.reason === 'no-rank' ? '缺少总分排名'
              : (plan.tier.reason === 'no-track' ? '物理/历史成绩无法自动判定科类，可在下方手动选择'
                : '排名未达表内最低线'))) +
          '），提分目标改按 26 届批次线设定，不再用名次反推分数。';
      }
      var m2 = plan.milestones && plan.milestones.length ? plan.milestones[plan.milestones.length - 1] : null;
      h += '<div class="an-note">院校定位：' + Ue(tierTxt) +
        (plan.delta > 0
          ? '目标总分 ' + U.f1(plan.targetTotal) + ' 分（当前 ' + U.f1(shownTotal(ov)) +
            '，需提高 ' + U.f1(plan.delta) + ' 分）。'
          : '当前总分 ' + U.f1(shownTotal(ov)) + ' 分已达该组合满分 ' + U.f1(ov.full) +
            '，目标转为保持与单科均衡。') +
        (m2 ? '本学期末节点：' + Ue(m2.note) + '。' : '') + '</div>';

      /* 院校定位明细（定位表 / 冲稳保院校清单，由 locator.js 渲染） */
      h += '<div class="an-sub">院校定位明细</div>';
      h += locatorSection(target, classRows || [], studentRows || []);
      return h;
    });
  }

  /* =========================================================
   * Tab 4：班级考试统计
   * ========================================================= */
  function renderStats() {
    var all = allRecords();
    if (!all.length) return '<div class="card"><div class="empty">成绩总表暂无数据。</div></div>';
    var oAll = Score.options(all);

    // 组合：「学校 | 班级 | 考试」（比原版更严谨，避免同名班级跨校合并）
    var groups = {}, order = [];
    all.forEach(function (r) {
      var k = r.school + '\u0001' + r.cls + '\u0001' + r.exam;
      if (!groups[k]) { groups[k] = { exam: r.exam, cls: r.cls, school: r.school }; order.push(k); }
    });
    order.sort(function (a, b) {
      return U.zh(groups[a].exam, groups[b].exam) || U.zh(groups[a].cls, groups[b].cls);
    });

    var sel = state.statExam;
    var h = '<div class="card"><h3>班级考试统计<span class="h-note">随录入实时更新，无需点按钮</span></h3>' +
      '<div class="toolbar"><label class="f">筛选考试<select id="s-exam">' + opts(oAll.exams, sel) + '</select></label>' +
      '<div style="flex:1"></div><button id="s-csv">导出 CSV</button><button id="s-xlsx">导出 Excel</button></div>';

    var shown = sel ? order.filter(function (k) { return groups[k].exam === sel; }) : order;
    if (!shown.length) { h += '<div class="empty">没有符合条件的记录。</div></div>'; return h; }

    var rowsExport = [['考试名称', '学校', '班级', '科目', '最高分', '最低分', '均分', '及格率(%)', '参考人数']];

    shown.forEach(function (k) {
      var g = groups[k];
      var prows = byCond(all, { school: g.school, cls: g.cls, exam: g.exam });
      h += '<div style="margin:14px 0 6px;font-size:13px"><b>' + U.esc(g.exam) + '</b>' +
        ' <span class="chip ch-blue">' + U.esc(g.school) + ' ' + U.esc(g.cls) + '</span>' +
        ' <span class="muted">' + prows.length + ' 人</span></div>';
      h += '<div class="tbl-wrap" style="max-height:none"><table><thead><tr><th>科目</th>' +
        '<th class="num">最高分</th><th class="num">最低分</th><th class="num">均分</th>' +
        '<th class="num">及格率</th><th class="num">参考人数</th></tr></thead><tbody>';
      S.forEach(function (s, i) {
        var st = Score.stat(prows, i);
        h += '<tr><td>' + s + '</td><td class="num">' + (st.max === null ? '-' : U.f1(st.max)) + '</td>' +
          '<td class="num">' + (st.min === null ? '-' : U.f1(st.min)) + '</td>' +
          '<td class="num">' + (st.count ? U.f1(st.avg) : '-') + '</td>' +
          '<td class="num">' + (st.count ? rateCell(st.passRate) : '-') + '</td>' +
          '<td class="num">' + st.count + '</td></tr>';
        rowsExport.push([g.exam, g.school, g.cls, s, st.max === null ? '-' : Math.round(st.max * 10) / 10,
          st.min === null ? '-' : Math.round(st.min * 10) / 10,
          st.count ? Math.round(st.avg * 10) / 10 : '-',
          st.count ? Math.round(st.passRate * 10) / 10 : '-', st.count]);
      });
      var tst = Score.stat(prows, 'total');
      h += '<tr style="background:#fffbea;font-weight:600"><td>总分</td>' +
        '<td class="num">' + (tst.max === null ? '-' : U.f1(tst.max)) + '</td>' +
        '<td class="num">' + (tst.min === null ? '-' : U.f1(tst.min)) + '</td>' +
        '<td class="num">' + (tst.count ? U.f1(tst.avg) : '-') + '</td>' +
        '<td class="num">' + (tst.count ? rateCell(tst.passRate) : '-') + '</td>' +
        '<td class="num">' + tst.count + '</td></tr>';
      rowsExport.push([g.exam, g.school, g.cls, '总分', tst.max === null ? '-' : Math.round(tst.max * 10) / 10,
        tst.min === null ? '-' : Math.round(tst.min * 10) / 10,
        tst.count ? Math.round(tst.avg * 10) / 10 : '-',
        tst.count ? Math.round(tst.passRate * 10) / 10 : '-', tst.count]);
      h += '</tbody></table></div>';
    });
    h += '</div>';

    function rateCell(p) {
      var cls = p >= 85 ? 'ch-green' : (p >= 60 ? 'ch-amber' : 'ch-red');
      return '<span class="chip ' + cls + '">' + U.f1(p) + '%</span>';
    }

    state._statsExport = rowsExport;
    return h;
  }

  function bindStats(host) {
    var sel = host.querySelector('#s-exam');
    if (sel) sel.addEventListener('change', function () { state.statExam = sel.value; App.render(); });
    var c = host.querySelector('#s-csv'), x = host.querySelector('#s-xlsx');
    if (c) c.addEventListener('click', function () {
      App.X.downloadCSV('班级考试统计_' + U.nowStr().replace(/[-: ]/g, '') + '.csv', state._statsExport);
      Toast('已导出 CSV', 'ok');
    });
    if (x) x.addEventListener('click', function () {
      App.X.downloadXLSX('班级考试统计_' + U.nowStr().replace(/[-: ]/g, '') + '.xlsx',
        [{ name: '班级考试统计', rows: state._statsExport }]);
      Toast('已导出 Excel', 'ok');
    });
  }

  /* =========================================================
   * 模块注册
   * ========================================================= */
  var TABS = [
    { id: 'entry', name: '① 成绩录入' },
    { id: 'master', name: '② 成绩总表' },
    { id: 'query', name: '③ 查询分析' },
    { id: 'stats', name: '④ 班级统计' }
  ];

  App.registerModule({
    id: 'score', name: '成绩管理', icon: ICON, ready: true,
    /* T6：管理员与教师同权使用成绩管理（teacherOnly 已移除），
       访问与写入都只由账号状态（App.Sync.canEdit）决定。 */
    order: 5,                   // 导航排序：home(0) → score(5) → 业务模块(10..)
    title: '成绩管理', subtitle: '登记 · 收集 · 分析（完整复刻原 Excel VBA 系统）',
    render: function () {
      /* L3 直达拦截：无权限（理论上不再有角色差异）时输出统一 403 卡片，
         只读账号不在此拦截 —— 可以进模块查看，保存时由 guardEdit 拒绝 */
      if (App.Perm && App.Perm.denied(this)) return App.Perm.forbiddenCard(this);
      var h = '<div class="toolbar no-print" style="margin-bottom:14px">';
      TABS.forEach(function (t) {
        h += '<button data-tab="' + t.id + '"' + (state.tab === t.id ? ' class="primary"' : '') + '>' + t.name + '</button>';
      });
      h += '</div>';
      if (state.tab === 'entry') h += renderEntry();
      else if (state.tab === 'master') h += renderMaster();
      else if (state.tab === 'query') h += renderQuery();
      else h += renderStats();
      return h;
    },
    bind: function (host) {
      host.querySelectorAll('[data-tab]').forEach(function (b) {
        b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); App.render(); });
      });
      if (state.tab === 'entry') bindEntry(host);
      else if (state.tab === 'master') bindMaster(host);
      else if (state.tab === 'query') bindQuery(host);
      else bindStats(host);
    },
    openForm: openForm,
    state: state
  });

  App.ScoreModule = { openForm: openForm, state: state, reportHTML: reportHTML };
})(window.App);

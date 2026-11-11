/* =========================================================
 * 班级管理模块（PRD §3.3）
 *
 * 列表页：卡片网格（班级名 / 老师 / 课室 / 上课时间 / 学生数 / 年级科目标签 / 详情·编辑·删除）
 * 详情页 Tab① 班级学生（含「从学生管理选择」「新建学生并加入」「编辑学生=写回学生表」「仅移除桥表」）
 *        Tab② 成绩分析（弱关联：姓名 + 学校；统计一律复用 App.Score.*，绝不回写成绩）
 *
 * 纯函数外露（可测）：App.ClassesCore = { scheduleText, validate, dupName, classScoreAnalysis }
 *   classScoreAnalysis(classId, deps) 的 deps 显式注入 { students, members, records }，
 *   不在函数内部读 App.DB / App.Store，便于测试喂假数据。
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Toast = App.Toast, Modal = App.Modal, UI = App.UI, Score = App.Score;
  var K = App.K;

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/>' +
    '<path d="M3 10h18M9 10v11"/></svg>';

  var state = {
    view: 'list',          // 'list' | 'detail'
    classId: null,
    tab: 'students',       // 'students' | 'analysis'
    kw: '',                // Tab① 姓名关键字
    grade: '',             // Tab① 年级筛选
    refocus: ''
  };

  function esc(s) { return U.esc(s); }
  function classesTable() { return App.DB.table('classes'); }
  function studentsTable() { return App.DB.table('students'); }
  function membersTable() { return App.DB.table('class_members'); }

  function r1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
  function r4(v) { return Math.round((Number(v) || 0) * 10000) / 10000; }

  /* =========================================================
   * 纯函数
   * ========================================================= */
  var ClassesCore = {
    /** 「周二 18:30–20:30；周六 09:00–11:00」 */
    scheduleText: function (schedules) { return UI.scheduleText(schedules); },

    /**
     * 班级表单校验（PRD §3.3 字段表）。
     * @param {Object} form {class_name, teachers, room, schedules, grade, subject}
     * @param {Array} classes 全部班级（查重用）
     * @param {*} exceptId 编辑时排除自身
     * @returns {string} '' = 通过
     */
    validate: function (form, classes, exceptId) {
      var f = form || {};
      var name = String(f.class_name === null || f.class_name === undefined ? '' : f.class_name).trim();
      if (!name) return '班级名称不能为空';
      if (name.length > 30) return '班级名称不能超过 30 个字';
      var dup = ClassesCore.dupName(name, classes, exceptId);
      if (dup) return '该班级名称已存在';

      if (!(f.teachers && f.teachers.length)) return '班级老师至少选择 1 位';

      var room = String(f.room || '').trim();
      if (room.length > 20) return '课室不能超过 20 个字';

      var sc = f.schedules || [];
      if (!sc.length) return '上课时间至少填写 1 条';
      for (var i = 0; i < sc.length; i++) {
        var s = sc[i] || {};
        var wd = Number(s.weekday);
        if (!(wd >= 1 && wd <= 7)) return '第 ' + (i + 1) + ' 条上课时间的星期不正确';
        if (!s.start || !s.end) return '第 ' + (i + 1) + ' 条上课时间需要同时填写开始与结束时间';
        if (!(String(s.start) < String(s.end))) return '第 ' + (i + 1) + ' 条上课时间的开始时间必须早于结束时间';
      }
      if (f.grade && UI.GRADES.indexOf(f.grade) < 0) return '年级不在可选范围内';
      if (f.subject && UI.SUBJECTS.indexOf(f.subject) < 0) return '科目不在可选范围内';
      return '';
    },

    /** 班级名称全局唯一：命中返回该行，否则 null */
    dupName: function (name, classes, exceptId) {
      var n = String(name === null || name === undefined ? '' : name).trim();
      if (!n) return null;
      var list = classes || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].class_name || '').trim() !== n) continue;
        if (exceptId !== null && exceptId !== undefined && String(list[i].id) === String(exceptId)) continue;
        return list[i];
      }
      return null;
    },

    /**
     * 班级成绩分析（ARCH §4.5）。
     * 匹配口径：本班学生 → class_members → students；
     *           R(S) = records.filter(r.name === S.stu_name && r.school === S.school)
     *           —— 不限考试、不要求成绩记录里的班级字段与本班同名（弱关联）。
     * 同一学生同一考试多行 → 取 entered_at 最新一行。
     * 统计一律走 Score.stat / Score.total / Score.totalRate / Score.rankByRate，不自造满分与及格线。
     *
     * @param {*} classId
     * @param {{students:Array, members:Array, records:Array}} deps
     * @returns {{matched:Array, unmatched:Array, perExam:Array, perSubject:Array, perStudent:Array, kpi:Object}}
     */
    classScoreAnalysis: function (classId, deps) {
      var d = deps || {};
      var students = d.students || [];
      var members = d.members || [];
      var records = d.records || [];
      var cid = String(classId);

      var inClass = {};
      members.forEach(function (m) {
        if (String(m.class_id) === cid) inClass[String(m.student_id)] = true;
      });
      var mine = students.filter(function (s) { return inClass[String(s.id)]; });

      /** 成绩记录的「录入时间」：从云端下发时 entered_at 映射为 ts */
      function timeOf(r) {
        var raw = r && (r.entered_at || r.mod || r.ts);
        var t = Date.parse(raw || '');
        return isNaN(t) ? 0 : t;
      }

      var matched = [], unmatched = [], matchedRecs = [], seenRecs = [];
      mine.forEach(function (s) {
        var rows = records.filter(function (r) {
          return String(r.name || '') === String(s.stu_name || '') &&
            String(r.school || '') === String(s.school || '');
        });
        if (!rows.length) { unmatched.push(s); return; }
        var byExam = {};
        rows.forEach(function (r) {
          var ex = String(r.exam || '');
          var cur = byExam[ex];
          if (!cur || timeOf(r) >= timeOf(cur)) byExam[ex] = r;   // 同考试取最新
        });
        matched.push({ student: s, byExam: byExam });
        /* 弱关联允许多个学生命中同一条成绩（同名同校不同年级），
           统计池按「成绩行」去重，避免同一行被算两次把班均分/人数灌水。 */
        Object.keys(byExam).forEach(function (ex) {
          var rec = byExam[ex];
          if (seenRecs.indexOf(rec) >= 0) return;
          seenRecs.push(rec);
          matchedRecs.push(rec);
        });
      });

      /* 按考试分组（考试顺序 = 该考试最早录入时间升序） */
      var examMap = {};
      matchedRecs.forEach(function (r) {
        var ex = String(r.exam || '');
        (examMap[ex] = examMap[ex] || []).push(r);
      });
      var examNames = Object.keys(examMap).sort(function (a, b) {
        var ta = Math.min.apply(null, examMap[a].map(timeOf));
        var tb = Math.min.apply(null, examMap[b].map(timeOf));
        return (ta - tb) || U.zh(a, b);
      });

      var perExam = examNames.map(function (ex) {
        var rows = examMap[ex];
        var st = Score.stat(rows, 'total');
        return {
          exam: ex,
          count: st.count,
          avg: r1(st.avg),
          max: st.max,
          min: st.min,
          passRate: r1(st.passRate),
          avgRate: r4(st.avgRate),
          full: r1(st.avgFull),      // 样本内动态满分均值（不是写死的 750）
          line: st.line               // 动态及格线 = round(avgFull × 60%)
        };
      });

      var perSubject = [];
      /* 科目维度按「科目名单」枚举（K.SUBJECTS 固定 9 科）：
         刻意不引用核心里的科目数常量，避免业务模块把「满分/分母口径」二次实现，
         qa-750 第 19 组专门守这条线（该常量的使用只允许留在核心算法文件）。 */
      var n = (K && K.SUBJECTS && K.SUBJECTS.length) || 9;
      for (var i = 0; i < n; i++) {
        var st = Score.stat(matchedRecs, i);
        perSubject.push({
          idx: i,
          name: (K && K.SUBJECTS[i]) || String(i),
          count: st.count,
          avg: r1(st.avg),
          max: st.max,
          min: st.min,
          passRate: r1(st.passRate),
          avgRate: r4(st.avgRate),
          full: st.full,              // 单科固定满分（语数英 150 / 其余 100）
          line: st.line
        });
      }

      var perStudent = matched.map(function (m) {
        var list = Object.keys(m.byExam).map(function (ex) { return m.byExam[ex]; });
        list.sort(function (a, b) { return timeOf(a) - timeOf(b); });
        var last = list.length ? list[list.length - 1] : null;
        var prev = list.length > 1 ? list[list.length - 2] : null;
        var exam = last ? String(last.exam || '') : '';
        var pool = exam ? (examMap[exam] || []) : [];
        var rk = last ? Score.rankByRate(pool, last) : { rank: 0, total: 0, valid: false };
        return {
          student: m.student,
          last: last,
          prev: prev,
          exam: exam,
          total: last ? Score.total(last) : 0,
          full: last ? Score.fullTotal(last) : 0,
          rate: last ? Score.totalRate(last) : 0,
          rank: rk.rank,
          rankOf: rk.total,
          delta: (last && prev) ? (Score.total(last) - Score.total(prev)) : null
        };
      });

      return {
        matched: matched,
        unmatched: unmatched,
        perExam: perExam,
        perSubject: perSubject,
        perStudent: perStudent,
        kpi: {
          analyzable: mine.length,
          exams: perExam.length,
          matched: matched.length,
          unmatched: unmatched.length
        }
      };
    }
  };
  App.ClassesCore = ClassesCore;

  /* =========================================================
   * 班级表单
   * ========================================================= */
  function openForm(existing) {
    if (App.Perm && !App.Perm.assertWrite('classes')) return null;
    var all = classesTable().list();
    var body = document.createElement('div');
    var specs = [
      { name: 'class_name', label: '班级名称', value: existing ? existing.class_name : '', placeholder: '1–30 字，全局唯一' },
      { name: 'room', label: '课室', value: existing ? existing.room : '', placeholder: '如 302（可空）' },
      { name: 'grade', label: '年级', type: 'select', options: UI.GRADES, value: existing ? existing.grade : '', blank: '不指定' },
      { name: 'subject', label: '科目', type: 'select', options: UI.SUBJECTS, value: existing ? existing.subject : '', blank: '不指定' }
    ];
    body.innerHTML = '<div data-form-err></div>' + UI.formGrid(specs) +
      '<div class="form-grid">' +
      '<label class="f">班级老师 *<span data-mount="teachers"></span></label>' +
      '<label class="f">上课时间 *<span data-mount="schedules"></span>' +
      '<span class="muted" style="font-size:12px">星期 + 起止时间，可多条；开始须早于结束</span></label>' +
      '</div>';

    var msTeachers = UI.multiSelect({
      options: App.Students ? App.Students.teacherPool(studentsTable().list()) : [],
      value: existing ? (existing.teachers || []) : [],
      allowCustom: true,
      placeholder: '选择或手填老师'
    });
    var tr = UI.timeRow({ value: existing ? (existing.schedules || []) : [] });
    body.querySelector('[data-mount="teachers"]').appendChild(msTeachers.el);
    body.querySelector('[data-mount="schedules"]').appendChild(tr.el);

    function val(name) {
      var el = body.querySelector('[name="' + name + '"]');
      return el ? String(el.value || '') : '';
    }

    return UI.formModal({
      title: existing ? '编辑班级' : '新增班级',
      body: body,
      okText: existing ? '保存修改' : '保存',
      onSubmit: function () {
        UI.clearError(body);
        var form = {
          class_name: val('class_name'),
          room: val('room'),
          grade: val('grade'),
          subject: val('subject'),
          teachers: msTeachers.getValue(),
          schedules: tr.getValue()
        };
        var te = tr.validate();
        if (te) { UI.fail(body, te); return false; }
        var err = ClassesCore.validate(form, all, existing ? existing.id : null);
        if (err) {
          UI.fail(body, err);
          if (err === '该班级名称已存在') {
            var el = body.querySelector('[name="class_name"]');
            if (el) el.focus();
          }
          return false;
        }
        var payload = {
          class_name: String(form.class_name).trim(),
          room: String(form.room || '').trim(),
          grade: form.grade || '',
          subject: form.subject || '',
          teachers: form.teachers,
          schedules: form.schedules
        };
        var p = existing ? classesTable().update(existing.id, payload) : classesTable().insert(payload);
        p.then(function (row) {
          Toast(existing ? '已保存班级「' + row.class_name + '」' : '已新增班级「' + row.class_name + '」', 'ok');
          App.render();
        }).catch(function (e) {
          Toast(e && e.message ? e.message : '保存失败，请重试', 'error', 6000);
        });
        return true;
      }
    });
  }

  /* =========================================================
   * 删除班级（先清桥表，再删班级行）
   * ========================================================= */
  function removeClass(row) {
    if (App.Perm && !App.Perm.assertWrite('classes')) return;
    var cnt = membersTable().list().filter(function (m) { return String(m.class_id) === String(row.id); }).length;
    Modal.confirm(
      '确定删除班级 <b>' + esc(row.class_name) + '</b> 吗？<br>' +
      '本班 <b>' + cnt + '</b> 名学生的班级归属会被清除；' +
      '<b>删除班级不会删除班内学生的档案和任何成绩数据。</b>',
      function () {
        var chain = Promise.resolve();
        membersTable().list().filter(function (m) { return String(m.class_id) === String(row.id); })
          .forEach(function (m) {
            chain = chain.then(function () { return membersTable().remove(m.id).catch(function () { }); });
          });
        chain.then(function () { return classesTable().remove(row.id); }).then(function () {
          Toast('已删除班级「' + row.class_name + '」（学生档案与成绩保留）', 'ok');
          if (String(state.classId) === String(row.id)) { state.view = 'list'; state.classId = null; }
          App.render();
        }).catch(function (e) {
          Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 6000);
        });
      }, true);
  }

  /* =========================================================
   * 加学生进班
   * ========================================================= */
  function openAddStudents(classId) {
    if (App.Perm && !App.Perm.assertWrite('classes')) return null;
    var cls = classesTable().get(classId);
    if (!cls) return null;
    var allStudents = studentsTable().list();
    var memberIds = {};
    membersTable().list().forEach(function (m) {
      if (String(m.class_id) === String(classId)) memberIds[String(m.student_id)] = true;
    });
    var cand = allStudents.filter(function (s) { return !memberIds[String(s.id)]; });

    var body = document.createElement('div');
    body.innerHTML =
      '<div class="muted" style="margin-bottom:8px">勾选要加入「' + esc(cls.class_name) + '」的学生（可多选）</div>' +
      '<div class="toolbar" style="margin-bottom:8px">' +
      '<input id="pick-kw" placeholder="姓名 / 学校 / 联系方式" style="max-width:260px">' +
      '<button id="pick-new">新建学生并加入</button></div>' +
      '<div id="pick-list" class="tbl-wrap" style="max-height:320px;overflow:auto"></div>';

    var listBox = body.querySelector('#pick-list');
    var checked = {};

    function draw(kw) {
      var k = String(kw || '').trim();
      var rows = cand.filter(function (s) {
        if (!k) return true;
        return String(s.stu_name || '').indexOf(k) >= 0 ||
          String(s.school || '').indexOf(k) >= 0 ||
          String(s.phone || '').indexOf(k) >= 0;
      });
      if (!cand.length) {
        listBox.innerHTML = '<div class="empty">全部学生都已在本班。若还没有学生，点上方「新建学生并加入」。</div>';
        return;
      }
      if (!rows.length) {
        listBox.innerHTML = '<div class="empty">没有符合条件的学生</div>';
        return;
      }
      var h = '<table class="an-table"><thead><tr><th></th><th>姓名</th><th>学校</th><th>年级</th><th>联系方式</th></tr></thead><tbody>';
      rows.forEach(function (s) {
        h += '<tr><td><input type="checkbox" data-sid="' + esc(s.id) + '"' +
          (checked[String(s.id)] ? ' checked' : '') + '></td>' +
          '<td><b>' + esc(s.stu_name) + '</b></td><td>' + esc(s.school) + '</td>' +
          '<td>' + esc(s.grade) + '</td><td class="muted">' + esc(s.phone || '—') + '</td></tr>';
      });
      h += '</tbody></table>';
      listBox.innerHTML = h;
      Array.prototype.forEach.call(listBox.querySelectorAll('[data-sid]'), function (cb) {
        cb.addEventListener('change', function () {
          var sid = cb.getAttribute('data-sid');
          if (cb.checked) checked[String(sid)] = true; else delete checked[String(sid)];
        });
      });
    }
    draw('');

    var kwEl = body.querySelector('#pick-kw');
    if (kwEl) {
      U.onCommitted(kwEl, function (v) { draw(v); });
    }

    var newBtn = body.querySelector('#pick-new');
    if (newBtn) newBtn.addEventListener('click', function () {
      if (mask) mask.remove();
      if (App.Students) App.Students.openForm({ existing: null, presetClassId: classId });
    });

    var mask = Modal.open({
      title: '从学生管理选择',
      body: body,
      okText: '加入班级',
      onSubmit: null,
      onOk: function () {
        if (App.Perm && !App.Perm.assertWrite('classes')) return false;
        var ids = Object.keys(checked);
        if (!ids.length) { Toast('请先勾选要加入的学生', 'warn'); return false; }
        var chain = Promise.resolve(0);
        ids.forEach(function (sid) {
          chain = chain.then(function (n) {
            return membersTable().insert({
              class_id: App.Students ? App.Students.idValue(classId) : classId,
              student_id: App.Students ? App.Students.idValue(sid) : sid,
              created_by: (App.Sync && App.Sync.me && App.Sync.me()) || ''
            }).then(function () { return n + 1; })
              .catch(function () { return n; });
          });
        });
        chain.then(function (n) {
          Toast('已加入 ' + n + ' 名学生到「' + cls.class_name + '」', 'ok');
          App.render();
        });
        return true;
      }
    });
    return mask;
  }

  /* =========================================================
   * 从班级移除学生（只删桥表）
   * ========================================================= */
  function removeFromClass(classId, studentRow) {
    if (App.Perm && !App.Perm.assertWrite('classes')) return;
    var row = membersTable().list().filter(function (m) {
      return String(m.class_id) === String(classId) && String(m.student_id) === String(studentRow.id);
    })[0];
    if (!row) return;
    Modal.confirm(
      '将从本班移除该学生，<b>不会删除学生档案</b>，该生仍在『学生管理』中。是否继续？<br>' +
      '<span class="muted">' + esc(studentRow.stu_name) + '（' + esc(studentRow.school) + '）</span>',
      function () {
        membersTable().remove(row.id).then(function () {
          Toast('已从本班移除「' + studentRow.stu_name + '」', 'ok');
          App.render();
        }).catch(function (e) {
          Toast('移除失败：' + (e && e.message ? e.message : e), 'error', 6000);
        });
      }, true);
  }

  /* =========================================================
   * 列表页
   * ========================================================= */
  function renderList(classes, mm) {
    var h = '<div class="toolbar" style="margin-bottom:14px">' +
      '<div class="muted">共 ' + classes.length + ' 个班级</div><div class="spacer"></div>' +
      '<button class="primary" id="cls-add">新增班级</button></div>';

    if (!classes.length) {
      h += '<div class="card"><h3>班级</h3>' +
        UI.empty('还没有班级。点右上『新增班级』创建第一个班级。') + '</div>';
      return h;
    }

    h += '<div class="grid g3">';
    classes.forEach(function (c) {
      var n = membersTable().list().filter(function (m) { return String(m.class_id) === String(c.id); }).length;
      h += '<div class="card">' +
        '<h3 style="margin-bottom:8px">' + esc(c.class_name) +
        (c.grade ? ' <span class="chip ch-blue">' + esc(c.grade) + '</span>' : '') +
        (c.subject ? ' <span class="chip ch-gray">' + esc(c.subject) + '</span>' : '') + '</h3>' +
        '<div class="store-line"><span class="k">班级老师</span><b>' + esc((c.teachers || []).join('、') || '—') + '</b></div>' +
        '<div class="store-line"><span class="k">课室</span><b>' + esc(c.room || '—') + '</b></div>' +
        '<div class="store-line"><span class="k">上课时间</span><b>' + esc(ClassesCore.scheduleText(c.schedules)) + '</b></div>' +
        '<div class="store-line"><span class="k">学生数</span><b>' + n + ' 人</b></div>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button class="primary" data-act="detail" data-id="' + esc(c.id) + '">详情</button>' +
        '<button data-act="edit" data-id="' + esc(c.id) + '">编辑</button>' +
        '<button data-act="del" data-id="' + esc(c.id) + '" style="color:#c0392b">删除</button>' +
        '</div></div>';
    });
    h += '</div>';
    return h;
  }

  /* =========================================================
   * 详情页 Tab① 班级学生
   * ========================================================= */
  function renderDetailStudents(cls) {
    var allMembers = membersTable().list().filter(function (m) { return String(m.class_id) === String(cls.id); });
    var ids = {};
    allMembers.forEach(function (m) { ids[String(m.student_id)] = true; });
    var rows = studentsTable().list().filter(function (s) { return ids[String(s.id)]; });

    var kw = String(state.kw || '').trim();
    var filtered = rows.filter(function (s) {
      if (kw && String(s.stu_name || '').indexOf(kw) < 0) return false;
      if (state.grade && String(s.grade || '') !== String(state.grade)) return false;
      return true;
    });

    var h = '<div class="toolbar" style="flex-wrap:wrap;gap:8px;margin:10px 0">' +
      '<input id="cd-kw" placeholder="姓名关键字" value="' + esc(state.kw) + '" style="max-width:180px">' +
      '<select id="cd-grade"><option value="">全部年级</option>' +
      UI.optionsWithLabel(UI.GRADES, state.grade) + '</select>' +
      '<div class="spacer"></div>' +
      '<button class="primary" id="cd-add">添加入班</button>' +
      '</div>';

    if (!rows.length) {
      h += UI.empty('本班还没有学生，请先在『班级学生』中添加');
      return h;
    }
    if (!filtered.length) {
      h += '<div class="empty">没有符合条件的学生</div>';
      return h;
    }

    h += '<div class="muted" style="margin-bottom:6px">共 ' + filtered.length + ' 名学生' +
      (filtered.length !== rows.length ? '（已筛选，全班 ' + rows.length + ' 人）' : '') + '</div>';
    h += '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      '<th>姓名</th><th>学校</th><th>年级</th><th>联系方式</th><th>上课科目</th><th>上课老师</th><th class="c">操作</th>' +
      '</tr></thead><tbody>';
    filtered.forEach(function (s) {
      h += '<tr><td><b>' + esc(s.stu_name) + '</b></td><td>' + esc(s.school) + '</td>' +
        '<td>' + esc(s.grade) + '</td><td class="muted">' + esc(s.phone || '—') + '</td>' +
        '<td>' + esc((s.subjects || []).join('、') || '—') + '</td>' +
        '<td>' + esc((s.teachers || []).join('、') || '—') + '</td>' +
        '<td class="c" style="white-space:nowrap">' +
        '<button data-cact="edit" data-id="' + esc(s.id) + '">修改信息</button> ' +
        '<button data-cact="del" data-id="' + esc(s.id) + '" style="color:#c0392b">从班级删除</button>' +
        '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  /* =========================================================
   * 详情页 Tab② 成绩分析
   * ========================================================= */
  function renderDetailAnalysis(cls) {
    var an = ClassesCore.classScoreAnalysis(cls.id, {
      students: studentsTable().list(),
      members: membersTable().list(),
      records: (App.Store && App.Store.data && App.Store.data.records) || []
    });

    if (!an.kpi.analyzable) {
      return UI.empty('本班还没有学生，请先在『班级学生』中添加');
    }
    if (!an.kpi.matched) {
      return '<div class="empty">本班学生尚未录入成绩（匹配口径：姓名 + 学校）。请先到『成绩管理』录入。</div>';
    }

    var h = '<div class="grid g4" style="margin:10px 0">' +
      UI.kpi('可分析学生数', an.kpi.analyzable + ' 人', '本班全部学生') +
      UI.kpi('涉及考试场次', an.kpi.exams + ' 场', '按考试去重') +
      UI.kpi('匹配到成绩', an.kpi.matched + ' 人', '按姓名 + 学校匹配') +
      UI.kpi('未匹配', an.kpi.unmatched + ' 人', an.kpi.unmatched ? '尚未录入成绩' : '全部匹配') +
      '</div>';

    /* 每场考试一行 */
    h += '<div class="card"><h3>每场考试<span class="h-note">及格率 / 得分率均为本班口径</span></h3>' +
      '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      '<th>考试</th><th class="num">参考人数</th><th class="num">班均总分</th><th class="num">最高</th>' +
      '<th class="num">最低</th><th class="num">及格率</th><th class="num">平均得分率</th>' +
      '</tr></thead><tbody>';
    an.perExam.forEach(function (e) {
      h += '<tr><td><b>' + esc(e.exam) + '</b></td>' +
        '<td class="num">' + e.count + '</td>' +
        '<td class="num"><b>' + U.f1(e.avg) + '</b></td>' +
        '<td class="num">' + (e.max === null ? '—' : U.f1(e.max)) + '</td>' +
        '<td class="num">' + (e.min === null ? '—' : U.f1(e.min)) + '</td>' +
        '<td class="num">' + UI.pctText(e.count ? Math.round(e.passRate / 100 * e.count) : 0, e.count) + '</td>' +
        '<td class="num">' + UI.pctText(e.avgRate, 1) + '</td></tr>';
    });
    h += '</tbody></table></div>' +
      '<div class="hint">满分与及格线按每条成绩实际计入的科目动态计算（如只填 4 科，分母就是这 4 科满分之和），' +
      '不是固定的 750 / 450。</div></div>';

    /* 科目维度（9 科） */
    h += '<div class="card"><h3>科目维度<span class="h-note">班均分 · 得分率 · 及格率</span></h3>' +
      '<div id="cls-chart" style="margin:8px 0"></div>' +
      '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      '<th>科目</th><th class="num">参考人数</th><th class="num">班均分</th><th class="num">满分</th>' +
      '<th class="num">得分率</th><th class="num">及格率</th></tr></thead><tbody>';
    an.perSubject.forEach(function (s) {
      h += '<tr><td>' + esc(s.name) + '</td><td class="num">' + s.count + '</td>' +
        '<td class="num">' + (s.count ? U.f1(s.avg) : '—') + '</td>' +
        '<td class="num muted">' + s.full + '</td>' +
        '<td class="num">' + UI.pctText(s.avgRate, 1) + '</td>' +
        '<td class="num">' + (s.count ? UI.pctText(Math.round(s.passRate / 100 * s.count), s.count) : '—') + '</td></tr>';
    });
    h += '</tbody></table></div></div>';

    /* 学生维度 */
    h += '<div class="card"><h3>学生维度<span class="h-note">最近一次成绩 · 班内排名 · 较上次变化</span></h3>' +
      '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      '<th>姓名</th><th>最近考试</th><th class="num">总分</th><th class="num">得分率</th>' +
      '<th class="num">班内排名</th><th class="num">较上次</th></tr></thead><tbody>';
    an.perStudent.forEach(function (p) {
      var d = p.delta;
      var arrow = (d === null) ? '→' : (d > 0 ? '↑ +' + U.f1(d) : (d < 0 ? '↓ ' + U.f1(d) : '→ 0'));
      h += '<tr><td><b>' + esc(p.student.stu_name) + '</b></td>' +
        '<td>' + esc(p.exam || '—') + '</td>' +
        '<td class="num"><b>' + (p.total || 0) + '</b></td>' +
        '<td class="num">' + UI.pctText(p.rate, 1) + '</td>' +
        '<td class="num">' + (p.rank ? p.rank + (p.rankOf ? ' / ' + p.rankOf : '') : '—') + '</td>' +
        '<td class="num">' + arrow + '</td></tr>';
    });
    h += '</tbody></table></div>';

    if (an.unmatched.length) {
      h += '<div class="hint" style="margin-top:10px">未匹配学生（尚无按「姓名 + 学校」匹配的成绩）：' +
        an.unmatched.map(function (s) { return esc(s.stu_name); }).join('、') + '</div>';
    }
    h += '</div>';
    return h;
  }

  /* =========================================================
   * 详情页外壳
   * ========================================================= */
  function renderDetail(cls) {
    var h = '<div class="toolbar" style="margin-bottom:12px">' +
      '<button id="cd-back">← 返回班级列表</button>' +
      '<div class="spacer"></div>' +
      '<button id="cd-edit">编辑班级</button>' +
      '</div>';

    h += '<div class="card"><h3>' + esc(cls.class_name) +
      (cls.grade ? ' <span class="chip ch-blue">' + esc(cls.grade) + '</span>' : '') +
      (cls.subject ? ' <span class="chip ch-gray">' + esc(cls.subject) + '</span>' : '') +
      '<span class="h-note">' + esc(ClassesCore.scheduleText(cls.schedules)) + '</span></h3>' +
      '<div class="store-line"><span class="k">班级老师</span><b>' + esc((cls.teachers || []).join('、') || '—') + '</b></div>' +
      '<div class="store-line"><span class="k">课室</span><b>' + esc(cls.room || '—') + '</b></div></div>';

    h += '<div class="toolbar" style="margin-bottom:12px">' +
      '<button data-ctab="students"' + (state.tab === 'students' ? ' class="primary"' : '') + '>① 班级学生</button>' +
      '<button data-ctab="analysis"' + (state.tab === 'analysis' ? ' class="primary"' : '') + '>② 成绩分析</button>' +
      '</div>';

    h += state.tab === 'analysis' ? renderDetailAnalysis(cls) : renderDetailStudents(cls);
    return h;
  }

  /* =========================================================
   * 模块注册
   * ========================================================= */
  App.registerModule({
    id: 'classes',
    name: '班级管理',
    icon: ICON,
    ready: true,
    adminOnly: true,
    order: 20,
    title: '班级管理',
    subtitle: '班级卡片 · 上课时间 · 班内学生与成绩分析',
    render: function () {
      if (App.Perm && App.Perm.denied(this)) return App.Perm.forbiddenCard(this);

      var classes = classesTable().list();
      var cls = null;
      if (state.view === 'detail') cls = classesTable().get(state.classId);
      if (!cls) { state.view = 'list'; state.classId = null; }

      return cls ? renderDetail(cls) : renderList(classes, null);
    },

    bind: function (host) {
      /* ---- 列表页 ---- */
      var add = host.querySelector('#cls-add');
      if (add) add.addEventListener('click', function () { openForm(null); });

      Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-id');
          var row = classesTable().get(id);
          if (!row) return;
          var act = b.getAttribute('data-act');
          if (act === 'detail') { state.view = 'detail'; state.classId = id; state.tab = 'students'; state.kw = ''; state.grade = ''; App.render(); }
          else if (act === 'edit') openForm(row);
          else if (act === 'del') removeClass(row);
        });
      });

      /* ---- 详情页 ---- */
      var back = host.querySelector('#cd-back');
      if (back) back.addEventListener('click', function () {
        state.view = 'list'; state.classId = null; state.tab = 'students'; App.render();
      });

      var edit = host.querySelector('#cd-edit');
      if (edit) edit.addEventListener('click', function () {
        var row = classesTable().get(state.classId);
        if (row) openForm(row);
      });

      Array.prototype.forEach.call(host.querySelectorAll('[data-ctab]'), function (b) {
        b.addEventListener('click', function () {
          state.tab = b.getAttribute('data-ctab');
          App.render();
        });
      });

      if (state.view !== 'detail' || !state.classId) return;
      var classId = state.classId;

      /* Tab①：筛选 + 操作 */
      var kwEl = host.querySelector('#cd-kw');
      if (kwEl) {
        U.onCommitted(kwEl, function (v) {
          if (String(v) === state.kw) return;
          state.kw = String(v);
          state.refocus = '#cd-kw';
          App.render();
        });
      }
      var gradeEl = host.querySelector('#cd-grade');
      if (gradeEl) gradeEl.addEventListener('change', function () { state.grade = gradeEl.value; App.render(); });

      var addStu = host.querySelector('#cd-add');
      if (addStu) addStu.addEventListener('click', function () { openAddStudents(classId); });

      Array.prototype.forEach.call(host.querySelectorAll('[data-cact]'), function (b) {
        b.addEventListener('click', function () {
          var sid = b.getAttribute('data-id');
          var stu = studentsTable().get(sid);
          if (!stu) return;
          var act = b.getAttribute('data-cact');
          if (act === 'edit') {
            /* 关键：编辑的是 students 行本身，保存写回学生表 → 学生管理列表同步显示 */
            if (App.Students) {
              App.Students.openForm({ existing: stu, onDone: function () { App.render(); } });
            }
          } else if (act === 'del') {
            removeFromClass(classId, stu);
          }
        });
      });

      /* Tab②：9 科条形图（App.Chart 手写 SVG，无第三方依赖） */
      var chartBox = host.querySelector('#cls-chart');
      if (chartBox && App.Chart && App.Chart.bar) {
        var an = ClassesCore.classScoreAnalysis(classId, {
          students: studentsTable().list(),
          members: membersTable().list(),
          records: (App.Store && App.Store.data && App.Store.data.records) || []
        });
        var has = an.perSubject.some(function (s) { return s.count > 0; });
        if (has) {
          chartBox.appendChild(App.Chart.bar({
            title: '本班 9 科班均分 vs 该科及格线',
            categories: an.perSubject.map(function (s) { return s.name; }),
            series: [
              { name: '班均分', color: '#4472c4', data: an.perSubject.map(function (s) { return s.avg; }) },
              { name: '及格线', color: '#c8892e', data: an.perSubject.map(function (s) { return s.line; }) }
            ],
            height: 300
          }));
        } else {
          chartBox.innerHTML = '<div class="empty">本班暂无单科成绩数据</div>';
        }
      }

      if (state.refocus) {
        var t = host.querySelector(state.refocus);
        state.refocus = '';
        if (t) {
          t.focus();
          try { t.setSelectionRange(t.value.length, t.value.length); } catch (e) { }
        }
      }
    }
  });

  /* 对外：便于后续模块（如学生详情）跳转到班级 */
  App.Classes = {
    openForm: openForm,
    openDetail: function (classId) {
      state.view = 'detail'; state.classId = classId; state.tab = 'students';
      if (App.render) App.render();
    },
    state: state
  };
})(window.App);

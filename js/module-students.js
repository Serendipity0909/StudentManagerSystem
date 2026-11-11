/* =========================================================
 * 学生管理模块（PRD §3.2）
 *
 * 数据：App.DB.table('students') + App.DB.table('class_members')（所属班级只在桥表里）
 * 成绩：只读 App.Store.data.records（**绝不回写、绝不经 App.DB 访问 score_records**）
 *
 * 对外（供 module-classes 复用，两边同属 T3 交付）：
 *   App.StudentsCore = { validate, dupKey, filterRows, kpi, scoreImpact, sortRows }
 *   App.Students     = { openForm, saveStudent, removeStudent, syncMembers,
 *                        classesOfStudent, focusRow, studentFormMeta }
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Toast = App.Toast, Modal = App.Modal, UI = App.UI;

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/>' +
    '<path d="M3.5 19c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2"/>' +
    '<path d="M17 8.5h4M19 6.5v4"/></svg>';

  var state = {
    kw: '', school: '', grade: '', classId: '', subject: '', teacher: '',
    sortKey: 'created_at', sortDesc: true,
    highlightId: null,      // 查重命中：高亮该行
    refocus: ''             // 重绘后恢复焦点的选择器（避免筛选中失焦）
  };

  /* =========================================================
   * 数据读取（全部读 App.DB 缓存，不直接访问云端）
   * ========================================================= */
  function studentsTable() { return App.DB.table('students'); }
  function classesTable() { return App.DB.table('classes'); }
  function membersTable() { return App.DB.table('class_members'); }

  function esc(s) { return U.esc(s); }

  /** { studentId: [classId, ...] } */
  function memberMap() {
    var m = {};
    membersTable().list().forEach(function (row) {
      var k = String(row.student_id);
      (m[k] = m[k] || []).push(String(row.class_id));
    });
    return m;
  }

  /** { classId: classRow } */
  function classIndex() {
    var m = {};
    classesTable().list().forEach(function (c) { m[String(c.id)] = c; });
    return m;
  }

  function classesOfStudent(studentId, mm) {
    var map = mm || memberMap();
    var idx = classIndex();
    return (map[String(studentId)] || []).map(function (cid) { return idx[cid]; }).filter(Boolean);
  }

  function classNameText(studentId, mm) {
    var list = classesOfStudent(studentId, mm);
    if (!list.length) return '—';
    return list.map(function (c) { return c.class_name; }).join('、');
  }

  /** bigint 列：纯数字字符串转数字，避免 PostgREST 类型不匹配 */
  function idValue(v) {
    var s = String(v);
    return /^\d+$/.test(s) ? Number(s) : v;
  }

  /* =========================================================
   * 纯函数（可测，不碰 DOM）
   * ========================================================= */
  var StudentsCore = {
    /** 去首尾空格（全角空格也去掉） */
    trim: function (v) { return String(v === null || v === undefined ? '' : v).replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); },

    /**
     * 表单校验（PRD §3.2 字段表）。
     * @returns {string} '' = 通过；否则为第一条错误文案
     */
    validate: function (form) {
      var f = form || {};
      var name = StudentsCore.trim(f.stu_name);
      if (!name) return '姓名不能为空';
      if (name.length > 20) return '姓名不能超过 20 个字';

      var school = StudentsCore.trim(f.school);
      if (!school) return '学校不能为空';
      if (school.length > 40) return '学校不能超过 40 个字';

      if (!f.grade || UI.GRADES.indexOf(f.grade) < 0) return '请选择年级';

      var phone = StudentsCore.trim(f.phone);
      if (!phone) return '联系方式不能为空';
      if (!UI.isPhone(phone)) {
        return '联系方式格式不正确：7–20 位数字或连字符，11 位手机号须以 1 开头';
      }

      if (!(f.subjects && f.subjects.length)) return '上课科目至少选择 1 项';
      if (!(f.teachers && f.teachers.length)) return '上课老师至少选择 1 位';
      return '';
    },

    /** 业务唯一键（与 uk_students_key 一致） */
    dupKey: function (form) {
      var f = form || {};
      return {
        stu_name: StudentsCore.trim(f.stu_name),
        school: StudentsCore.trim(f.school),
        grade: String(f.grade || '')
      };
    },

    /**
     * 筛选：关键字（姓名）+ 学校 + 年级 + 班级（走桥表）+ 上课科目 + 上课老师。
     * @param {Array} rows 全量学生
     * @param {{kw,school,grade,classId,subject,teacher}} filters
     * @param {Object} mm memberMap
     */
    filterRows: function (rows, filters, mm) {
      var f = filters || {};
      var map = mm || {};
      var kw = StudentsCore.trim(f.kw);
      return (rows || []).filter(function (r) {
        if (kw && String(r.stu_name || '').indexOf(kw) < 0) return false;
        if (f.school && String(r.school || '') !== String(f.school)) return false;
        if (f.grade && String(r.grade || '') !== String(f.grade)) return false;
        if (f.classId && (map[String(r.id)] || []).indexOf(String(f.classId)) < 0) return false;
        if (f.subject && (r.subjects || []).indexOf(f.subject) < 0) return false;
        if (f.teacher && (r.teachers || []).indexOf(f.teacher) < 0) return false;
        return true;
      });
    },

    /** KPI：总数 / 覆盖学校数 / 覆盖班级数 / 本月新增（created_at ∈ 当月） */
    kpi: function (rows, mm, now) {
      var list = rows || [];
      var map = mm || {};
      var schools = {}, classIds = {}, monthNew = 0;
      var base = now ? new Date(now) : new Date();
      var y = base.getFullYear(), mo = base.getMonth();
      list.forEach(function (r) {
        if (r.school) schools[String(r.school)] = 1;
        (map[String(r.id)] || []).forEach(function (cid) { classIds[String(cid)] = 1; });
        var d = r.created_at ? new Date(r.created_at) : null;
        if (d && !isNaN(d.getTime()) && d.getFullYear() === y && d.getMonth() === mo) monthNew++;
      });
      return {
        total: list.length,
        schools: Object.keys(schools).length,
        classes: Object.keys(classIds).length,
        monthNew: monthNew
      };
    },

    /**
     * 改姓名/学校对成绩关联的影响条数（只读 Store.data.records，绝不改写）。
     * 口径：成绩记录按「姓名 + 学校」与学生对上（ARCH §4.5 弱关联）。
     */
    scoreImpact: function (records, oldName, oldSchool) {
      var list = records || [];
      var n = String(oldName === null || oldName === undefined ? '' : oldName);
      var s = String(oldSchool === null || oldSchool === undefined ? '' : oldSchool);
      return list.filter(function (r) {
        return String(r.name || '') === n && String(r.school || '') === s;
      }).length;
    },

    /** 排序（姓名/学校/年级 文本；created_at 时间） */
    sortRows: function (rows, sortKey, sortDesc) {
      var key = sortKey || 'created_at';
      var kind = (key === 'created_at') ? 'date' : 'text';
      return (rows || []).slice().sort(UI.comparator(key, !!sortDesc, kind));
    }
  };
  App.StudentsCore = StudentsCore;

  /* =========================================================
   * 表单
   * ========================================================= */
  function teacherPool(rows) {
    var set = {};
    (rows || []).forEach(function (r) {
      (r.teachers || []).forEach(function (t) { set[String(t)] = 1; });
    });
    return Object.keys(set).sort(U.zh);
  }

  function schoolPool(rows) {
    var set = {};
    (rows || []).forEach(function (r) { if (r.school) set[String(r.school)] = 1; });
    return Object.keys(set).sort(U.zh);
  }

  /**
   * 学生表单弹窗。
   * opts = { existing: 学生行 | null, presetClassId: 默认勾选班级, onDone: fn(row) }
   */
  function openForm(opts) {
    var o = opts || {};
    if (App.Perm && !App.Perm.assertWrite('students')) return null;
    var existing = o.existing || null;
    var all = studentsTable().list();
    var cls = classesTable().list();

    var body = document.createElement('div');
    var specs = [
      { name: 'stu_name', label: '姓名', value: existing ? existing.stu_name : '', placeholder: '1–20 字' },
      { name: 'school', label: '学校', value: existing ? existing.school : '', placeholder: '1–40 字' },
      { name: 'grade', label: '年级', type: 'select', options: UI.GRADES, value: existing ? existing.grade : '', blank: '请选择年级' },
      { name: 'phone', label: '联系方式', type: 'phone', value: existing ? existing.phone : '', placeholder: '手机或座机，如 13800138000 / 0755-12345678' }
    ];
    if (existing) {
      specs.push({
        name: 'created_at', label: '系统录入时间（只读）', value: U.hms(existing.created_at), readonly: true,
        hint: '创建时写入，永不变更'
      });
    }

    var preset = (o.presetClassId === null || o.presetClassId === undefined) ? null : String(o.presetClassId);
    var currentClassIds = existing
      ? (memberMap()[String(existing.id)] || [])
      : (preset ? [preset] : []);

    body.innerHTML = '<div data-form-err></div>' + UI.formGrid(specs) +
      '<div class="form-grid">' +
      '<label class="f">上课科目 *<span data-mount="subjects"></span>' +
      '<span class="muted" style="font-size:12px">9 科 + 其他，可手填后回车</span></label>' +
      '<label class="f">上课老师 *<span data-mount="teachers"></span>' +
      '<span class="muted" style="font-size:12px">从已有老师里选，也可直接手填姓名</span></label>' +
      '<label class="f">所属班级<span data-mount="classes"></span>' +
      '<span class="muted" style="font-size:12px">可多选，未建班级时可留空</span></label>' +
      '</div>';

    var msSubjects = UI.multiSelect({ options: UI.SUBJECTS, value: existing ? (existing.subjects || []) : [], allowCustom: true, placeholder: '选择或手填科目' });
    var msTeachers = UI.multiSelect({ options: teacherPool(all), value: existing ? (existing.teachers || []) : [], allowCustom: true, placeholder: '选择或手填老师' });

    /* 班级下拉用「班级名称」做选项值（class_name 全局唯一），保存时再映射回 class_id，
       避免界面上出现一串 bigint 主键看不懂。 */
    var idToName = {}, nameToId = {};
    cls.forEach(function (c) {
      idToName[String(c.id)] = c.class_name;
      nameToId[c.class_name] = String(c.id);
    });
    var msClasses = UI.multiSelect({
      options: cls.map(function (c) { return c.class_name; }),
      value: currentClassIds.map(function (id) { return idToName[String(id)]; }).filter(Boolean),
      allowCustom: false,
      placeholder: '选择班级'
    });

    body.querySelector('[data-mount="subjects"]').appendChild(msSubjects.el);
    body.querySelector('[data-mount="teachers"]').appendChild(msTeachers.el);
    body.querySelector('[data-mount="classes"]').appendChild(msClasses.el);

    var classHint = document.createElement('div');
    classHint.className = 'muted';
    classHint.style.cssText = 'font-size:12px;margin-top:4px';
    function refreshClassHint() {
      var names = msClasses.getValue();
      classHint.textContent = names.length
        ? '已选：' + names.join('、')
        : (cls.length ? '未选择班级' : '还没有班级，请先到「班级管理」创建');
    }
    msClasses.el.parentNode.insertBefore(classHint, msClasses.el.nextSibling);
    msClasses.el.addEventListener('click', refreshClassHint);
    msClasses.el.addEventListener('keyup', refreshClassHint);
    refreshClassHint();

    /** 选中的班级名称 → class_id 列表 */
    function pickedClassIds() {
      return msClasses.getValue().map(function (nm) { return nameToId[nm] || nm; });
    }

    function val(name) {
      var el = body.querySelector('[name="' + name + '"]');
      return el ? String(el.value || '') : '';
    }

    var formMask = null;

    function doSave(form, classIds) {
      saveStudent(form, classIds, existing, o.onDone);
    }

    formMask = UI.formModal({
      title: existing ? '编辑学生' : '新增学生',
      body: body,
      okText: existing ? '保存修改' : '保存',
      onSubmit: function () {
        UI.clearError(body);
        var form = {
          stu_name: val('stu_name'),
          school: val('school'),
          grade: val('grade'),
          phone: val('phone'),
          subjects: msSubjects.getValue(),
          teachers: msTeachers.getValue()
        };
        var err = StudentsCore.validate(form);
        if (err) { UI.fail(body, err); return false; }

        var key = StudentsCore.dupKey(form);
        var hit = studentsTable().findBy(key);
        if (hit && (!existing || String(hit.id) !== String(existing.id))) {
          /* 查重命中：阻止新增，并让已存在的行可见（清筛选 + 高亮 + 滚动） */
          focusRow(hit.id);
          UI.fail(body, '已存在同名同校同年级学生，请前往该档案修改');
          return false;
        }

        var classIds = pickedClassIds();
        var changedKey = !!existing &&
          (StudentsCore.trim(existing.stu_name) !== key.stu_name ||
            StudentsCore.trim(existing.school) !== key.school);
        var impact = changedKey
          ? StudentsCore.scoreImpact(App.Store.data.records || [], existing.stu_name, existing.school)
          : 0;

        if (impact > 0) {
          Modal.confirm(
            '本次修改后，之前按『' + esc(existing.stu_name) + ' + ' + esc(existing.school) + '』匹配的 ' +
            '<b>' + impact + '</b> 条成绩记录将不再关联到该学生，班级成绩分析可能无法匹配。是否继续？<br>' +
            '<span class="muted">成绩数据本身不会被修改或删除。</span>',
            function () {
              doSave(form, classIds);
              if (formMask) formMask.remove();
            });
          return false;      // 保持表单打开，等确认框结果
        }

        doSave(form, classIds);
        return true;
      }
    });
    return formMask;
  }

  /**
   * 保存学生 + 同步班级归属（桥表双写）。
   * @param {Object} form {stu_name, school, grade, phone, subjects, teachers}
   * @param {Array} classIds 目标班级 id 列表
   * @param {Object|null} existing 编辑时传入原行
   */
  function saveStudent(form, classIds, existing, onDone) {
    var payload = {
      stu_name: StudentsCore.trim(form.stu_name),
      school: StudentsCore.trim(form.school),
      grade: form.grade,
      phone: StudentsCore.trim(form.phone),
      subjects: form.subjects,          // jsonb 数组
      teachers: form.teachers
    };
    var p = existing ? studentsTable().update(existing.id, payload) : studentsTable().insert(payload);
    return p.then(function (row) {
      return syncMembers(row.id, classIds).then(function () { return row; });
    }).then(function (row) {
      Toast(existing ? '已保存「' + row.stu_name + '」的档案' : '已新增学生「' + row.stu_name + '」', 'ok');
      if (onDone) onDone(row);
      App.render();
      return row;
    }).catch(function (e) {
      Toast(e && e.message ? e.message : '保存失败，请重试', 'error', 6000);
      throw e;
    });
  }

  /**
   * 同步某学生的班级归属：目标有、桥表无 → insert；桥表有、目标无 → remove。
   * 只动 class_members，不触碰别的东西。
   */
  function syncMembers(studentId, classIds) {
    var want = (classIds || []).map(String);
    var cur = membersTable().list().filter(function (m) { return String(m.student_id) === String(studentId); });
    var keep = {};
    var chain = Promise.resolve();

    cur.forEach(function (m) {
      var cid = String(m.class_id);
      if (want.indexOf(cid) >= 0) { keep[cid] = true; return; }
      chain = chain.then(function () {
        return membersTable().remove(m.id).catch(function (e) {
          Toast('移除班级归属失败：' + (e && e.message ? e.message : e), 'error', 5000);
        });
      });
    });

    want.forEach(function (cid) {
      if (keep[cid]) return;
      chain = chain.then(function () {
        return membersTable().insert({
          class_id: idValue(cid),
          student_id: idValue(studentId),
          created_by: (App.Sync && App.Sync.me && App.Sync.me()) || ''
        }).catch(function (e) {
          Toast('加入班级失败：' + (e && e.message ? e.message : e), 'error', 5000);
        });
      });
    });

    return chain;
  }

  /** 删除学生：先清桥表（班级归属），再删学生行；成绩数据一个字都不动 */
  function removeStudent(row, onDone) {
    if (App.Perm && !App.Perm.assertWrite('students')) return;
    var mm = memberMap();
    var cls = classesOfStudent(row.id, mm);
    Modal.confirm(
      '确定删除学生 <b>' + esc(row.stu_name) + '</b>（' + esc(row.school) + ' / ' + esc(row.grade) + '）吗？<br>' +
      '将从 <b>' + cls.length + '</b> 个班级中移除该学生；<b>成绩数据不受影响、不会被删除</b>。<br>' +
      '<span class="muted">此操作不可撤销。学生档案删除后，成绩仍按「姓名 + 学校」保留在成绩管理中。</span>',
      function () {
        /* 桥表清理失败不能吞掉（S-4）：以前 .catch(function () {}) 之后照样删主行、
           照样 toast「已删除」，用户以为学生已经从班级里摘掉了，实际桥表还留着
           指向已删学生的行 —— 班级人数虚高，且只能等下一轮孤儿清理兜底。
           现在统计失败条数，主行仍然删（它才是用户要删的目标），但提示改成警告。 */
        var failed = 0;
        var chain = Promise.resolve();
        membersTable().list().filter(function (m) { return String(m.student_id) === String(row.id); })
          .forEach(function (m) {
            chain = chain.then(function () {
              return membersTable().remove(m.id).catch(function () { failed++; });
            });
          });
        chain.then(function () { return studentsTable().remove(row.id); })
          .then(function () {
            if (failed > 0) {
              Toast('学生已删除，但有 ' + failed + ' 个班级归属清理失败，请在班级管理中检查', 'error', 8000);
            } else {
              Toast('已删除学生「' + row.stu_name + '」（成绩数据保留）', 'ok');
            }
            if (onDone) onDone();
            App.render();
          })
          .catch(function (e) {
            Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 6000);
          });
      }, true);
  }

  /** 查重命中：清空筛选 + 高亮该行（下次渲染时滚动到可视区） */
  function focusRow(id) {
    state.kw = ''; state.school = ''; state.grade = ''; state.classId = ''; state.subject = ''; state.teacher = '';
    state.highlightId = String(id);
    if (App.render) App.render();
  }

  /* =========================================================
   * 详情弹窗
   * ========================================================= */
  function openDetail(row) {
    var mm = memberMap();
    var cls = classesOfStudent(row.id, mm);
    var el = document.createElement('div');
    el.innerHTML =
      '<div class="store-line"><span class="k">姓名</span><b>' + esc(row.stu_name) + '</b></div>' +
      '<div class="store-line"><span class="k">学校</span><b>' + esc(row.school) + '</b></div>' +
      '<div class="store-line"><span class="k">年级</span><b>' + esc(row.grade) + '</b></div>' +
      '<div class="store-line"><span class="k">联系方式</span><b>' + esc(row.phone || '—') + '</b></div>' +
      '<div class="store-line"><span class="k">上课科目</span><b>' + esc((row.subjects || []).join('、') || '—') + '</b></div>' +
      '<div class="store-line"><span class="k">上课老师</span><b>' + esc((row.teachers || []).join('、') || '—') + '</b></div>' +
      '<div class="store-line"><span class="k">所属班级</span><b>' +
      (cls.length ? cls.map(function (c) { return '<span class="chip ch-blue">' + esc(c.class_name) + '</span>'; }).join(' ') : '—') +
      '</b></div>' +
      '<div class="store-line"><span class="k">系统录入时间</span><b>' + esc(U.hms(row.created_at)) + '</b></div>' +
      '<div class="store-line"><span class="k">最后修改人</span><b>' + esc(row.last_editor || '—') + '</b></div>' +
      '<div class="store-line"><span class="k">更新时间</span><b>' + esc(U.hms(row.updated_at)) + '</b></div>';
    Modal.open({ title: '学生详情', body: el, okText: '关闭', cancelText: '关闭' });
  }

  /* =========================================================
   * 列表页
   * ========================================================= */
  function selectHTML(id, opts, cur, blank) {
    return '<select id="' + id + '">' + '<option value="">' + esc(blank) + '</option>' +
      UI.optionsWithLabel(opts, cur) + '</select>';
  }

  function renderToolbar(rows, cls) {
    var schools = schoolPool(rows).map(function (s) { return { value: s, label: s }; });
    var classes = cls.map(function (c) { return { value: String(c.id), label: c.class_name }; });
    var subjects = UI.SUBJECTS.map(function (s) { return { value: s, label: s }; });
    var teachers = teacherPool(rows).map(function (t) { return { value: t, label: t }; });
    var h = '<div class="toolbar" style="flex-wrap:wrap;gap:8px">' +
      '<input id="st-kw" placeholder="姓名关键字" value="' + esc(state.kw) + '" style="max-width:180px">' +
      selectHTML('st-school', schools, state.school, '全部学校') +
      selectHTML('st-grade', UI.GRADES, state.grade, '全部年级') +
      selectHTML('st-class', classes, state.classId, '全部班级') +
      selectHTML('st-subject', subjects, state.subject, '全部科目') +
      selectHTML('st-teacher', teachers, state.teacher, '全部老师') +
      '<button id="st-clear">清空筛选</button>' +
      '<div class="spacer"></div>' +
      '<button class="primary" id="st-add">新增学生</button>' +
      '</div>';
    return h;
  }

  function renderTable(rows, mm) {
    var cols = [
      { key: 'stu_name', label: '姓名' },
      { key: 'school', label: '学校' },
      { key: 'grade', label: '年级' },
      { label: '联系方式' },
      { label: '上课科目' },
      { label: '上课老师' },
      { label: '所属班级' },
      { key: 'created_at', label: '录入时间' },
      { label: '操作', cls: 'c' }
    ];
    var h = '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      UI.sortHeader(cols, state.sortKey, state.sortDesc) + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var hl = state.highlightId && String(state.highlightId) === String(r.id);
      h += '<tr data-row="' + esc(r.id) + '"' + (hl ? ' style="background:#fdf8ee"' : '') + '>' +
        '<td><b>' + esc(r.stu_name) + '</b></td>' +
        '<td>' + esc(r.school) + '</td>' +
        '<td>' + esc(r.grade) + '</td>' +
        '<td class="muted">' + esc(r.phone || '—') + '</td>' +
        '<td>' + esc((r.subjects || []).join('、') || '—') + '</td>' +
        '<td>' + esc((r.teachers || []).join('、') || '—') + '</td>' +
        '<td>' + esc(classNameText(r.id, mm)) + '</td>' +
        '<td class="muted">' + esc(U.hms(r.created_at)) + '</td>' +
        '<td class="c" style="white-space:nowrap">' +
        '<button data-act="detail" data-id="' + esc(r.id) + '">详情</button> ' +
        '<button data-act="edit" data-id="' + esc(r.id) + '">编辑</button> ' +
        '<button data-act="del" data-id="' + esc(r.id) + '" style="color:#c0392b">删除</button>' +
        '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  App.registerModule({
    id: 'students',
    name: '学生管理',
    icon: ICON,
    ready: true,
    adminOnly: true,
    order: 10,
    title: '学生管理',
    subtitle: '学生档案 · 上课科目与老师 · 所属班级（多班归属）',
    render: function () {
      if (App.Perm && App.Perm.denied(this)) return App.Perm.forbiddenCard(this);

      var all = studentsTable().list();
      var mm = memberMap();
      var cls = classesTable().list();
      var k = StudentsCore.kpi(all, mm, new Date());

      var h = '<div class="grid g4">' +
        UI.kpi('学生总数', k.total + ' 人', '全部学生档案') +
        UI.kpi('覆盖学校数', k.schools + ' 所', '按学校去重') +
        UI.kpi('覆盖班级数', k.classes + ' 个', '按班级去重') +
        UI.kpi('本月新增', k.monthNew + ' 人', '按系统录入时间统计') +
        '</div>';

      h += '<div class="card"><h3>学生档案<span class="h-note">成绩数据请在「成绩管理」维护，此处只读不写</span></h3>';
      h += renderToolbar(all, cls);

      var filtered = StudentsCore.filterRows(all, state, mm);
      var sorted = StudentsCore.sortRows(filtered, state.sortKey, state.sortDesc);

      if (!all.length) {
        h += UI.empty('还没有学生档案。点右上『新增学生』开始，或从班级管理里添加学生。');
      } else if (!sorted.length) {
        h += '<div class="empty">没有符合条件的学生<br><button id="st-clear-2" style="margin-top:10px">清空筛选</button></div>';
      } else {
        h += '<div class="muted" style="margin:8px 0 6px">共 ' + sorted.length + ' 条' +
          (sorted.length !== all.length ? '（已筛选，全量 ' + all.length + ' 条）' : '') + '</div>';
        h += renderTable(sorted, mm);
      }
      h += '</div>';
      return h;
    },

    bind: function (host) {
      var mm = memberMap();

      /* 筛选：下拉即时生效；关键字走输入法安全触发（组合期不触发） */
      var kwEl = host.querySelector('#st-kw');
      if (kwEl) {
        U.onCommitted(kwEl, function (v) {
          if (String(v) === state.kw) return;
          state.kw = String(v);
          state.refocus = '#st-kw';
          App.render();
        });
      }
      [['#st-school', 'school'], ['#st-grade', 'grade'], ['#st-class', 'classId'],
        ['#st-subject', 'subject'], ['#st-teacher', 'teacher']].forEach(function (pair) {
          var el = host.querySelector(pair[0]);
          if (!el) return;
          el.addEventListener('change', function () {
            state[pair[1]] = el.value;
            state.highlightId = null;
            App.render();
          });
        });
      function clearFilters() {
        state.kw = ''; state.school = ''; state.grade = ''; state.classId = '';
        state.subject = ''; state.teacher = ''; state.highlightId = null;
        App.render();
      }
      var c1 = host.querySelector('#st-clear');
      if (c1) c1.addEventListener('click', clearFilters);
      var c2 = host.querySelector('#st-clear-2');
      if (c2) c2.addEventListener('click', clearFilters);

      var add = host.querySelector('#st-add');
      if (add) add.addEventListener('click', function () { openForm({ existing: null }); });

      UI.bindSort(host, state, function () {
        state.highlightId = null;
        App.render();
      });

      Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-id');
          var row = studentsTable().get(id);
          if (!row) return;
          var act = b.getAttribute('data-act');
          if (act === 'detail') openDetail(row);
          else if (act === 'edit') openForm({ existing: row });
          else if (act === 'del') removeStudent(row);
        });
      });

      /* 查重命中行：滚动到可视区 */
      if (state.highlightId) {
        var tr = host.querySelector('[data-row="' + state.highlightId + '"]');
        if (tr && tr.scrollIntoView) { try { tr.scrollIntoView({ block: 'center' }); } catch (e) { } }
      }

      /* 筛选后恢复焦点（整页重绘会丢焦点） */
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

  /* 对外：班级管理模块复用（同一份 students / class_members 数据，不另存副本） */
  App.Students = {
    openForm: openForm,
    openDetail: openDetail,
    saveStudent: saveStudent,
    removeStudent: removeStudent,
    syncMembers: syncMembers,
    memberMap: memberMap,
    classIndex: classIndex,
    classesOfStudent: classesOfStudent,
    classNameText: classNameText,
    idValue: idValue,
    teacherPool: teacherPool,
    focusRow: focusRow,
    state: state
  };
})(window.App);

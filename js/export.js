/* =========================================================
 * export.js —— 导出：CSV / XLSX / JSON 备份
 * 文件在浏览器内直接生成，不经过网络。
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U;

  /* ---------------- CSV ---------------- */
  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = (c === null || c === undefined) ? '' : String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }

  function downloadCSV(filename, rows) {
    var blob = new Blob(['\ufeff' + toCSV(rows)], { type: 'text/csv;charset=utf-8' });
    U.download(filename, blob);
  }

  /* ---------------- XLSX（手写最小 ZIP + OOXML） ---------------- */
  /* --- XLSX_BEGIN --- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, k, i;
    for (i = 0; i < 256; i++) {
      c = i;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** files: [{name, data:Uint8Array}]，全部用 STORE（不压缩）方式打包 */
  function zipStore(files) {
    var chunks = [], central = [], offset = 0, i;
    for (i = 0; i < files.length; i++) {
      var nameBytes = new TextEncoder().encode(files[i].name);
      var data = files[i].data;
      var crc = crc32(data), size = data.length;

      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);   // UTF-8 文件名
      dv.setUint16(8, 0, true);        // stored
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      chunks.push(lh, data);

      var ch = new Uint8Array(46 + nameBytes.length);
      var dv2 = new DataView(ch.buffer);
      dv2.setUint32(0, 0x02014b50, true);
      dv2.setUint16(4, 20, true);
      dv2.setUint16(6, 20, true);
      dv2.setUint16(8, 0x0800, true);
      dv2.setUint16(10, 0, true);
      dv2.setUint16(12, 0, true);
      dv2.setUint16(14, 0x21, true);
      dv2.setUint32(16, crc, true);
      dv2.setUint32(20, size, true);
      dv2.setUint32(24, size, true);
      dv2.setUint16(28, nameBytes.length, true);
      dv2.setUint16(30, 0, true);
      dv2.setUint16(32, 0, true);
      dv2.setUint16(34, 0, true);
      dv2.setUint16(36, 0, true);
      dv2.setUint32(38, 0, true);
      dv2.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + size;
    }
    var cdSize = 0;
    for (i = 0; i < central.length; i++) cdSize += central[i].length;

    var eocd = new Uint8Array(22);
    var dv3 = new DataView(eocd.buffer);
    dv3.setUint32(0, 0x06054b50, true);
    dv3.setUint16(4, 0, true);
    dv3.setUint16(6, 0, true);
    dv3.setUint16(8, files.length, true);
    dv3.setUint16(10, files.length, true);
    dv3.setUint32(12, cdSize, true);
    dv3.setUint32(16, offset, true);
    dv3.setUint16(20, 0, true);

    var all = chunks.concat(central, [eocd]);
    return new Blob(all, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function escXml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colLetter(n) {           // 1 -> A
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /** sheet: {name, rows:[[cell,...]]}，单元格可为字符串或数字 */
  function buildXLSX(sheets) {
    var enc = new TextEncoder();
    var pack = function (name, xml) { return { name: name, data: enc.encode(xml) }; };

    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    for (var i = 0; i < sheets.length; i++) {
      ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    ct += '</Types>';

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    var wbrel = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    var files = [pack('[Content_Types].xml', ct), pack('_rels/.rels', rels)];

    sheets.forEach(function (sh, idx) {
      var id = idx + 1;
      wb += '<sheet name="' + escXml(sh.name) + '" sheetId="' + id + '" r:id="rId' + id + '"/>';
      wbrel += '<Relationship Id="rId' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + id + '.xml"/>';

      var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
      sh.rows.forEach(function (row, ri) {
        var r = ri + 1;
        xml += '<row r="' + r + '">';
        row.forEach(function (cell, ci) {
          if (cell === null || cell === undefined || cell === '') return;
          var ref = colLetter(ci + 1) + r;
          var sAttr = ri === 0 ? ' s="1"' : '';
          if (typeof cell === 'number' && isFinite(cell)) {
            xml += '<c r="' + ref + '"' + sAttr + '><v>' + cell + '</v></c>';
          } else {
            xml += '<c r="' + ref + '" t="inlineStr"' + sAttr + '><is><t xml:space="preserve">' +
              escXml(cell) + '</t></is></c>';
          }
        });
        xml += '</row>';
      });
      xml += '</sheetData></worksheet>';
      files.push(pack('xl/worksheets/sheet' + id + '.xml', xml));
    });

    wb += '</sheets></workbook>';
    wbrel += '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    files.push(pack('xl/workbook.xml', wb));
    files.push(pack('xl/_rels/workbook.xml.rels', wbrel));
    files.push(pack('xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">' +
      '<alignment horizontal="center"/></xf></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    ));

    return zipStore(files);
  }
  /* --- XLSX_END --- */

  function downloadXLSX(filename, sheets) {
    U.download(filename, buildXLSX(sheets));
  }

  /* ---------------- JSON 备份 / 导入 ----------------
   * 纯云端模式下本机不留数据副本：
   *   备份导出 = 用当前内存数据生成一份 JSON 快照下载（不写本机、不回写状态）
   *   恢复导入 = 解析后按唯一键合并进内存，再由同步层批量 upsert 到云端
   */
  function backupJSON() {
    var out = {
      version: App.Store.data.version || 1,
      createdAt: App.Store.data.createdAt || new Date().toISOString(),
      exportedAt: new Date().toISOString(),
      records: App.Store.data.records,
      modules: App.Store.data.modules || {}
    };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    U.download('学生管理系统备份_' + U.nowStr().replace(/[-: ]/g, '') + '.json', blob);
    return out.records.length;
  }

  /** 把一条外部记录规范化成系统内部的记录结构 */
  function normalizeRecord(r) {
    var s = [], rk = [], i;
    for (i = 0; i < App.K.NUM_SUBJECTS; i++) {
      s.push(Number((r.scores || [])[i]) || 0);
      rk.push(Number((r.ranks || [])[i]) || 0);
    }
    return {
      id: r.id || App.U.uid(),
      name: String(r.name || ''),
      school: String(r.school || ''),
      cls: String(r.cls || ''),
      exam: String(r.exam || ''),
      scores: s, ranks: rk,
      totalRank: Number(r.totalRank) || 0,
      ts: r.ts || new Date().toISOString(),
      mod: new Date().toISOString()
    };
  }

  /**
   * 导入备份：按「姓名+学校+班级+考试」唯一键合并进内存，
   * 之后由 Store.save() 触发同步层批量 upsert 到云端（复用写穿逻辑）。
   * 返回导入条数。
   */
  function restoreJSON(text) {
    var obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.records)) {
      throw new Error('文件格式不正确：未找到成绩记录数组');
    }
    var cur = App.Store.data.records, n = 0, i, j, key, hit;
    for (i = 0; i < obj.records.length; i++) {
      var rec = normalizeRecord(obj.records[i]);
      key = App.Score.key(rec);
      hit = null;
      for (j = 0; j < cur.length; j++) {
        if (App.Score.key(cur[j]) === key) { hit = cur[j]; break; }
      }
      if (hit) {
        // 同键覆盖：保留原有 id 与录入时间，避免打乱考试顺序
        rec.id = hit.id;
        rec.ts = hit.ts;
        // 继承云端主键：否则这条会被当成新建记录去 insert，撞唯一索引
        if (hit._cid) rec._cid = hit._cid;
        cur[j] = rec;
      } else {
        cur.push(rec);
      }
      n++;
    }
    App.Store.save();      // 触发写穿，批量写入云端
    return n;
  }

  App.X = {
    csv: toCSV, downloadCSV: downloadCSV,
    xlsx: buildXLSX, downloadXLSX: downloadXLSX,
    backupJSON: backupJSON, restoreJSON: restoreJSON
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildXLSX: buildXLSX, crc32: crc32, zipStore: zipStore };
  }
})(typeof window !== 'undefined' && window.App ? window.App : { U: {}, Store: {} });

# -*- coding: utf-8 -*-
"""院校定位器数据生成工具。

用途：把《26号查询定位器.xlsx》里的「阈值表」「大学名单」两张表导出成
      js/data-locator.js，供前端「院校定位」功能直接使用。

用法（两种输入都支持）：
    python3 tools/gen-locator.py <xlsx路径>      # 直接从 Excel 读取（推荐，更新表格后重跑一次即可）
    python3 tools/gen-locator.py <json路径>      # 读取中间 JSON（结构同 js 里的 App.Locator）
    python3 tools/gen-locator.py <xlsx路径> -o <输出js路径>

输出：默认是脚本同级目录下的 ../js/data-locator.js。

Excel 约定（表头按名称模糊匹配，列顺序变了也没关系）：
    阈值表   ：届别 / 学校 / 科类 / 键 / 985上限 / 双一流上限 / 特控上限 / 二本A上限 / 二本B上限
    大学名单 ：层次 / 代表院校（多所院校用「、」分隔）
"""
import json
import os
import re
import sys

# 阈值表：中文表头 -> 输出字段名（顺序即档次从高到低）
THRESHOLD_FIELDS = [
    ('985上限', 't985'),
    ('双一流上限', 't211'),
    ('特控上限', 'ttk'),
    ('二本A上限', 'ta'),
    ('二本B上限', 'tb'),
]
DIM_FIELDS = [('届别', 'grade'), ('学校', 'school'), ('科类', 'track')]

# 大学名单：Excel 里的层次名（与阈值表列名对应，顺序从高到低）
UNIV_TIERS = ['985层次', '双一流层次', '重点本科', '二本A', '二本B']

SPLIT_RE = re.compile(r'[、，,；;\n\r/]+')


def to_int(v):
    """把单元格内容转成整数上限；空 / 非数字 / 负数一律记 0（0 表示「该档没有划线」）。"""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        n = int(v)
        return n if n > 0 else 0
    s = str(v).strip().replace(',', '')
    if not s:
        return 0
    try:
        n = int(float(s))
    except ValueError:
        return 0
    return n if n > 0 else 0


def to_str(v):
    """单元格内容转字符串并去掉空白（含全角空格）。"""
    if v is None:
        return ''
    return str(v).replace('\u3000', ' ').strip()


def find_col(header, keywords):
    """按关键字模糊定位列号（0 基），找不到返回 -1。"""
    for i, name in enumerate(header):
        nm = to_str(name)
        if not nm:
            continue
        for kw in keywords:
            if kw in nm:
                return i
    return -1


def pick(row, idx):
    """按下标取值，越界返回空串。"""
    if idx < 0 or idx >= len(row):
        return ''
    return row[idx]


def read_xlsx(path):
    """读取 Excel，返回 (thresholds, universities)。"""
    try:
        import openpyxl
    except ImportError:
        sys.exit('缺少依赖 openpyxl，请先执行：pip3 install openpyxl')

    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    if '阈值表' not in wb.sheetnames:
        sys.exit('Excel 里找不到「阈值表」工作表，实际工作表：%s' % wb.sheetnames)

    # ---------- 阈值表 ----------
    ws = wb['阈值表']
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    if not rows:
        sys.exit('「阈值表」是空的')
    header = [to_str(x) for x in rows[0]]
    c_grade = find_col(header, ['届别', '年级', '届'])
    c_school = find_col(header, ['学校'])
    c_track = find_col(header, ['科类'])
    c_key = find_col(header, ['键'])
    c_vals = [(find_col(header, [zh]), field) for zh, field in THRESHOLD_FIELDS]

    thresholds = []
    for row in rows[1:]:
        grade, school, track = to_str(pick(row, c_grade)), to_str(pick(row, c_school)), to_str(pick(row, c_track))
        if not grade or not school or not track:
            continue                      # 空行 / 残缺行直接跳过
        item = {'grade': grade, 'school': school, 'track': track}
        for col, field in c_vals:
            item[field] = to_int(pick(row, col))
        item['key'] = to_str(pick(row, c_key)) or (grade + school + track)
        thresholds.append(item)

    # ---------- 大学名单 ----------
    universities = []
    if '大学名单' in wb.sheetnames:
        ws2 = wb['大学名单']
        rows2 = [list(r) for r in ws2.iter_rows(values_only=True)]
        if rows2:
            h2 = [to_str(x) for x in rows2[0]]
            c_tier = find_col(h2, ['层次'])
            c_schools = -1
            for i, nm in enumerate(h2):
                if i != c_tier and nm:
                    c_schools = i
                    break
            if c_tier >= 0 and c_schools >= 0:
                for row in rows2[1:]:
                    tier = to_str(pick(row, c_tier))
                    raw = to_str(pick(row, c_schools))
                    if not tier or not raw:
                        continue
                    names = [x.strip() for x in SPLIT_RE.split(raw)]
                    names = [x for x in names if x]
                    universities.append({'tier': tier, 'schools': names})
        # 输出顺序固定按档次从高到低，避免表格行序变化影响前端
        order = {t: i for i, t in enumerate(UNIV_TIERS)}
        universities.sort(key=lambda u: order.get(u['tier'], len(UNIV_TIERS)))

    wb.close()
    return thresholds, universities


def read_json(path):
    """读取中间 JSON，返回 (thresholds, universities)。"""
    obj = json.load(open(path, encoding='utf-8'))
    thresholds = []
    for t in obj.get('thresholds') or []:
        grade, school, track = to_str(t.get('grade')), to_str(t.get('school')), to_str(t.get('track'))
        if not grade or not school or not track:
            continue
        item = {'grade': grade, 'school': school, 'track': track}
        for _zh, field in THRESHOLD_FIELDS:
            item[field] = to_int(t.get(field))
        item['key'] = to_str(t.get('key')) or (grade + school + track)
        thresholds.append(item)
    universities = []
    for u in obj.get('universities') or []:
        tier = to_str(u.get('tier'))
        names = [to_str(x) for x in (u.get('schools') or [])]
        names = [x for x in names if x]
        if tier and names:
            universities.append({'tier': tier, 'schools': names})
    return thresholds, universities


def render_js(thresholds, universities):
    """渲染成 js/data-locator.js 的文本。"""
    def one_line(o):
        return json.dumps(o, ensure_ascii=False, separators=(', ', ': '))

    body = []
    body.append('/* =========================================================')
    body.append(' * data-locator.js —— 院校定位器基础数据（由 tools/gen-locator.py 自动生成，请勿手改）')
    body.append(' * 数据来源：26号查询定位器.xlsx 的「阈值表」+「大学名单」')
    body.append(' * 阈值表字段：t985/t211/ttk/ta/tb = 985 / 双一流 / 特控 / 二本A / 二本B 的排名上限')
    body.append(' *              上限指「校内排名 ≤ 该数值即可报考该层次」；0 表示本届本校该档未划线。')
    body.append(' * 阈值条数：%d    档次：%s' % (len(thresholds), '、'.join(u['tier'] for u in universities)))
    body.append(' * ========================================================= */')
    body.append('(function (App) {')
    body.append("  'use strict';")
    body.append('  App.Locator = App.Locator || {};')
    body.append('')
    body.append('  /* 阈值表：(届别 + 学校 + 科类) -> 各档次排名上限 */')
    body.append('  App.Locator.thresholds = [')
    for t in thresholds:
        body.append('    ' + one_line(t) + ',')
    if thresholds:
        body[-1] = body[-1][:-1]          # 去掉最后一项的逗号
    body.append('  ];')
    body.append('')
    body.append('  /* 各档次的大学参考名单（tier 与阈值表档次一一对应） */')
    body.append('  App.Locator.universities = [')
    for u in universities:
        body.append('    ' + one_line(u) + ',')
    if universities:
        body[-1] = body[-1][:-1]
    body.append('  ];')
    body.append('})(window.App);')
    body.append('')
    return '\n'.join(body)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    out = None
    if '-o' in sys.argv:
        i = sys.argv.index('-o')
        if i + 1 < len(sys.argv):
            out = sys.argv[i + 1]
    if not args:
        sys.exit('用法：python3 tools/gen-locator.py <xlsx或json路径> [-o 输出js路径]')

    src = args[0]
    if not os.path.exists(src):
        sys.exit('找不到文件：' + src)
    ext = os.path.splitext(src)[1].lower()
    if ext in ('.json',):
        thresholds, universities = read_json(src)
    else:
        thresholds, universities = read_xlsx(src)

    if not thresholds:
        sys.exit('没有解析到任何阈值行，请检查表格内容。')
    if not universities:
        sys.exit('没有解析到大学名单，请检查「大学名单」工作表。')

    if not out:
        out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'js', 'data-locator.js')
    open(out, 'w', encoding='utf-8').write(render_js(thresholds, universities))
    print('已生成:', out)
    print('阈值条数: %d   档次数: %d' % (len(thresholds), len(universities)))
    for u in universities:
        print('  %-8s %d 所' % (u['tier'], len(u['schools'])))


if __name__ == '__main__':
    main()

# -*- coding: utf-8 -*-
"""把多文件项目打包为一个可直接双击运行的 HTML 单文件。

T14：构建时同时给 index.html 里的本地资源（js/*.js、assets/style.css）打上
「构建时刻」版本号（?v=YYYYMMDDHHmm），击穿浏览器对无 Cache-Control 响应的
启发式缓存；单文件版把资源全部内联，天然不受影响。
"""
import os, re
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '学生管理系统')
JS_ORDER = ['core.js', 'db.js', 'perm.js', 'ui-kit.js',
            'data-locator.js', 'locator.js', 'data-gradesize.js', 'gradesize.js',
            'analysis.js', 'study-plan.js', 'charts.js', 'export.js', 'module-home.js',
            'module-score.js', 'module-students.js', 'module-classes.js',
            'module-customers.js', 'module-tasks.js', 'module-contracts.js',
            'module-users.js', 'module-login.js', 'sync.js', 'app.js']

# ---------- T14：本地资源版本号（缓存击穿） ----------
# 沙箱服务器不给静态资源发 Cache-Control / ETag，浏览器会按「last-modified 的 10%」
# 启发式缓存 index.html 与 js —— 发布后用户拿到的可能仍是旧组合。
# 对策：每个本地资源带 ?v=<构建时刻>；每次构建自动刷新，URL 一变浏览器必然重新拉取。
#   · 只匹配本地资源（src="js/... / href="assets/style.css），CDN 那行绝对路径不碰；
#   · 幂等：旧的 ?v=NNNN（若存在）整段被替换成新值，重复运行不叠加参数。
STAMP = datetime.now().strftime('%Y%m%d%H%M')

def stamp_local_assets(text, stamp):
    """把 index.html 里本地资源的 ?v= 参数（可缺省）统一刷成 stamp。"""
    text = re.sub(r'(src="js/[a-z\-]+\.js)(?:\?v=\d+)?"',
                  r'\1?v=' + stamp + '"', text)
    text = re.sub(r'(href="assets/style\.css)(?:\?v=\d+)?"',
                  r'\1?v=' + stamp + '"', text)
    return text

index_path = os.path.join(SRC, 'index.html')
html = open(index_path, encoding='utf-8').read()
html = stamp_local_assets(html, STAMP)
open(index_path, 'w', encoding='utf-8').write(html)
print('index.html 版本号已更新为 v=%s（%d 个本地资源）'
      % (STAMP, len(re.findall(r'\?v=' + STAMP, html))))

css = open(os.path.join(SRC, 'assets', 'style.css'), encoding='utf-8').read()
js = '\n\n'.join('/* ===== %s ===== */\n' % f + open(os.path.join(SRC, 'js', f), encoding='utf-8').read()
                 for f in JS_ORDER)

# 内联样式（兼容带 / 不带 ?v= 两种写法；用 lambda 避免 css 里的反斜杠被当替换转义）
html = re.sub(r'<link rel="stylesheet" href="assets/style\.css(?:\?v=\d+)?"',
              lambda m: '<style>\n' + css + '\n</style>', html)
# 内联脚本（保留加载顺序；同样兼容 ?v=）
html = re.sub(r'\s*<script src="js/[a-z\-]+\.js(?:\?v=\d+)?"></script>', '', html)
html = html.replace('</body>', '<script>\n' + js + '\n</script>\n</body>')

out = os.path.join(ROOT, '学生管理系统-单文件版.html')
open(out, 'w', encoding='utf-8').write(html)
print('已生成:', out)
print('体积: %.1f KB' % (os.path.getsize(out) / 1024))

#!/usr/bin/env python3
# 在 GitHub 远端创建/更新 issue label（幂等：已存在则 PATCH 颜色与描述）
# 用法: GITHUB_TOKEN=<token> python scripts/setup-labels.py
# label 体系与配色说明见 docs/issue-pr-conventions.md 第二节；
# 与 .github/ISSUE_TEMPLATE/task_request.yml 的类型下拉保持一致（feat/ui/persona/infra/idea）
import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

OWNER, REPO = "chemmy-11", "moonveil-archive"
TOKEN = os.environ.get("GITHUB_TOKEN")
if not TOKEN:
    sys.exit("缺少 GITHUB_TOKEN 环境变量")

# 配色取自项目莫兰迪色系（ui/persona 直接用苏晚晚粉与唐糖杏橙）
LABELS = [
    ("bug",     "C97B7B", "缺陷：功能异常 / 报错 / UI 不符预期"),
    ("feat",    "9BB493", "新功能 / roadmap 编号项拆出的任务"),
    ("ui",      "D993B4", "界面打磨"),
    ("persona", "E0B06C", "人设与内容调整（改 personas 需同步 js/data.js）"),
    ("infra",   "8A9BA8", "工程债 / 构建 / 发布链路"),
    ("idea",    "B3AECB", "想法、未对齐方向（先留 roadmap 对齐后再拆任务）"),
]


def api(path, method="GET", data=None):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{OWNER}/{REPO}/{path}",
        data=json.dumps(data).encode() if data else None,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(req) as r:
        body = r.read()
    return json.loads(body) if body else None


for name, color, desc in LABELS:
    try:
        api(f"labels/{name}")
        api(f"labels/{name}", "PATCH", {"color": color, "description": desc})
        print(f"  {name}: 已更新（此前已存在）")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            api("labels", "POST", {"name": name, "color": color, "description": desc})
            print(f"  {name}: 已创建")
        else:
            raise

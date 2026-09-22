# -*- coding: utf-8 -*-
# 通过 GitHub Git Trees API 批量上传项目（绕过被重置的 github.com git 协议，
# 走 api.github.com 直连）。一次提交，自动处理大文件 blob。
# 用法: python scripts/push-to-github.py
import base64
import json
import os
import subprocess
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = 'chemmy-11'
REPO = 'moonveil'
BRANCH = 'master'
API = 'https://api.github.com'

# 文本扩展名（内嵌进 tree；其余走 blob）
TEXT_EXT = {'.js', '.html', '.css', '.json', '.md', '.xml', '.gradle', '.properties',
            '.txt', '.gitignore', '.py', '.sh', '.toml', '.yml', '.yaml', '.java', '.svg'}


def get_token():
    p = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n',
                       capture_output=True, text=True, cwd=ROOT)
    for line in p.stdout.splitlines():
        if line.startswith('password='):
            return line.split('=', 1)[1]
    raise SystemExit('无法获取 GitHub 凭据（git credential fill 失败）')


def api_request(token, method, url, payload=None):
    req = urllib.request.Request(url, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'moonveil-push')
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        req.add_header('Content-Type', 'application/json')
    else:
        data = None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        raise SystemExit('API {} {} 失败: {} {}'.format(method, url, e.code, body[:300]))


def main():
    token = get_token()
    print('凭据获取成功')

    # 收集文件
    p = subprocess.run(['git', 'ls-files'], capture_output=True, text=True, cwd=ROOT)
    files = [f.replace('\\', '/') for f in p.stdout.splitlines() if f.strip()]
    print('共 {} 个文件'.format(len(files)))

    tree = []
    for i, path in enumerate(files):
        abs_path = os.path.join(ROOT, path.replace('/', os.sep))
        ext = os.path.splitext(path)[1].lower()
        if ext in TEXT_EXT:
            with open(abs_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            tree.append({'path': path, 'mode': '100644', 'type': 'blob', 'content': content})
        else:
            with open(abs_path, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode('ascii')
            blob = api_request(token, 'POST', API + '/repos/{}/{}/git/blobs'.format(OWNER, REPO),
                               {'content': b64, 'encoding': 'base64'})
            tree.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        if (i + 1) % 20 == 0 or i == len(files) - 1:
            print('  处理中 {}/{}'.format(i + 1, len(files)))

    print('创建 tree...')
    tree_resp = api_request(token, 'POST', API + '/repos/{}/{}/git/trees'.format(OWNER, REPO),
                            {'tree': tree})
    print('创建 commit...')
    commit = api_request(token, 'POST', API + '/repos/{}/{}/git/commits'.format(OWNER, REPO),
                         {'message': 'feat: 月见 Moonveil 初始化（三个 AI 女友聊天应用）',
                          'tree': tree_resp['sha']})
    print('更新分支 ref...')
    api_request(token, 'POST', API + '/repos/{}/{}/git/refs'.format(OWNER, REPO),
                {'ref': 'refs/heads/' + BRANCH, 'sha': commit['sha']})
    print('✅ 推送完成: https://github.com/{}/{}/commit/{}'.format(OWNER, REPO, commit['sha'][:7]))


if __name__ == '__main__':
    main()

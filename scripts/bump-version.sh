#!/usr/bin/env bash
# 一键发版 bump（issue #25）：version.js → build.gradle（versionName + versionCode）→ build.sh 注入与校验
# 用法:
#   bash scripts/bump-version.sh          # patch +1（如 0.2.5 → 0.2.6）
#   bash scripts/bump-version.sh 0.3.0    # 指定目标版本号
# 版本三处同步规则见 docs/roadmap.md「发布规范」；OTA 推送 moonveil-updates 仍由 owner 执行。
set -e
cd "$(dirname "$0")/.."

CUR=$(sed -n "s/.*APP_VERSION = '\([^']*\)'.*/\1/p" js/version.js)
[ -n "$CUR" ] || { echo "!! 无法从 js/version.js 读取当前版本"; exit 1; }

if [ -n "$1" ]; then
  NEXT="$1"
else
  IFS=. read -r MA MI PA <<< "$CUR"
  NEXT="$MA.$MI.$((PA + 1))"
fi

echo "$NEXT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "!! 版本号格式应为 x.y.z，得到: $NEXT"; exit 1; }

# versionCode 规则：(major+1)*1000 + minor*10 + patch（0.2.5 → 1025），必须严格递增——OTA 检查更新依赖它
IFS=. read -r NMA NMI NPA <<< "$NEXT"
CODE=$(( (NMA + 1) * 1000 + NMI * 10 + NPA ))
OLD_CODE=$(sed -n 's/.*versionCode \([0-9]*\).*/\1/p' android/app/build.gradle)
if [ "$CODE" -le "$OLD_CODE" ]; then
  echo "!! versionCode 不递增（$OLD_CODE → $CODE），OTA 会失灵；请检查目标版本号"
  exit 1
fi

sed -i "s/const APP_VERSION = '[^']*';/const APP_VERSION = '$NEXT';/" js/version.js
sed -i "s/versionCode [0-9]*/versionCode $CODE/; s/versionName \"[^\"]*\"/versionName \"$NEXT\"/" android/app/build.gradle
echo "==> 版本已 bump: $CUR → $NEXT（versionCode $OLD_CODE → $CODE）"

echo "==> 跑 build.sh 注入 cache-bust 并全量校验"
bash scripts/build.sh | tail -6

echo ""
echo "完成。请人工核对后提交（建议信息: chore: 发版 v$NEXT）。"

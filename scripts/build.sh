#!/usr/bin/env bash
# 一键构建 AI-GF APK
# 用法: bash scripts/build.sh
# 流程: 同步 www → cap copy → gradlew assembleDebug → 复制到根目录 → md5 逐字节验证 → 版本一致性校验
set -e
cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Java/jdk-17}"
export PATH="$JAVA_HOME/bin:$PATH"

echo "==> 1/6 同步 www（根目录 → www/）"
mkdir -p www
cp index.html www/index.html
cp -r css/. www/css/
cp -r js/. www/js/
cp -r assets/. www/assets/

echo "==> 2/6 cap copy android"
npx cap copy android

echo "==> 3/6 gradle assembleDebug"
(cd android && ./gradlew assembleDebug)

echo "==> 4/6 复制 APK 到根目录"
cp android/app/build/outputs/apk/debug/app-debug.apk AI-GF.apk

echo "==> 5/6 md5 逐字节验证 APK 与源码"
python - <<'PY'
import zipfile, hashlib, sys
h = lambda d: hashlib.md5(d).hexdigest()[:8]
ok = True
try:
    with zipfile.ZipFile('AI-GF.apk') as z:
        for f in ['js/data.js', 'js/app.js', 'index.html', 'css/style.css', 'css/mobile.css', 'js/version.js']:
            src = h(open(f, 'rb').read())
            apk = h(z.read('assets/public/' + f))
            match = src == apk
            ok = ok and match
            print(f"  {f}: {'OK' if match else 'MISMATCH'}")
except KeyError as e:
    print(f"  APK 缺少资源: {e}")
    ok = False
if not ok:
    print("!! APK 与源码不一致，构建未通过")
    sys.exit(1)
PY

echo "==> 6/6 版本一致性校验（js/version.js ↔ build.gradle，不一致仅警告）"
JS_VER=$(sed -n "s/.*APP_VERSION = '\([^']*\)'.*/\1/p" js/version.js)
G_VER=$(sed -n "s/.*versionName \"\([^\"]*\)\".*/\1/p" android/app/build.gradle)
G_CODE=$(sed -n "s/.*versionCode \([0-9]*\).*/\1/p" android/app/build.gradle)
if [ "$JS_VER" != "$G_VER" ]; then
  echo "  ⚠ 版本不一致：js/version.js=$JS_VER, build.gradle versionName=$G_VER（发版时记得同步，OTA 更新依赖 versionCode 递增）"
else
  echo "  版本一致: v$JS_VER (versionCode $G_CODE)"
fi

ls -lh AI-GF.apk | awk '{print $NF, $5}'

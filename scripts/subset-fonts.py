#!/usr/bin/env python3
# 字体子集化——为设置处「字体选择」功能生成 Android 打包字体（issue #5）
# 字表（issue #98 升级版）：ASCII 可打印 + 中文常用标点 + GB2312 全集 6763
#   + 《通用规范汉字表》8105（scripts/charset-std8105.txt）+ 高频口语字补丁。
#   旧版仅 GB2312 一级字 3755（--level2 才含二级），聊天高频语气字「嗯/呗/诶/嘞/唻」等大量缺字，
#   渲染时逐字符回落系统默认字体，同句混排非常刺眼（owner 实机反馈）。
# 依赖：pip install fonttools brotli
# 用法：python scripts/subset-fonts.py <输入字体.ttf/.woff2> <输出.woff2>
# ⚠ 重新生成后需同步 scripts/build.sh 的 md5 清单核对（build.sh 校验步骤用这些文件名）。
import os
import string
import sys

from fontTools import subset

EXTRA_PUNCT = (
    '，。！？；：、""\'\'（）《》〈〉【】〔〕…—～·「」『』％￥℃°'
    '×÷≈≠≤≥±①②③④⑤⑥⑦⑧⑨⑩⑪⑫↑↓←→☆★♦♣♠♥〇□■△▲'
    '一二三四五六七八九十零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿'
)

# 聊天高频口语字补丁：GB2312 与通规表都未收/易漏的语气字（owner 实测回落重灾区）
COLLOQUIAL = '嗯呗诶嘞唻啰咯哦哟哼啦嘛咧嘻咩嘚咗唦欸喔嚛囖'

CHARSET_STD8105 = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'charset-std8105.txt')


def load_std8105():
    with open(CHARSET_STD8105, encoding='utf-8') as f:
        return set(f.read()) - set('\n\r\t ')


def build_text():
    chars = set(string.printable)
    # GB2312 全集：一级（B0A1–D7F9，3755 常用字）+ 二级（D8A1–F7FE，3008 次常用字）
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    chars.update(EXTRA_PUNCT)
    chars.update(COLLOQUIAL)
    chars.update(load_std8105())
    return ''.join(sorted(chars))


def main():
    if len(sys.argv) != 3:
        print('usage: python scripts/subset-fonts.py <input font> <output.woff2>')
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    text = build_text()
    subset.main([
        src,
        f'--text={text}',
        '--flavor=woff2',
        '--layout-features=*',
        '--drop-tables+=DSIG',
        '--name-IDs=*',
        f'--output-file={dst}',
    ])
    print(f'{dst}: {os.path.getsize(dst) / 1024:.0f} KB ({len(text)} chars)')


if __name__ == '__main__':
    main()

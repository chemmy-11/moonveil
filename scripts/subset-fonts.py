#!/usr/bin/env python3
# 字体子集化——为设置处「字体选择」功能生成 Android 打包字体（issue #5）
# 字表：GB2312 一级常用字 3755 + ASCII 可打印 + 中文常用标点（约 4000 字符）
# 依赖：pip install fonttools brotli
# 用法：python scripts/subset-fonts.py <输入字体.ttf/.woff2> <输出.woff2>
import os
import string
import sys

from fontTools import subset

EXTRA_PUNCT = (
    '，。！？；：、""\'\'（）《》〈〉【】〔〕…—～·「」『』％￥℃°'
    '×÷≈≠≤≥±①②③④⑤⑥⑦⑧⑨⑩⑪⑫↑↓←→☆★♦♣♠♥〇□■△▲'
    '一二三四五六七八九十零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿'
)


def build_text(level2=False):
    chars = set(string.printable)
    # GB2312 一级字库区（B0A1–D7F9）：3755 个常用字，Python 内置编解码即可生成
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    # 二级字库区（D8A1–F7FE）：3008 个次常用字（人名/书面语高频出现）——气泡手写体需要
    if level2:
        for hi in range(0xD8, 0xF8):
            for lo in range(0xA1, 0xFF):
                try:
                    chars.add(bytes([hi, lo]).decode('gb2312'))
                except UnicodeDecodeError:
                    pass
    chars.update(EXTRA_PUNCT)
    return ''.join(sorted(chars))


def main():
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != '--level2'):
        print('usage: python scripts/subset-fonts.py <input font> <output.woff2> [--level2]')
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    text = build_text(level2=len(sys.argv) == 4)
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

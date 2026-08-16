#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# 生成「星河」夜晚主题壁纸 assets/starry.webp
# 深蓝夜空渐变 + 星云光晕 + 银河斜带 + 星子（聚散分布/亮星带光芒光晕）+ 底部渐暗
# 用法: python scripts/generate-starry.py（random 固定 seed，可复现）
# ═══════════════════════════════════════════════════════════
import os
import random
from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 2400                       # 竖版，background-size: cover 自适应横竖屏
random.seed(20260813)

# ── 1) 底色渐变：上深下浅（与 css/style.css 月夜令牌协调） ──
top, bottom = (14, 20, 46), (28, 36, 82)
img = Image.new('RGB', (W, H))
px = img.load()
for y in range(H):
    t = y / H
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    for x in range(W):
        px[x, y] = (r, g, b)

# ── 2) 星云：淡紫/淡蓝大半径光晕（带一点青蓝边缘） ──
nebula = Image.new('RGBA', (W, H), (0, 0, 0, 0))
nd = ImageDraw.Draw(nebula)
for cx, cy, rad, col in [
    (0.22 * W, 0.16 * H, 560, (152, 130, 232)),
    (0.80 * W, 0.40 * H, 680, (116, 152, 242)),
    (0.50 * W, 0.72 * H, 500, (142, 112, 214)),
    (0.35 * W, 0.45 * H, 420, (96, 140, 218)),
    (0.62 * W, 0.22 * H, 460, (214, 138, 196)),   # 暖紫红，打破纯蓝单调
]:
    for r, a in [(rad, 38), (rad * 0.6, 44)]:
        nd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (a,))
nebula = nebula.filter(ImageFilter.GaussianBlur(200))
img = Image.alpha_composite(img.convert('RGBA'), nebula)

# ── 3) 银河：对角线弥散亮带（两层：细密核心 + 宽雾晕） ──
x1, y1, x2, y2 = 0.16 * W, 0.06 * H, 0.90 * W, 0.74 * H

galaxy_core = Image.new('RGBA', (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(galaxy_core)
for _ in range(2200):
    t = random.random()
    x = x1 + (x2 - x1) * t + random.gauss(0, 0.10 * W)
    y = y1 + (y2 - y1) * t + random.gauss(0, 0.030 * H)
    r = random.uniform(1, 3)
    a = random.randint(12, 46)
    c = random.choice([(255, 255, 255), (232, 226, 255), (198, 214, 255), (255, 240, 214)])
    gd.ellipse([x - r, y - r, x + r, y + r], fill=c + (a,))
galaxy_core = galaxy_core.filter(ImageFilter.GaussianBlur(18))
img = Image.alpha_composite(img, galaxy_core)

galaxy_haze = Image.new('RGBA', (W, H), (0, 0, 0, 0))
hd = ImageDraw.Draw(galaxy_haze)
for _ in range(900):
    t = random.random()
    x = x1 + (x2 - x1) * t + random.gauss(0, 0.20 * W)
    y = y1 + (y2 - y1) * t + random.gauss(0, 0.07 * H)
    r = random.uniform(4, 9)
    a = random.randint(6, 16)
    hd.ellipse([x - r, y - r, x + r, y + r], fill=(215, 220, 250) + (a,))
galaxy_haze = galaxy_haze.filter(ImageFilter.GaussianBlur(55))
img = Image.alpha_composite(img, galaxy_haze)

# ── 4) 星子：聚散分布（银河带附近密集）+ 尘埃星 + 暖冷色温 + 亮星光晕 ──
STAR_COLORS = [(255, 255, 255), (255, 246, 228), (210, 224, 255), (255, 236, 196), (235, 218, 255), (255, 214, 170)]
stars = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(stars)

def on_galaxy():
    """80% 概率沿银河带高斯分布，其余全屏均匀（模拟真实聚散）"""
    if random.random() < 0.8:
        t = random.random()
        return (x1 + (x2 - x1) * t + random.gauss(0, 0.12 * W),
                y1 + (y2 - y1) * t + random.gauss(0, 0.035 * H))
    return (random.uniform(0, W), random.uniform(0, H) * random.uniform(0.72, 1.0))

for i in range(1250):
    x, y = on_galaxy()
    roll = random.random()
    if roll < 0.40:                       # 尘埃星：极微小，细密
        r, a = random.uniform(0.5, 0.8), random.randint(38, 92)
    elif roll < 0.92:                     # 普通星
        r, a = random.uniform(0.9, 1.3), random.randint(80, 175)
    elif roll < 0.985:                    # 中等星
        r, a = 1.6, random.randint(130, 215)
    else:                                 # 亮星（带光晕 + 十字光芒）
        r, a = 2.4, random.randint(170, 240)
    c = random.choice(STAR_COLORS)
    sd.ellipse([x - r, y - r, x + r, y + r], fill=c + (a,))
    if r >= 2.4:
        glow_r = r * 4                    # 外围柔光晕（收敛，避免盖过光芒）
        for gr, ga in [(glow_r, int(a * 0.22)), (glow_r * 0.5, int(a * 0.35))]:
            sd.ellipse([x - gr, y - gr, x + gr, y + gr], fill=c + (ga,))
        L = r * 5                          # 十字光芒（清晰锐利）
        for dx, dy in [(1, 0), (0, 1)]:
            sd.line([x - L * dx, y - L * dy, x + L * dx, y + L * dy], fill=c + (int(a * 0.65),), width=1)
            sd.line([x - L * 0.5 * dx, y - L * 0.5 * dy, x + L * 0.5 * dx, y + L * 0.5 * dy], fill=c + (int(a * 0.4),), width=1)
img = Image.alpha_composite(img, stars.filter(ImageFilter.GaussianBlur(0.4)))

# ── 5) 底部渐暗（提升 UI 对比度） ──
dark = Image.new('RGBA', (W, H), (0, 0, 0, 0))
dd = ImageDraw.Draw(dark)
start = int(H * 0.78)
for y in range(start, H):
    a = int(90 * (y - start) / (H - start))
    dd.line([(0, y), (W, y)], fill=(6, 10, 24, a))
img = Image.alpha_composite(img, dark).convert('RGB')

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'starry.webp')
img.save(out, 'WEBP', quality=86, method=5)
print('saved:', out, img.size)

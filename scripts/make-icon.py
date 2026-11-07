#!/usr/bin/env python3
"""生成商店卡片用的位图图标（180x180），图形与 icon.svg 一致。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(OUT, exist_ok=True)
S = 180
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方块（与 icon.svg 同色）
d.rounded_rectangle([8, 8, S - 8, S - 8], radius=40, fill=(59, 130, 246, 255))

# 连梁音符：左边竖线 + 上方横梁 + 右边竖线
def sc(v):
    """icon.svg 是 64 视窗，这里换成 180 视窗"""
    return v / 64.0 * S

lw = max(3, int(sc(3.4)))
# 竖线（M25 45 V19 → 左；L47 14 V40 → 右）
d.line([(sc(25), sc(45)), (sc(25), sc(19))], fill=(255, 255, 255, 255), width=lw)
d.line([(sc(25), sc(19)), (sc(46), sc(14))], fill=(255, 255, 255, 255), width=lw)
d.line([(sc(46), sc(14)), (sc(46), sc(40))], fill=(255, 255, 255, 255), width=lw)

# 两个符头
hw, hh = sc(7), sc(5.4)
for cx, cy in [(sc(20.5), sc(46)), (sc(41.5), sc(41))]:
    d.ellipse([cx - hw, cy - hh, cx + hw, cy + hh], fill=(255, 255, 255, 255))

out = os.path.join(OUT, "icon-180.png")
img.save(out)
print("wrote", out, img.size)

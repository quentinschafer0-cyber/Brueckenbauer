#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Brückenbauer – App-Icon-Generator
=================================

Zeichnet das App-Icon (Comic-Stil: Himmel mit Sonne und Wolken, grüne Ufer,
blauer Fluss mit Wellen, orange-rote Stahl-Fachwerkbrücke mit dunkler Fahrbahn
und kleinem roten Auto) und speichert alle benötigten Größen:

    icon-192.png            192×192, abgerundetes Quadrat (transparente Ecken)
    icon-512.png            512×512, abgerundetes Quadrat (transparente Ecken)
    icon-maskable-512.png   512×512, randlos; Motiv innerhalb der 80-%-Schutzzone
    apple-touch-icon.png    180×180, randlos, OHNE Transparenz (iOS rundet selbst)
    favicon-32.png          32×32, vereinfachtes Motiv mit dickeren Linien

Aufruf (Python 3 + Pillow):   python make-icons.py [--preview ORDNER]
Mit --preview wird zusätzlich ein 1024-px-Vorschaubild in ORDNER abgelegt.

Gezeichnet wird in hoher Auflösung (2048 px) und dann mit LANCZOS verkleinert –
so werden alle Kanten weich (Pillow zeichnet selbst ohne Kantenglättung).
"""

import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = 2048          # Arbeitsauflösung für die großen Icons

# --- Farben ------------------------------------------------------------------
INK = (34, 40, 58)                 # Comic-Kontur
SKY_TOP = (64, 170, 240)
SKY_BOTTOM = (196, 236, 255)
SUN = (255, 214, 64)
SUN_EDGE = (240, 160, 30)
SUN_GLOW = (255, 240, 170)
CLOUD = (255, 255, 255)
CLOUD_SHADE = (214, 236, 250)
CLOUD_EDGE = (128, 186, 226)
HILL_FAR = (150, 212, 170)
HILL_NEAR = (120, 198, 120)
VALLEY_TOP = (110, 182, 140)
VALLEY_BOTTOM = (78, 150, 128)
WATER_TOP = (72, 172, 246)
WATER_BOTTOM = (26, 92, 180)
WAVE = (205, 236, 255)
EARTH = (186, 122, 70)
EARTH_DARK = (150, 92, 50)
STONE = (222, 186, 140)
GRASS = (98, 196, 60)
GRASS_LIGHT = (160, 232, 100)
ROAD = (60, 64, 78)
ROAD_LIGHT = (98, 104, 122)
ROAD_LINE = (255, 226, 110)
STEEL = (240, 96, 40)
STEEL_LIGHT = (255, 160, 100)
STEEL_DARK = (196, 60, 24)
CAR = (230, 52, 64)
CAR_LIGHT = (255, 120, 120)
GLASS = (190, 232, 255)
TIRE = (40, 40, 48)
HUB = (200, 204, 212)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


class Canvas:
    """Maps the normalised motif square (0..1, y down) onto the image.

    view = (cx, cy, scale): motif point (cx, cy) lands in the image centre,
    one motif unit = scale × image size. Horizontal "bands" (sky, water, banks)
    are drawn with generous extents, so a zoomed-out motif still fills the whole
    image (needed for the maskable icon).
    """

    def __init__(self, size, view=(0.5, 0.5, 1.0)):
        self.size = size
        self.img = Image.new('RGB', (size, size), SKY_TOP)
        self.draw = ImageDraw.Draw(self.img)
        cx, cy, s = view
        self.sc = s * size
        self.ox = size / 2 - cx * self.sc
        self.oy = size / 2 - cy * self.sc

    def p(self, u, v):
        return (self.ox + u * self.sc, self.oy + v * self.sc)

    def pts(self, seq):
        return [self.p(u, v) for (u, v) in seq]

    def l(self, d):
        return max(1, int(round(d * self.sc)))

    def v_of_row(self, y):
        return (y - self.oy) / self.sc

    # -- primitives ----------------------------------------------------------
    def circle(self, u, v, r, fill, outline=None, width=0):
        x, y = self.p(u, v)
        rr = r * self.sc
        self.draw.ellipse([x - rr, y - rr, x + rr, y + rr], fill=fill,
                          outline=outline, width=self.l(width) if outline else 0)

    def ellipse(self, u, v, rx, ry, fill):
        x, y = self.p(u, v)
        self.draw.ellipse([x - rx * self.sc, y - ry * self.sc, x + rx * self.sc, y + ry * self.sc], fill=fill)

    def poly(self, seq, fill, outline=None, width=0):
        pts = self.pts(seq)
        self.draw.polygon(pts, fill=fill)
        if outline:
            self.draw.line(pts + [pts[0]], fill=outline, width=self.l(width), joint='curve')

    def line(self, seq, fill, width, round_caps=True):
        pts = self.pts(seq)
        w = self.l(width)
        self.draw.line(pts, fill=fill, width=w, joint='curve')
        if round_caps:
            for (x, y) in (pts[0], pts[-1]):
                r = w / 2
                self.draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)

    def vgradient_poly(self, seq, c_top, c_bottom, v_top, v_bottom):
        """Polygon filled with a vertical gradient between motif rows v_top..v_bottom."""
        mask = Image.new('L', (self.size, self.size), 0)
        ImageDraw.Draw(mask).polygon(self.pts(seq), fill=255)
        grad = Image.new('RGB', (self.size, self.size))
        gd = ImageDraw.Draw(grad)
        for y in range(self.size):
            t = (self.v_of_row(y) - v_top) / max(1e-6, (v_bottom - v_top))
            gd.line([(0, y), (self.size, y)], fill=mix(c_top, c_bottom, t))
        self.img.paste(grad, (0, 0), mask)

    def overlay(self, fn, blur=0, opacity=1.0):
        """Draw something soft (glow, shading) on a separate layer and blend it in."""
        layer = Image.new('RGBA', (self.size, self.size), (0, 0, 0, 0))
        fn(ImageDraw.Draw(layer))
        if blur:
            layer = layer.filter(ImageFilter.GaussianBlur(blur * self.sc))
        if opacity < 1:
            a = layer.getchannel('A').point(lambda x: int(x * opacity))
            layer.putalpha(a)
        base = self.img.convert('RGBA')
        base.alpha_composite(layer)
        self.img = base.convert('RGB')
        self.draw = ImageDraw.Draw(self.img)


# ------------------------------------------------------------------------------
# Scene parts (motif coordinates)
# ------------------------------------------------------------------------------

BIG = 3.0            # extents of "infinite" bands
DECK_TOP = 0.555
DECK_BOTTOM = 0.607
BANK_TOP = 0.6
WATER_Y = 0.745
TRUSS_TOP = 0.39


def draw_sky(c):
    d = c.draw
    for y in range(c.size):
        t = c.v_of_row(y) / 0.66
        d.line([(0, y), (c.size, y)], fill=mix(SKY_TOP, SKY_BOTTOM, t))


def draw_sun(c, simple):
    cx, cy, r = 0.77, 0.205, 0.085

    def glow(d):
        x, y = c.p(cx, cy)
        rr = r * 1.9 * c.sc
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=SUN_GLOW + (150,))
    c.overlay(glow, blur=0.05)
    # rays
    n = 12
    for i in range(n):
        a = i * 2 * math.pi / n + 0.13
        long_ray = i % 2 == 0
        r0, r1 = r * 1.22, r * (1.62 if long_ray else 1.45)
        w = 0.17 if long_ray else 0.13
        pts = [(cx + math.cos(a - w) * r0, cy + math.sin(a - w) * r0),
               (cx + math.cos(a) * r1, cy + math.sin(a) * r1),
               (cx + math.cos(a + w) * r0, cy + math.sin(a + w) * r0)]
        c.poly(pts, SUN, SUN_EDGE, 0.006)
    c.circle(cx, cy, r, SUN, SUN_EDGE, 0.008)
    c.circle(cx - r * 0.25, cy - r * 0.28, r * 0.42, mix(SUN, (255, 255, 255), 0.35))
    if not simple:
        # friendly face
        for ex in (-0.32, 0.32):
            c.ellipse(cx + ex * r, cy - 0.12 * r, 0.075 * r, 0.12 * r, INK)
        x0, y0 = c.p(cx - 0.45 * r, cy - 0.3 * r)
        x1, y1 = c.p(cx + 0.45 * r, cy + 0.5 * r)
        c.draw.arc([x0, y0, x1, y1], start=25, end=155, fill=INK, width=c.l(0.012))
        for ex in (-0.6, 0.6):
            def cheek(d, ex=ex):
                x, y = c.p(cx + ex * r, cy + 0.22 * r)
                rr = 0.16 * r * c.sc
                d.ellipse([x - rr, y - rr * 0.7, x + rr, y + rr * 0.7], fill=(255, 130, 90, 110))
            c.overlay(cheek)


def draw_cloud(c, cx, cy, s):
    blobs = [(-0.10, 0.02, 0.05), (-0.04, -0.02, 0.065), (0.035, 0.0, 0.055), (0.09, 0.025, 0.04), (0.0, 0.03, 0.05)]
    # outline pass
    for (dx, dy, r) in blobs:
        c.circle(cx + dx * s, cy + dy * s, r * s + 0.008, CLOUD_EDGE)
    c.poly([(cx - 0.10 * s, cy + 0.02 * s), (cx + 0.09 * s, cy + 0.025 * s),
            (cx + 0.09 * s, cy + 0.065 * s + 0.008), (cx - 0.10 * s, cy + 0.07 * s + 0.008)], CLOUD_EDGE)
    for (dx, dy, r) in blobs:
        c.circle(cx + dx * s, cy + dy * s, r * s, CLOUD)
    c.poly([(cx - 0.10 * s, cy + 0.02 * s), (cx + 0.09 * s, cy + 0.025 * s),
            (cx + 0.09 * s, cy + 0.065 * s), (cx - 0.10 * s, cy + 0.07 * s)], CLOUD)
    # soft shade at the bottom
    c.ellipse(cx - 0.005 * s, cy + 0.055 * s, 0.085 * s, 0.014 * s, CLOUD_SHADE)


def draw_hills(c):
    # far valley wall seen through the gap (down to the water)
    c.vgradient_poly([(-BIG, 0.56), (BIG, 0.56), (BIG, 0.85), (-BIG, 0.85)], VALLEY_TOP, VALLEY_BOTTOM, 0.56, 0.8)
    c.ellipse(0.12, 0.62, 0.36, 0.16, HILL_FAR)
    c.ellipse(0.95, 0.63, 0.34, 0.18, HILL_FAR)
    c.ellipse(0.55, 0.66, 0.32, 0.14, mix(HILL_FAR, HILL_NEAR, 0.4))


def water_surface(x):
    return WATER_Y + 0.007 * math.sin(x * 38.0)


def draw_water(c, simple):
    top = [(x / 100.0, water_surface(x / 100.0)) for x in range(-100, 201)]
    c.vgradient_poly(top + [(2.0, BIG), (-1.0, BIG)], WATER_TOP, WATER_BOTTOM, WATER_Y, 1.05)
    c.line(top, mix(WATER_TOP, (255, 255, 255), 0.45), 0.01, round_caps=False)
    if simple:
        return
    # wave marks
    for (u, v, s) in [(0.36, 0.81, 1.0), (0.58, 0.79, 0.8), (0.47, 0.88, 1.1), (0.66, 0.9, 0.9), (0.31, 0.93, 0.8)]:
        x0, y0 = c.p(u - 0.035 * s, v - 0.012 * s)
        x1, y1 = c.p(u + 0.035 * s, v + 0.02 * s)
        c.draw.arc([x0, y0, x1, y1], start=200, end=340, fill=WAVE, width=c.l(0.009))
    # sparkles
    for (u, v) in [(0.42, 0.775), (0.62, 0.84), (0.53, 0.95)]:
        c.ellipse(u, v, 0.012, 0.004, (235, 248, 255))


def bank_polygon(mirror):
    pts = [(-BIG, BANK_TOP), (0.205, BANK_TOP), (0.222, 0.65), (0.212, 0.71), (0.236, 0.79),
           (0.226, 0.87), (0.25, 0.96), (0.245, BIG), (-BIG, BIG)]
    if mirror:
        pts = [(1.0 - u, v) for (u, v) in pts]
    return pts


def draw_bank(c, mirror, simple):
    pts = bank_polygon(mirror)
    c.poly(pts, EARTH)
    if not simple:
        # strata
        for (v, amp) in [(0.68, 0.006), (0.77, 0.008), (0.86, 0.006), (0.95, 0.008)]:
            seq = []
            for i in range(0, 37):          # ends inside the cliff (face is at u ≥ 0.205)
                u = -0.4 + i * 0.016
                seq.append((u, v + amp * math.sin(u * 47 + v * 9)))
            if mirror:
                seq = [(1.0 - u, w) for (u, w) in seq]
            c.line(seq, EARTH_DARK, 0.008)
        # stones
        stones = [(0.15, 0.7, 0.018), (0.08, 0.82, 0.022), (0.18, 0.9, 0.016), (0.04, 0.73, 0.014)]
        for (u, v, r) in stones:
            if mirror:
                u = 1.0 - u
            c.circle(u, v, r, STONE, INK, 0.006)
    # comic outline along the top edge and the cliff face
    pts_px = c.pts(pts)
    c.draw.line(pts_px[1:-2], fill=INK, width=c.l(0.012), joint='curve')
    # grass cap with little drips
    edge = 0.212
    g = [(-BIG, BANK_TOP - 0.012), (edge, BANK_TOP - 0.012), (edge + 0.012, BANK_TOP + 0.004),
         (edge + 0.006, BANK_TOP + 0.024), (edge - 0.02, BANK_TOP + 0.03), (edge - 0.04, BANK_TOP + 0.022),
         (edge - 0.07, BANK_TOP + 0.036), (edge - 0.1, BANK_TOP + 0.024), (edge - 0.14, BANK_TOP + 0.034),
         (-BIG, BANK_TOP + 0.03)]
    if mirror:
        g = [(1.0 - u, v) for (u, v) in g]
    c.poly(g, GRASS, INK, 0.009)
    hl = [(-BIG, BANK_TOP - 0.004), (edge - 0.004, BANK_TOP - 0.004)]
    if mirror:
        hl = [(1.0 - u, v) for (u, v) in hl]
    c.line(hl, GRASS_LIGHT, 0.007, round_caps=False)
    if not simple:
        # tufts
        for u in (0.04, 0.12):
            uu = 1.0 - u if mirror else u
            for k in (-1, 0, 1):
                c.line([(uu + k * 0.008, BANK_TOP - 0.01), (uu + k * 0.016, BANK_TOP - 0.035 + abs(k) * 0.008)], GRASS, 0.007)


TRUSS_MEMBERS = [
    ((0.20, DECK_TOP + 0.01), (0.35, TRUSS_TOP)),     # end post left
    ((0.80, DECK_TOP + 0.01), (0.65, TRUSS_TOP)),     # end post right
    ((0.35, TRUSS_TOP), (0.65, TRUSS_TOP)),           # top chord
    ((0.35, TRUSS_TOP), (0.35, DECK_TOP + 0.01)),     # verticals
    ((0.50, TRUSS_TOP), (0.50, DECK_TOP + 0.01)),
    ((0.65, TRUSS_TOP), (0.65, DECK_TOP + 0.01)),
    ((0.35, TRUSS_TOP), (0.50, DECK_TOP + 0.01)),     # diagonals
    ((0.65, TRUSS_TOP), (0.50, DECK_TOP + 0.01)),
]
TRUSS_JOINTS = [(0.20, DECK_TOP + 0.012), (0.35, DECK_TOP + 0.012), (0.50, DECK_TOP + 0.012), (0.65, DECK_TOP + 0.012),
                (0.80, DECK_TOP + 0.012), (0.35, TRUSS_TOP), (0.50, TRUSS_TOP), (0.65, TRUSS_TOP)]


def draw_deck(c, simple):
    x0, x1 = 0.11, 0.89
    a, b = c.p(x0, DECK_TOP), c.p(x1, DECK_BOTTOM)
    rad = (DECK_BOTTOM - DECK_TOP) * c.sc * 0.35
    ow = c.l(0.011)
    c.draw.rounded_rectangle([a[0] - ow, a[1] - ow, b[0] + ow, b[1] + ow], radius=rad + ow, fill=INK)
    c.draw.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=rad, fill=ROAD)
    c.line([(x0 + 0.01, DECK_TOP + 0.006), (x1 - 0.01, DECK_TOP + 0.006)], ROAD_LIGHT, 0.008)
    if not simple:
        u = x0 + 0.03
        while u < x1 - 0.05:
            c.line([(u, (DECK_TOP + DECK_BOTTOM) / 2 + 0.004), (u + 0.026, (DECK_TOP + DECK_BOTTOM) / 2 + 0.004)], ROAD_LINE, 0.008)
            u += 0.05


def draw_truss(c, simple):
    w = 0.05 if simple else 0.03
    ow = 0.026 if simple else 0.014
    for (p, q) in TRUSS_MEMBERS:                 # outline pass – members merge into one shape
        c.line([p, q], INK, w + 2 * ow)
    for (p, q) in TRUSS_MEMBERS:                 # fill pass
        c.line([p, q], STEEL, w)
    if not simple:
        for (p, q) in TRUSS_MEMBERS:             # highlight stripe (light from top-left)
            dx, dy = q[0] - p[0], q[1] - p[1]
            n = math.hypot(dx, dy)
            nx, ny = dy / n, -dx / n
            if ny > 0 or (abs(ny) < 1e-6 and nx > 0):
                nx, ny = -nx, -ny
            off = w * 0.24
            c.line([(p[0] + nx * off, p[1] + ny * off), (q[0] + nx * off, q[1] + ny * off)], STEEL_LIGHT, w * 0.28)
    for (u, v) in TRUSS_JOINTS:                  # bolts / gusset plates
        r = (0.038 if simple else 0.022)
        c.circle(u, v, r, STEEL_DARK, INK, 0.008 if not simple else 0.012)
        if not simple:
            c.circle(u - r * 0.25, v - r * 0.25, r * 0.35, STEEL_LIGHT)


def draw_car(c):
    r = 0.021
    x0, x1 = 0.345, 0.505
    wy = DECK_TOP - r
    body_top, body_bot = 0.497, wy + 0.004
    cab_top = 0.458
    ow = 0.009
    # outline silhouettes first
    for (wx) in (x0 + 0.035, x1 - 0.035):
        c.circle(wx, wy, r + ow, INK)
    a, b = c.p(x0, body_top), c.p(x1, body_bot)
    rad = 0.016 * c.sc
    o = ow * c.sc
    c.draw.rounded_rectangle([a[0] - o, a[1] - o, b[0] + o, b[1] + o], radius=rad + o, fill=INK)
    cab = [(x0 + 0.03, body_top + 0.002), (x0 + 0.052, cab_top), (x1 - 0.05, cab_top), (x1 - 0.022, body_top + 0.002)]
    c.poly(cab, CAR, INK, ow * 2)
    c.draw.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=rad, fill=CAR)
    c.poly(cab, CAR)
    # windows
    c.poly([(x0 + 0.044, body_top - 0.002), (x0 + 0.06, cab_top + 0.008), (0.423, cab_top + 0.008), (0.423, body_top - 0.002)], GLASS)
    c.poly([(0.433, body_top - 0.002), (0.433, cab_top + 0.008), (x1 - 0.056, cab_top + 0.008), (x1 - 0.036, body_top - 0.002)], GLASS)
    # shine + details
    c.line([(x0 + 0.015, body_top + 0.01), (x1 - 0.02, body_top + 0.01)], CAR_LIGHT, 0.006)
    c.circle(x1 - 0.006, body_top + 0.017, 0.007, (255, 236, 140))     # headlight
    c.circle(x0 + 0.005, body_top + 0.017, 0.006, (255, 170, 60))      # rear light
    for (wx) in (x0 + 0.035, x1 - 0.035):
        c.circle(wx, wy, r, TIRE)
        c.circle(wx, wy, r * 0.48, HUB)
        c.circle(wx, wy, r * 0.16, INK)


def render(size, view=(0.5, 0.5, 1.0), simple=False):
    c = Canvas(size, view)
    draw_sky(c)
    draw_sun(c, simple)
    if not simple:
        draw_cloud(c, 0.24, 0.22, 1.0)
        draw_cloud(c, 0.55, 0.1, 0.55)
        draw_hills(c)
    else:
        c.vgradient_poly([(-BIG, 0.6), (BIG, 0.6), (BIG, 0.85), (-BIG, 0.85)], VALLEY_TOP, VALLEY_BOTTOM, 0.6, 0.8)
    draw_water(c, simple)
    draw_bank(c, False, simple)
    draw_bank(c, True, simple)
    draw_deck(c, simple)
    draw_truss(c, simple)
    if not simple:
        draw_car(c)
    return c.img


def rounded_mask(size, radius_frac, oversample=4):
    big = size * oversample
    m = Image.new('L', (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * radius_frac), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def with_round_corners(rgb, radius_frac=0.22):
    out = rgb.convert('RGBA')
    out.putalpha(rounded_mask(rgb.size[0], radius_frac))
    return out


def main():
    preview_dir = None
    if '--preview' in sys.argv:
        i = sys.argv.index('--preview')
        preview_dir = sys.argv[i + 1] if i + 1 < len(sys.argv) else HERE

    full = render(WORK)                                    # motif fills the square
    maskable = render(WORK, view=(0.5, 0.5, 0.8))          # motif inside the 80 % safe zone
    small = render(512, view=(0.5, 0.5, 1.3), simple=True) # bold version for the favicon

    def down(img, s):
        return img.resize((s, s), Image.LANCZOS)

    with_round_corners(down(full, 192)).save(os.path.join(HERE, 'icon-192.png'), optimize=True)
    with_round_corners(down(full, 512)).save(os.path.join(HERE, 'icon-512.png'), optimize=True)
    down(maskable, 512).save(os.path.join(HERE, 'icon-maskable-512.png'), optimize=True)
    down(full, 180).convert('RGB').save(os.path.join(HERE, 'apple-touch-icon.png'), optimize=True)
    with_round_corners(down(small, 32), 0.2).save(os.path.join(HERE, 'favicon-32.png'), optimize=True)

    if preview_dir:
        os.makedirs(preview_dir, exist_ok=True)
        down(full, 1024).save(os.path.join(preview_dir, 'icon-1024-preview.png'))
        down(maskable, 1024).save(os.path.join(preview_dir, 'icon-maskable-1024-preview.png'))
        down(small, 256).save(os.path.join(preview_dir, 'favicon-256-preview.png'))
    print('Icons geschrieben nach', HERE)


if __name__ == '__main__':
    main()

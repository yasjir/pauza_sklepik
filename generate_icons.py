# generate_icons.py — Jednorazowy skrypt do generowania ikon PWA
# Uruchom raz lokalnie: python generate_icons.py
# Wymaga: pip install pillow

from PIL import Image, ImageDraw
import os

os.makedirs('static/icons', exist_ok=True)


def make_icon(size):
    img = Image.new('RGB', (size, size), (255, 107, 53))  # --primary #FF6B35
    draw = ImageDraw.Draw(img)
    s = size
    lw = max(2, size // 32)

    # Koszyk — uchwyt (łuk)
    draw.arc(
        [s * 0.22, s * 0.15, s * 0.55, s * 0.45],
        start=180, end=0,
        fill='white', width=lw
    )
    # Koszyk — korpus
    draw.polygon([
        (s * 0.15, s * 0.42),
        (s * 0.85, s * 0.42),
        (s * 0.74, s * 0.74),
        (s * 0.26, s * 0.74),
    ], fill='white')
    # Kółka
    r = s * 0.07
    cx1, cy = s * 0.36, s * 0.81
    draw.ellipse([cx1 - r, cy - r, cx1 + r, cy + r], fill='white')
    cx2 = s * 0.64
    draw.ellipse([cx2 - r, cy - r, cx2 + r, cy + r], fill='white')

    return img


make_icon(192).save('static/icons/icon-192.png')
make_icon(512).save('static/icons/icon-512.png')
print('OK: static/icons/icon-192.png, static/icons/icon-512.png')

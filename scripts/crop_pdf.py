"""Crop a 3x3 print-and-play PDF into one image per card, in list order.

Usage:
  pip install pillow numpy   (and poppler-utils for pdftoppm)
  python3 scripts/crop_pdf.py path/to/print_and_play.pdf client/public/cards

Card N in the list (1-based) becomes NNN.jpg. The grid is detected from the
non-white area of each page, so other 3x3 PDF exports should work too.
"""
import os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

pdf, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
tmp = tempfile.mkdtemp()
subprocess.run(['pdftoppm', '-r', '150', '-jpeg', '-jpegopt', 'quality=95', pdf, os.path.join(tmp, 'p')], check=True)

def bounds(mask, axis):
    v = mask.mean(axis=axis)
    idx = np.where(v > 0.3)[0]
    return int(idx[0]), int(idx[-1]) + 1

n = 0
for page in sorted(os.listdir(tmp)):
    im = Image.open(os.path.join(tmp, page)).convert('RGB')
    a = np.asarray(im.convert('L')) < 200
    x0, x1 = bounds(a, 0)
    y0, y1 = bounds(a, 1)
    # Partial last page: use the first page's card size.
    if n == 0:
        cw, ch = (x1 - x0) / 3, (y1 - y0) / 3
        gx0, gy0 = x0, y0
    for r in range(3):
        for c in range(3):
            box = (round(gx0 + c * cw) + 2, round(gy0 + r * ch) + 2, round(gx0 + (c + 1) * cw) - 2, round(gy0 + (r + 1) * ch) - 2)
            cell = im.crop(box)
            if (np.asarray(cell.convert('L')) < 200).mean() < 0.2:
                continue  # empty slot
            n += 1
            cell.resize((312, 436), Image.LANCZOS).save(os.path.join(out, f'{n:03d}.jpg'), quality=80, optimize=True)
print(f'{n} cards written to {out}')

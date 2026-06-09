"""Chroma-key + autocrop the raw /office sprites (M14.T11 Phase 4).

Removes the uniform #00b140 green field the generator renders behind each
character, despills green edge halos, autocrops to content, and writes a
square padded PNG to admin/public/office/<name>.png.

`floor-tile` is passed through (resize only — it has no chroma field).

Run with uv (pulls Pillow on the fly):
  uv run --with pillow scripts/key-office-art.py            # all in _raw/
  uv run --with pillow scripts/key-office-art.py char-sales-agent --qa
"""

import sys
from pathlib import Path

from PIL import Image

RAW = Path(__file__).resolve().parent.parent.parent / "admin" / "public" / "office" / "_raw"
OUT = Path(__file__).resolve().parent.parent.parent / "admin" / "public" / "office"
OUT_SIZE = 256  # final square canvas


def is_green(r: int, g: int, b: int) -> bool:
    # Dominant-green test tuned for #00b140-ish screens.
    return g > 80 and g > r * 1.35 and g > b * 1.35


def key_one(name: str, qa: bool = False) -> None:
    src = RAW / f"{name}.png"
    if not src.exists():
        print(f"skip {name}: no raw")
        return
    img = Image.open(src).convert("RGBA")

    if name == "floor-tile":
        img.thumbnail((256, 256), Image.LANCZOS)
        img.save(OUT / f"{name}.png")
        print(f"ok  {name} (floor, passthrough)")
        return

    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_green(r, g, b):
                px[x, y] = (r, g, b, 0)
            elif g > r and g > b:
                # despill: pull green edges toward the max of r/b to kill halo
                ng = min(g, max(r, b) + 12)
                px[x, y] = (r, ng, b, a)

    # autocrop to non-transparent bbox
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)

    # paste centered onto a square transparent canvas with small padding
    side = max(img.size)
    pad = int(side * 0.08)
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(img, ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2), img)
    canvas = canvas.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    canvas.save(OUT / f"{name}.png")
    print(f"ok  {name} ({OUT_SIZE}x{OUT_SIZE})")

    if qa:
        bg = Image.new("RGBA", canvas.size, (255, 0, 255, 255))
        bg.alpha_composite(canvas)
        bg.convert("RGB").save(OUT / f"_qa-{name}.png")
        print(f"    qa -> _qa-{name}.png (over magenta)")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    qa = "--qa" in sys.argv
    names = args if args else [p.stem for p in RAW.glob("*.png")]
    for name in names:
        key_one(name, qa=qa)


if __name__ == "__main__":
    main()

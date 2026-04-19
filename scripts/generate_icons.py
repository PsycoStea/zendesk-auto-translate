#!/usr/bin/env python3
"""
Generate Chrome-extension icons (16 / 48 / 128 px).

Design: a pastel-teal rounded square (matching the in-app language badge
colour) with a bold white "A 文" pair — Latin on the left, CJK on the
right — that reads at a glance as "translate between languages".

The master is rendered at 512x512 and downscaled with LANCZOS for the
smaller sizes; high-res antialiasing + downscale gives cleaner edges
than drawing each size natively.

Run from anywhere:
    python3 scripts/generate_icons.py
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import sys

OUT_DIR = Path(__file__).resolve().parent.parent

BG_COLOR = (160, 231, 229, 255)        # #A0E7E5 — pastel teal
FG_COLOR = (255, 255, 255, 255)        # white text
SHADOW_COLOR = (28, 78, 77, 40)        # soft inner shadow on the square

# System font paths on macOS. Helvetica for Latin, Hiragino for CJK.
# .ttc files are collections — the index argument picks the face.
LATIN_FONT_PATH = "/System/Library/Fonts/Helvetica.ttc"
CJK_FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def pick_face(path: str, preferred_substring: str, fallback_index: int = 0) -> int:
    """
    Scan a .ttc collection and return the index whose font name contains
    `preferred_substring`. Falls back to `fallback_index` if nothing matches.
    """
    try:
        from PIL.ImageFont import TTFont  # noqa
    except Exception:
        pass
    # Pillow has no direct API to list faces; probe up to 16.
    for idx in range(16):
        try:
            f = ImageFont.truetype(path, size=48, index=idx)
            name = (f.getname() or ("", ""))[0]
            if preferred_substring.lower() in name.lower():
                return idx
        except OSError:
            break
        except Exception:
            continue
    return fallback_index


def load_fonts(size: int):
    latin_idx = pick_face(LATIN_FONT_PATH, "Bold")
    cjk_idx = pick_face(CJK_FONT_PATH, "W6") or pick_face(CJK_FONT_PATH, "Bold")
    latin = ImageFont.truetype(LATIN_FONT_PATH, int(size * 0.58), index=latin_idx)
    cjk = ImageFont.truetype(CJK_FONT_PATH, int(size * 0.54), index=cjk_idx)
    return latin, cjk


def render_master(size: int = 512) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-square background.
    radius = int(size * 0.18)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        fill=BG_COLOR,
    )

    # Very subtle inset shadow for a touch of depth — a 1-px darker stroke
    # just inside the rounded boundary. Too much here reads as noise at
    # 16 px, so keep alpha low.
    draw.rounded_rectangle(
        (1, 1, size - 2, size - 2),
        radius=radius - 1,
        outline=SHADOW_COLOR,
        width=max(1, int(size * 0.004)),
    )

    latin_font, cjk_font = load_fonts(size)

    latin_char = "A"
    cjk_char = "文"

    # Measure and place each character in its own half of the canvas.
    lb = draw.textbbox((0, 0), latin_char, font=latin_font)
    cb = draw.textbbox((0, 0), cjk_char, font=cjk_font)
    lw, lh = lb[2] - lb[0], lb[3] - lb[1]
    cw, ch = cb[2] - cb[0], cb[3] - cb[1]

    # Visual tuning: nudge the pair closer to the vertical optical centre
    # (CJK glyphs have different metrics than Latin caps) and pull them
    # slightly toward each other so they read as one paired mark.
    gap = int(size * 0.02)
    total_w = lw + gap + cw
    x_start = (size - total_w) // 2

    lx = x_start - lb[0]
    ly = (size - lh) // 2 - lb[1]
    cx = x_start + lw + gap - cb[0]
    cy = (size - ch) // 2 - cb[1] + int(size * 0.01)  # small baseline nudge

    draw.text((lx, ly), latin_char, font=latin_font, fill=FG_COLOR)
    draw.text((cx, cy), cjk_char, font=cjk_font, fill=FG_COLOR)

    return img


def main() -> int:
    master = render_master(512)

    for target in (16, 48, 128):
        out_path = OUT_DIR / f"icon{target}.png"
        resized = master.resize((target, target), Image.Resampling.LANCZOS)
        resized.save(out_path, optimize=True)
        print(f"wrote {out_path} ({target}x{target})")

    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Generate Chrome-extension icons (16 / 48 / 128 px) in light and dark
mode variants.

Light variant (default): pastel-teal rounded square, white "A 文" pair.
Reads as "translate between languages" at a glance.

Dark variant: deep-teal rounded square, pastel-teal "A 文" pair. Used
in the popup header and as the dark theme_icon for the toolbar.

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

# Light variant — light bg, white text. Pops on light Chrome toolbars.
LIGHT_BG = (160, 231, 229, 255)        # #A0E7E5 — pastel teal
LIGHT_FG = (255, 255, 255, 255)        # white
LIGHT_INSET_SHADOW = (28, 78, 77, 40)  # very subtle inner shadow

# Dark variant — deep-teal bg, pastel-teal text. Pops on dark UIs.
DARK_BG = (13, 79, 77, 255)            # #0D4F4D — deep teal
DARK_FG = (160, 231, 229, 255)         # #A0E7E5 — pastel teal
DARK_INSET_SHADOW = (0, 0, 0, 80)      # slightly stronger shadow on dark

# System font paths on macOS. Helvetica for Latin, Hiragino for CJK.
LATIN_FONT_PATH = "/System/Library/Fonts/Helvetica.ttc"
CJK_FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def pick_face(path: str, preferred_substring: str, fallback_index: int = 0) -> int:
    """
    Scan a .ttc collection and return the index whose font name contains
    `preferred_substring`. Falls back to `fallback_index` if nothing matches.
    """
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


def render_master(size: int, bg, fg, inset_shadow) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-square background.
    radius = int(size * 0.18)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        fill=bg,
    )

    # Subtle inner shadow for a touch of depth.
    draw.rounded_rectangle(
        (1, 1, size - 2, size - 2),
        radius=radius - 1,
        outline=inset_shadow,
        width=max(1, int(size * 0.004)),
    )

    latin_font, cjk_font = load_fonts(size)
    latin_char = "A"
    cjk_char = "文"

    lb = draw.textbbox((0, 0), latin_char, font=latin_font)
    cb = draw.textbbox((0, 0), cjk_char, font=cjk_font)
    lw, lh = lb[2] - lb[0], lb[3] - lb[1]
    cw, ch = cb[2] - cb[0], cb[3] - cb[1]

    gap = int(size * 0.02)
    total_w = lw + gap + cw
    x_start = (size - total_w) // 2

    lx = x_start - lb[0]
    ly = (size - lh) // 2 - lb[1]
    cx = x_start + lw + gap - cb[0]
    cy = (size - ch) // 2 - cb[1] + int(size * 0.01)

    draw.text((lx, ly), latin_char, font=latin_font, fill=fg)
    draw.text((cx, cy), cjk_char, font=cjk_font, fill=fg)

    return img


def render_set(suffix: str, bg, fg, inset_shadow) -> None:
    master = render_master(512, bg, fg, inset_shadow)
    for target in (16, 48, 128):
        out_path = OUT_DIR / f"icon{target}{suffix}.png"
        resized = master.resize((target, target), Image.Resampling.LANCZOS)
        resized.save(out_path, optimize=True)
        print(f"wrote {out_path} ({target}x{target})")


def main() -> int:
    # Light variant: empty suffix so existing references keep working
    # (icon16.png, icon48.png, icon128.png).
    render_set("",      LIGHT_BG, LIGHT_FG, LIGHT_INSET_SHADOW)
    render_set("-dark", DARK_BG,  DARK_FG,  DARK_INSET_SHADOW)
    return 0


if __name__ == "__main__":
    sys.exit(main())

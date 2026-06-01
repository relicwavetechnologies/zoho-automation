#!/usr/bin/env python3
"""
Generates the Divo app icon set at multiple sizes.

Design:
  - Square canvas with rounded-square mask (~22% corner radius — Apple HIG).
  - Layered dark surface (neutral charcoal → near-black) for depth.
  - Thin inner stroke at ~6% alpha for material edge.
  - Stylized "D": vertical bar + half-loop, stroked in near-white with rounded caps.

Outputs (in this dir):
  icon.png, 1024.png, 512.png, 256.png, 128.png, 128x128@2x.png,
  64.png, 32x32.png, 16.png
  divo.iconset/  (intermediate for iconutil)
  icon.icns      (macOS bundle icon, generated via iconutil)
  icon.ico       (Windows icon)
"""
from __future__ import annotations
import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent

# Reference render size — every output downsamples from here so curves stay clean.
REF = 1024

# Colors (sRGB).
SURFACE_TOP    = (28, 28, 30)    # subtle highlight at top
SURFACE_BOTTOM = (12, 12, 14)    # deeper at bottom
INNER_STROKE   = (255, 255, 255) # used with low alpha
GLYPH_COLOR    = (245, 245, 245)
GLYPH_SHADOW   = (0, 0, 0)

# Geometry (all relative to REF).
CORNER_RADIUS_PCT = 0.224   # ~22.4% — Apple-style squircle approximation
PADDING_PCT       = 0.18    # whitespace around the glyph
STROKE_PCT        = 0.105   # D stroke width as % of canvas


def make_rounded_mask(size: int, radius: int) -> Image.Image:
    """Anti-aliased rounded-square alpha mask."""
    upscale = 4
    big = Image.new("L", (size * upscale, size * upscale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * upscale, size * upscale),
        radius=radius * upscale,
        fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def make_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """Vertical gradient."""
    grad = Image.new("RGB", (1, size), 0)
    for y in range(size):
        t = y / max(1, size - 1)
        # ease-in-out so the highlight feels material, not linear
        e = 3 * t * t - 2 * t * t * t
        r = int(top[0] * (1 - e) + bottom[0] * e)
        g = int(top[1] * (1 - e) + bottom[1] * e)
        b = int(top[2] * (1 - e) + bottom[2] * e)
        grad.putpixel((0, y), (r, g, b))
    return grad.resize((size, size), Image.NEAREST)


def draw_d(canvas: Image.Image, size: int) -> None:
    """Draws the stylized D glyph onto canvas (RGBA).

    Geometry:
      - vertical bar at horizontal position `bar_x`
      - half-ellipse loop whose top and bottom endpoints meet the bar exactly
      - loop is drawn as the RIGHT half of an ellipse centered on `bar_x`
    """
    upscale = 3
    s = size * upscale
    glyph = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glyph)

    # Asymmetric padding: more left/top/bottom, looser right so the loop has room.
    pad_l = int(s * 0.22)
    pad_r = int(s * 0.16)
    pad_v = int(s * 0.16)
    stroke = max(2, int(s * STROKE_PCT))

    y0 = pad_v
    y1 = s - pad_v
    height = y1 - y0

    # Bar position — its center is at bar_x; the loop endpoints land here.
    bar_x = pad_l

    # Vertical bar (centered on bar_x via square cap line)
    draw.line([(bar_x, y0), (bar_x, y1)], fill=GLYPH_COLOR, width=stroke)

    # Loop: right half of an ellipse centered at bar_x horizontally, full height.
    # arc(box, -90, 90) traces from top-center clockwise to bottom-center.
    loop_radius = (s - pad_r) - bar_x
    loop_box = (bar_x - loop_radius, y0, bar_x + loop_radius, y1)
    draw.arc(loop_box, start=-90, end=90, fill=GLYPH_COLOR, width=stroke)

    # Endcaps so bar↔loop joins look like rounded miters
    cap_r = stroke // 2
    for cx, cy in ((bar_x, y0), (bar_x, y1)):
        draw.ellipse((cx - cap_r, cy - cap_r, cx + cap_r, cy + cap_r), fill=GLYPH_COLOR)

    # Soft drop-shadow behind the glyph (subtle, for material depth)
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.line([(bar_x, y0), (bar_x, y1)], fill=(0, 0, 0, 130), width=stroke)
    sdraw.arc(loop_box, start=-90, end=90, fill=(0, 0, 0, 130), width=stroke)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=stroke * 0.4))
    shadow = shadow.resize((size, size), Image.LANCZOS)

    glyph = glyph.resize((size, size), Image.LANCZOS)

    canvas.alpha_composite(shadow, dest=(0, int(size * 0.014)))
    canvas.alpha_composite(glyph, dest=(0, 0))


def render(size: int) -> Image.Image:
    """Render the full app icon at `size` px."""
    radius = int(size * CORNER_RADIUS_PCT)
    surface = make_gradient(size, SURFACE_TOP, SURFACE_BOTTOM).convert("RGBA")

    # Inner stroke ring for material edge
    stroke = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stroke)
    sd.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        outline=(*INNER_STROKE, 36),
        width=max(1, size // 256),
    )
    surface.alpha_composite(stroke)

    # Draw D
    draw_d(surface, size)

    # Apply rounded mask so the final image is a clean rounded square
    mask = make_rounded_mask(size, radius)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(surface, (0, 0), mask=mask)
    return out


def save_png(img: Image.Image, name: str) -> None:
    path = OUT / name
    img.save(path, "PNG", optimize=True)
    print(f"  wrote {name} ({img.size[0]}x{img.size[1]})")


def main() -> int:
    print(f"Building Divo icon set in {OUT}")
    base = render(REF)

    # Tauri-required sizes (per tauri.conf.json)
    save_png(base, "icon.png")
    save_png(base.resize((512, 512), Image.LANCZOS), "512.png")
    save_png(base.resize((256, 256), Image.LANCZOS), "128x128@2x.png")
    save_png(base.resize((128, 128), Image.LANCZOS), "128x128.png")
    save_png(base.resize((64, 64), Image.LANCZOS), "64.png")
    save_png(base.resize((32, 32), Image.LANCZOS), "32x32.png")
    save_png(base.resize((16, 16), Image.LANCZOS), "16.png")

    # macOS .iconset for iconutil
    iconset = OUT / "divo.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    macos_sizes = [
        (16,   "icon_16x16.png"),
        (32,   "icon_16x16@2x.png"),
        (32,   "icon_32x32.png"),
        (64,   "icon_32x32@2x.png"),
        (128,  "icon_128x128.png"),
        (256,  "icon_128x128@2x.png"),
        (256,  "icon_256x256.png"),
        (512,  "icon_256x256@2x.png"),
        (512,  "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in macos_sizes:
        img = base if size == REF else base.resize((size, size), Image.LANCZOS)
        img.save(iconset / name, "PNG", optimize=True)

    # Build .icns
    icns_out = OUT / "icon.icns"
    if icns_out.exists():
        icns_out.unlink()
    try:
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_out)],
            check=True,
        )
        print(f"  wrote icon.icns")
    except subprocess.CalledProcessError as e:
        print(f"  iconutil failed: {e}", file=sys.stderr)
        return 1

    # Build .ico (multi-resolution)
    ico_path = OUT / "icon.ico"
    ico_sizes = [(s, s) for s in (256, 128, 64, 48, 32, 16)]
    base.save(ico_path, sizes=ico_sizes)
    print(f"  wrote icon.ico")

    # Cleanup intermediate iconset (icns is the binary blob; keep one PNG copy for debugging)
    shutil.rmtree(iconset)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

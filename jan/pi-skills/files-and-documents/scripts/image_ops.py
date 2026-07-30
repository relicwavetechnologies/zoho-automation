#!/usr/bin/env python3
"""Image inspection, manipulation, and OCR helpers for Divo files-and-documents.

Examples:
    python image_ops.py inspect image.png --json
    python image_ops.py ocr receipt.jpg
    python image_ops.py convert input.jpg output.png --format PNG
    python image_ops.py resize input.png output.png --max-dimension 1600
    python image_ops.py crop input.png crop.png --box 100,200,900,700
    python image_ops.py colors image.png --count 8 --json
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


def inspect_image(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        image.load()
        exif = read_exif_summary(image)
        return {
            "path": str(path),
            "name": path.name,
            "bytes": path.stat().st_size,
            "format": image.format,
            "mime": Image.MIME.get(image.format or "", None),
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "frames": getattr(image, "n_frames", 1),
            "animated": bool(getattr(image, "is_animated", False)),
            "exif": exif,
        }


def read_exif_summary(image: Image.Image) -> dict[str, str]:
    try:
        exif = image.getexif()
    except Exception:
        return {}
    if not exif:
        return {}

    names = {
        271: "make",
        272: "model",
        274: "orientation",
        282: "x_resolution",
        283: "y_resolution",
        306: "datetime",
        315: "artist",
        33432: "copyright",
        36867: "datetime_original",
        40962: "pixel_x_dimension",
        40963: "pixel_y_dimension",
    }
    summary: dict[str, str] = {}
    for tag, name in names.items():
        value = exif.get(tag)
        if value is not None:
            summary[name] = str(value)
    return summary


def save_image(image: Image.Image, output: Path, *, fmt: str | None, quality: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    format_name = (fmt or output.suffix.lstrip(".") or image.format or "PNG").upper()
    if format_name in {"JPG", "JPEG"}:
        format_name = "JPEG"
        if image.mode not in {"RGB", "L"}:
            image = image.convert("RGB")
    elif format_name == "PNG" and image.mode == "P":
        image = image.convert("RGBA")
    image.save(output, format=format_name, quality=quality)


def convert_image(input_path: Path, output_path: Path, *, fmt: str | None, quality: int) -> dict[str, Any]:
    with Image.open(input_path) as image:
        image = ImageOps.exif_transpose(image)
        save_image(image, output_path, fmt=fmt, quality=quality)
    return inspect_image(output_path)


def resize_image(
    input_path: Path,
    output_path: Path,
    *,
    max_dimension: int | None,
    width: int | None,
    height: int | None,
    fmt: str | None,
    quality: int,
) -> dict[str, Any]:
    with Image.open(input_path) as image:
        image = ImageOps.exif_transpose(image)
        if max_dimension:
            image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        elif width or height:
            new_width, new_height = resolve_resize_dimensions(image.width, image.height, width, height)
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        else:
            raise SystemExit("resize requires --max-dimension or --width/--height")
        save_image(image, output_path, fmt=fmt, quality=quality)
    return inspect_image(output_path)


def resolve_resize_dimensions(
    original_width: int,
    original_height: int,
    width: int | None,
    height: int | None,
) -> tuple[int, int]:
    if width and height:
        return width, height
    if width:
        return width, max(1, round(original_height * (width / original_width)))
    if height:
        return max(1, round(original_width * (height / original_height))), height
    return original_width, original_height


def crop_image(
    input_path: Path,
    output_path: Path,
    *,
    box: tuple[int, int, int, int],
    fmt: str | None,
    quality: int,
) -> dict[str, Any]:
    with Image.open(input_path) as image:
        image = ImageOps.exif_transpose(image)
        left, top, right, bottom = box
        if right <= left or bottom <= top:
            raise SystemExit("--box must be left,top,right,bottom with positive width and height")
        if left < 0 or top < 0 or right > image.width or bottom > image.height:
            raise SystemExit(f"--box is outside image bounds {image.width}x{image.height}")
        cropped = image.crop(box)
        save_image(cropped, output_path, fmt=fmt, quality=quality)
    return inspect_image(output_path)


def dominant_colors(path: Path, *, count: int) -> list[dict[str, Any]]:
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGBA")
        image.thumbnail((256, 256), Image.Resampling.LANCZOS)
        pixels = [
            (r, g, b)
            for r, g, b, a in image.getdata()
            if a >= 16
        ]
    if not pixels:
        return []
    quantized = [((r // 16) * 16, (g // 16) * 16, (b // 16) * 16) for r, g, b in pixels]
    total = len(quantized)
    colors = []
    for rgb, n in Counter(quantized).most_common(count):
        colors.append({
            "rgb": list(rgb),
            "hex": "#{:02x}{:02x}{:02x}".format(*rgb),
            "share": round(n / total, 4),
        })
    return colors


def parse_box(raw: str) -> tuple[int, int, int, int]:
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("expected left,top,right,bottom")
    try:
        return tuple(int(part) for part in parts)  # type: ignore[return-value]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("box values must be integers") from exc


def print_result(result: Any, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    if isinstance(result, dict):
        for key, value in result.items():
            print(f"{key}: {value}")
    else:
        for item in result:
            print(item)


def ocr_image(path: Path, *, language: str = "eng") -> dict[str, Any]:
    """Pull text out of an image with Tesseract.

    Reports `text_found` separately from an empty string so a caller can tell
    "this image has no text in it" from "OCR did not run" — answering from the
    filename because OCR quietly returned nothing is the failure this avoids.
    """
    try:
        import pytesseract
    except ImportError as exc:  # pragma: no cover - surfaced to the agent
        raise RuntimeError(
            "pytesseract is not installed. Run: ensure_deps.py image"
        ) from exc

    with Image.open(path) as image:
        image.load()
        try:
            text = pytesseract.image_to_string(image, lang=language)
        except pytesseract.TesseractNotFoundError as exc:
            raise RuntimeError(
                "The tesseract binary is missing from this container. "
                "Say OCR is unavailable rather than guessing at the image."
            ) from exc

    stripped = text.strip()
    return {
        "path": str(path),
        "language": language,
        "text_found": bool(stripped),
        "characters": len(stripped),
        "text": stripped,
    }


def existing_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.exists() or not path.is_file():
        raise argparse.ArgumentTypeError(f"file not found: {raw}")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_p = sub.add_parser("inspect", help="Show image metadata.")
    inspect_p.add_argument("image", type=existing_path)
    inspect_p.add_argument("--json", action="store_true")

    convert_p = sub.add_parser("convert", help="Convert image format.")
    convert_p.add_argument("input", type=existing_path)
    convert_p.add_argument("output", type=Path)
    convert_p.add_argument("--format", dest="fmt")
    convert_p.add_argument("--quality", type=int, default=92)
    convert_p.add_argument("--json", action="store_true")

    resize_p = sub.add_parser("resize", help="Resize an image.")
    resize_p.add_argument("input", type=existing_path)
    resize_p.add_argument("output", type=Path)
    resize_p.add_argument("--max-dimension", type=int)
    resize_p.add_argument("--width", type=int)
    resize_p.add_argument("--height", type=int)
    resize_p.add_argument("--format", dest="fmt")
    resize_p.add_argument("--quality", type=int, default=92)
    resize_p.add_argument("--json", action="store_true")

    crop_p = sub.add_parser("crop", help="Crop an image by pixel box.")
    crop_p.add_argument("input", type=existing_path)
    crop_p.add_argument("output", type=Path)
    crop_p.add_argument("--box", type=parse_box, required=True)
    crop_p.add_argument("--format", dest="fmt")
    crop_p.add_argument("--quality", type=int, default=92)
    crop_p.add_argument("--json", action="store_true")

    ocr_p = sub.add_parser("ocr", help="Extract text from an image with Tesseract.")
    ocr_p.add_argument("image", type=existing_path)
    ocr_p.add_argument("--language", default="eng", help="Tesseract language code.")
    ocr_p.add_argument("--json", action="store_true")

    colors_p = sub.add_parser("colors", help="Extract approximate dominant colors.")
    colors_p.add_argument("image", type=existing_path)
    colors_p.add_argument("--count", type=int, default=8)
    colors_p.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command == "inspect":
        print_result(inspect_image(args.image), as_json=args.json)
    elif args.command == "ocr":
        print_result(ocr_image(args.image, language=args.language), as_json=args.json)
    elif args.command == "convert":
        print_result(convert_image(args.input, args.output, fmt=args.fmt, quality=args.quality), as_json=args.json)
    elif args.command == "resize":
        print_result(
            resize_image(
                args.input,
                args.output,
                max_dimension=args.max_dimension,
                width=args.width,
                height=args.height,
                fmt=args.fmt,
                quality=args.quality,
            ),
            as_json=args.json,
        )
    elif args.command == "crop":
        print_result(crop_image(args.input, args.output, box=args.box, fmt=args.fmt, quality=args.quality), as_json=args.json)
    elif args.command == "colors":
        count = max(1, min(32, args.count))
        print_result(dominant_colors(args.image, count=count), as_json=args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

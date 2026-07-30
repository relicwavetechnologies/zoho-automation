#!/usr/bin/env python3
"""Extract text from documents using pymupdf. Lightweight (~25MB), no models.

Usage:
    python extract_pymupdf.py document.pdf
    python extract_pymupdf.py document.pdf --markdown
    python extract_pymupdf.py document.pdf --pages 0-4
    python extract_pymupdf.py document.pdf --images output_dir/
    python extract_pymupdf.py scan.pdf --render output_dir/
    python extract_pymupdf.py document.pdf --tables
    python extract_pymupdf.py document.pdf --metadata
"""
import sys
import json

def extract_text(path, pages=None):
    import pymupdf
    doc = pymupdf.open(path)
    page_range = range(len(doc)) if pages is None else pages
    for i in page_range:
        if i < len(doc):
            print(f"\n--- Page {i+1}/{len(doc)} ---\n")
            print(doc[i].get_text())

def extract_markdown(path, pages=None):
    import pymupdf4llm
    md = pymupdf4llm.to_markdown(path, pages=pages)
    print(md)

def extract_tables(path):
    import pymupdf
    doc = pymupdf.open(path)
    for i, page in enumerate(doc):
        tables = page.find_tables()
        for j, table in enumerate(tables.tables):
            print(f"\n--- Page {i+1}, Table {j+1} ---\n")
            df = table.to_pandas()
            print(df.to_markdown(index=False))

def extract_images(path, output_dir):
    import pymupdf
    from pathlib import Path
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(path)
    count = 0
    for i, page in enumerate(doc):
        for img_idx, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            pix = pymupdf.Pixmap(doc, xref)
            if pix.n >= 5:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            out_path = f"{output_dir}/page{i+1}_img{img_idx+1}.png"
            pix.save(out_path)
            count += 1
    print(f"Extracted {count} images to {output_dir}/")

def render_pages(path, output_dir, pages=None, dpi=300):
    """Rasterise whole pages to PNG — the scanned-PDF path.

    Distinct from --images, which pulls out images *embedded* in a page. A
    scanned document often has no embedded image to find (the scan is drawn
    into the page), so extracting embedded images returns nothing and OCR
    silently has no input. Rendering always produces a page to read.
    """
    import pymupdf
    from pathlib import Path
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(path)
    page_range = range(len(doc)) if pages is None else pages
    written = []
    for i in page_range:
        if i >= len(doc):
            continue
        pix = doc[i].get_pixmap(dpi=dpi)
        out_path = f"{output_dir}/page-{i + 1}.png"
        pix.save(out_path)
        written.append(out_path)
    print(f"Rendered {len(written)} page(s) at {dpi}dpi to {output_dir}/")
    for out_path in written:
        print(out_path)


def show_metadata(path):
    import pymupdf
    doc = pymupdf.open(path)
    print(json.dumps({
        "pages": len(doc),
        "title": doc.metadata.get("title", ""),
        "author": doc.metadata.get("author", ""),
        "subject": doc.metadata.get("subject", ""),
        "creator": doc.metadata.get("creator", ""),
        "producer": doc.metadata.get("producer", ""),
        "format": doc.metadata.get("format", ""),
    }, indent=2))

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] in {"-h", "--help"}:
        print(__doc__)
        sys.exit(0)

    path = args[0]
    pages = None

    if "--pages" in args:
        idx = args.index("--pages")
        p = args[idx + 1]
        if "-" in p:
            start, end = p.split("-")
            pages = list(range(int(start), int(end) + 1))
        else:
            pages = [int(p)]

    if "--metadata" in args:
        show_metadata(path)
    elif "--tables" in args:
        extract_tables(path)
    elif "--render" in args:
        idx = args.index("--render")
        output_dir = args[idx + 1] if idx + 1 < len(args) else "./pages"
        dpi = 300
        if "--dpi" in args:
            dpi = int(args[args.index("--dpi") + 1])
        render_pages(path, output_dir, pages=pages, dpi=dpi)
    elif "--images" in args:
        idx = args.index("--images")
        output_dir = args[idx + 1] if idx + 1 < len(args) else "./images"
        extract_images(path, output_dir)
    elif "--markdown" in args:
        extract_markdown(path, pages=pages)
    else:
        extract_text(path, pages=pages)

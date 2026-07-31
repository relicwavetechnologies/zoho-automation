# Divo Dex logo

The Cut D mark is a monoline capital D sliced by a clean 45-degree diagonal:

- **Divo** — the capital D anchors the product name.
- **Dex** — the cut is the signature gesture, separating the mark into two precise pieces.
- **Clarity at size** — the small-size variant keeps the cut open in menu bars and favicons.

## Files

- `divo-dex-cut-d.svg` is the transparent primary mark. It uses `currentColor` and is intended for sizes at or above 20 px.
- `divo-dex-cut-d-small.svg` is the heavier small-size variant for compact UI.
- `divo-dex-appicon.svg` is the dark desktop application icon source.
- `divo-dex-app-icon-1024.png` is the high-resolution raster master used to generate platform icons.
- `platform-icons/` contains the checked-in generated desktop and mobile icons.

When changing the app icon, regenerate from the raster master with `yarn build:icon`, then replace `platform-icons/` with the generated `src-tauri/icons/` directory. This keeps every platform export aligned with the same mark.

Keep clear space around the mark equal to at least one stroke width. Preserve the flat 45-degree cut ends; they are the defining detail.

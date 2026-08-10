# files-and-documents — bundled helper scripts

Not a skill. This directory is deliberately absent from `trustedSkills`, so Pi
never discovers or auto-loads it.

File-handling *capability* lives in the skill registry as the DB rows
`read-understand-files` and `create-edit-files`. Pi discovers those rows as
native skills and reads their `SKILL.md` files when relevant. They carry the
instructions and name the commands below.

What lives here is only what a DB row cannot hold: executable assets. They are
reachable in the container at:

    $DIVO_BUNDLED_SKILLS_DIR/files-and-documents/scripts/

- `ensure_deps.py` — builds a per-tier virtualenv under `DIVO_HOME`, which sits
  on the user's persistent volume, so a tier installs once per user and is
  instant afterwards. Tiers: `light`, `office`, `image`, `dataset`.
- `extract_pymupdf.py` — PDF text, markdown, tables, metadata, embedded images
  (`--images`), and whole-page rasterisation for scans (`--render`).
- `image_ops.py` — `inspect`, `convert`, `resize`, `crop`, `colors`, and `ocr`
  via Tesseract.

If you add a script here, document it in the DB skill markdown as well —
otherwise the agent has no way to learn it exists.

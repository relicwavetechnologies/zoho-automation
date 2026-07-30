/**
 * The container's bundled file-handling scripts, as the skills describe them.
 *
 * Several skills need to tell the agent how to install a dependency tier, and
 * they must not each write their own version of that instruction: two copies
 * drift, and the model then gets two slightly different commands for the same
 * job with no way to tell which is current. This module is the single wording.
 *
 * The scripts themselves live in the runtime image under
 * `divo/skills/files-and-documents/scripts/`, deliberately outside Pi's
 * `trustedSkills` so they are reachable as assets but never auto-loaded as a
 * skill. Capabilities are DB rows, reached router-first.
 */

/** Where the bundled helper scripts sit inside the runtime container. */
export const SCRIPTS = '$DIVO_BUNDLED_SKILLS_DIR/files-and-documents/scripts';

export const DEPENDENCY_TIERS = `## Dependencies install on demand

Nothing is preinstalled. Each tier builds a virtualenv under \`DIVO_HOME\`,
which sits on the user's persistent volume — so a tier installs once per user
and is instant on every later run. Install the smallest tier that does the job;
tiers do not include each other.

\`\`\`bash
python3 ${SCRIPTS}/ensure_deps.py light      # PDF and text
python3 ${SCRIPTS}/ensure_deps.py office     # Word, PowerPoint, Excel
python3 ${SCRIPTS}/ensure_deps.py image      # image inspection and OCR
python3 ${SCRIPTS}/ensure_deps.py dataset    # CSV/Parquet/JSON too large for context
\`\`\`

Run a helper through the managed interpreter in one command:

\`\`\`bash
python3 ${SCRIPTS}/ensure_deps.py light --quiet -- ${SCRIPTS}/extract_pymupdf.py report.pdf --markdown
\`\`\`

Print the interpreter path with \`--python\` when you need to run your own
script under it, so the packages you installed are the ones it imports.`;

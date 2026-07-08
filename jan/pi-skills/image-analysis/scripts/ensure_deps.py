#!/usr/bin/env python3
"""Ensure image-analysis skill dependencies in a Divo-managed virtualenv.

Examples:
    python3 ensure_deps.py light
    python3 ensure_deps.py light --quiet -- scripts/image_ops.py inspect image.png --json
    python3 ensure_deps.py light --python
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import venv
from pathlib import Path


FEATURES = {
    "light": {
        "description": "Image metadata and manipulation",
        "packages": ("Pillow",),
        "imports": ("PIL",),
    },
}


def main() -> int:
    parser_args, command = split_command(sys.argv[1:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feature", choices=sorted(FEATURES))
    parser.add_argument("--check-only", action="store_true", help="Report readiness without installing.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable status.")
    parser.add_argument("--python", action="store_true", help="Print the managed Python path only.")
    parser.add_argument("--quiet", action="store_true", help="Print only the child command output.")
    args = parser.parse_args(parser_args)

    skill_dir = Path(__file__).resolve().parent.parent
    venv_dir = divo_home() / "venvs" / "skills" / "image-analysis" / args.feature
    python = venv_python(venv_dir)

    if args.python:
        print(python)
        return 0

    payload = ensure_feature(args.feature, venv_dir, python, check_only=args.check_only)
    if args.json:
        print(json.dumps(payload, indent=2))
    elif not args.quiet:
        print_human_status(payload)

    if not payload["ready"]:
        return 1
    if command:
        sys.stdout.flush()
        return run_with_managed_python(python, skill_dir, command)
    return 0


def divo_home() -> Path:
    raw = os.environ.get("DIVO_HOME", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".divo").resolve()


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def split_command(argv: list[str]) -> tuple[list[str], list[str]]:
    if "--" not in argv:
        return argv, []
    idx = argv.index("--")
    return argv[:idx], argv[idx + 1:]


def ensure_feature(feature: str, venv_dir: Path, python: Path, *, check_only: bool) -> dict:
    spec = FEATURES[feature]
    venv_dir.mkdir(parents=True, exist_ok=True)

    created = False
    if not python.exists():
        if check_only:
            return status(feature, venv_dir, python, ready=False, missing=spec["imports"], created=False)
        venv.EnvBuilder(with_pip=True, clear=False, symlinks=os.name != "nt").create(venv_dir)
        created = True

    missing = missing_imports(python, spec["imports"])
    if missing and not check_only:
        install_packages(python, tuple(spec["packages"]))
        missing = missing_imports(python, spec["imports"])

    return status(feature, venv_dir, python, ready=not missing, missing=missing, created=created)


def missing_imports(python: Path, imports: tuple[str, ...]) -> tuple[str, ...]:
    probe = (
        "import importlib.util, json; "
        f"mods={list(imports)!r}; "
        "print(json.dumps([m for m in mods if importlib.util.find_spec(m) is None]))"
    )
    result = subprocess.run(
        [str(python), "-c", probe],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        return imports
    try:
        parsed = json.loads(result.stdout.strip() or "[]")
    except json.JSONDecodeError:
        return imports
    return tuple(item for item in parsed if isinstance(item, str))


def install_packages(python: Path, packages: tuple[str, ...]) -> None:
    subprocess.run([str(python), "-m", "pip", "install", *packages], check=True)


def status(
    feature: str,
    venv_dir: Path,
    python: Path,
    *,
    ready: bool,
    missing: tuple[str, ...],
    created: bool,
) -> dict:
    spec = FEATURES[feature]
    return {
        "feature": feature,
        "description": spec["description"],
        "ready": ready,
        "created": created,
        "venv": str(venv_dir),
        "python": str(python),
        "missing": list(missing),
    }


def print_human_status(payload: dict) -> None:
    state = "ready" if payload["ready"] else "missing dependencies"
    print(f"Divo image environment: {payload['feature']} is {state}")
    print(f"python: {payload['python']}")
    if payload["missing"]:
        print("missing imports: " + ", ".join(payload["missing"]))


def run_with_managed_python(python: Path, skill_dir: Path, command: list[str]) -> int:
    program = Path(command[0])
    if not program.is_absolute():
        program = (skill_dir / program).resolve()
    child_env = os.environ.copy()
    child_env["DIVO_IMAGE_PYTHON"] = str(python)
    child_env["DIVO_IMAGE_SKILL_DIR"] = str(skill_dir)
    result = subprocess.run([str(python), str(program), *command[1:]], env=child_env)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())

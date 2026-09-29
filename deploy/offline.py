"""Build and verify a self-contained Docker deployment bundle (Python stdlib only)."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGES = (
    "postgres:16.10-alpine",
    "arm112-api:0.1.0",
    "arm112-web:0.1.0",
    "arm112-backup:0.1.0",
    "arm112-llm:0.1.0",
)
LLM_SOURCE = (
    "ghcr.io/ggml-org/llama.cpp:server@sha256:"
    "9dc0a0f4080b7817c9592b19c03a4f4b0be92fd701076b9da259ff941dc5bf91"
)


def run(*args: str, output: Path | None = None) -> str:
    if output is None:
        return subprocess.check_output(args, text=True).strip()
    with output.open("wb") as stream:
        subprocess.run(args, check=True, stdout=stream)
    return ""


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def inventory(folder: Path) -> list[dict[str, str | int]]:
    result = []
    for path in sorted(folder.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symlink in bundle: {path}")
        if path.is_file() and path.name != "manifest.json":
            result.append(
                {
                    "path": path.relative_to(folder).as_posix(),
                    "size": path.stat().st_size,
                    "sha256": digest(path),
                }
            )
    return result


def verify(folder: Path) -> dict:
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    expected = manifest["files"]
    actual = inventory(folder)
    if actual != expected:
        raise ValueError("Bundle inventory/hash mismatch; missing, extra or changed file")
    if manifest.get("format") != "arm112-offline-v1":
        raise ValueError("Unknown bundle format")
    return manifest


def create(args: argparse.Namespace) -> None:
    target = args.output.resolve()
    if target.exists():
        raise ValueError("Output must be a new directory")
    model = args.model.resolve()
    if not model.is_file() or model.stat().st_size == 0:
        raise ValueError("Provide a nonempty local GGUF file")
    with model.open("rb") as stream:
        if stream.read(4) != b"GGUF":
            raise ValueError("Model file does not have GGUF magic bytes")
    if not args.model_source or not args.model_license:
        raise ValueError("Record model source and license")
    if not (ROOT / "data" / "streets.csv.gz").is_file():
        raise ValueError("Required data/streets.csv.gz dictionary is missing")
    voices = json.loads((ROOT / "data" / "voices" / "manifest.json").read_text(encoding="utf-8"))
    if voices.get("status") != "ready" or not voices.get("profiles"):
        raise ValueError("Voice manifest is pending or empty")
    voice_files = []
    for profile in voices["profiles"]:
        if profile.get("status") != "ready" or not profile.get("files"):
            raise ValueError(f"Voice profile is not ready: {profile.get('id')}")
        for entry in profile["files"]:
            name = entry if isinstance(entry, str) else entry.get("path")
            if not isinstance(name, str):
                raise ValueError(f"Invalid voice file entry: {entry}")
            path = (ROOT / "data" / "voices" / name).resolve()
            if not path.is_relative_to(ROOT / "data" / "voices") or not path.is_file():
                raise ValueError(f"Missing or unsafe voice file: {name}")
            voice_files.append(path)
    if run("git", "-C", str(ROOT), "status", "--porcelain"):
        raise ValueError("Commit source and deployment changes before creating the bundle")
    subprocess.run(
        (
            "docker",
            "compose",
            "-f",
            str(ROOT / "deploy" / "docker-compose.yml"),
            "build",
            "api",
            "web",
            "backup",
        ),
        check=True,
    )
    run("docker", "image", "inspect", "--format", "{{.Id}}", LLM_SOURCE)
    subprocess.run(("docker", "tag", LLM_SOURCE, "arm112-llm:0.1.0"), check=True)
    target.mkdir(parents=True)
    try:
        shutil.copytree(
            ROOT / "deploy",
            target / "deploy",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        shutil.copy2(ROOT / "compose.yaml", target / "compose.yaml")
        shutil.copy2(ROOT / ".env.example", target / ".env.example")
        model_target = target / "models" / "qwen3-4b-instruct-2507-q4_k_m.gguf"
        model_target.parent.mkdir()
        shutil.copy2(model, model_target)
        (target / "backups").mkdir()
        image_dir = target / "images"
        image_dir.mkdir()
        image_ids = {}
        for index, image in enumerate(IMAGES):
            image_ids[image] = run("docker", "image", "inspect", "--format", "{{.Id}}", image)
            run("docker", "save", image, output=image_dir / f"{index:02d}.tar")
        (target / "IMAGES.txt").write_text(
            "".join(f"{image} {image_id}\n" for image, image_id in image_ids.items()),
            encoding="ascii",
        )
        checksum_lines = []
        for path in sorted(target.rglob("*")):
            if path.is_file():
                checksum_lines.append(f"{digest(path)}  {path.relative_to(target).as_posix()}")
        (target / "SHA256SUMS").write_text("\n".join(checksum_lines) + "\n", encoding="ascii")
        manifest = {
            "format": "arm112-offline-v1",
            "created_utc": datetime.now(UTC).isoformat(),
            "git_commit": run("git", "-C", str(ROOT), "rev-parse", "HEAD"),
            "images": image_ids,
            "llm_source": LLM_SOURCE,
            "source_assets": {
                path.relative_to(ROOT).as_posix(): digest(path)
                for path in [ROOT / "data" / "streets.csv.gz", *voice_files]
            },
            "model": {
                "path": model_target.relative_to(target).as_posix(),
                "source": args.model_source,
                "license": args.model_license,
            },
            "files": inventory(target),
        }
        (target / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        verify(target)
    except BaseException:
        shutil.rmtree(target)
        raise
    print(f"Bundle verified: {target}")


def load(folder: Path) -> None:
    manifest = verify(folder)
    for index, (image, image_id) in enumerate(manifest["images"].items()):
        subprocess.run(
            ("docker", "load", "-i", str(folder / "images" / f"{index:02d}.tar")), check=True
        )
        loaded_id = run("docker", "image", "inspect", "--format", "{{.Id}}", image)
        if loaded_id != image_id:
            raise ValueError(f"Image ID mismatch after load: {image}")
    print("Images loaded and IDs checked")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("create")
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--model", type=Path, required=True)
    build.add_argument("--model-source", required=True)
    build.add_argument("--model-license", required=True)
    for command in ("verify", "load"):
        sub = commands.add_parser(command)
        sub.add_argument("bundle", type=Path)
    args = parser.parse_args()
    if args.command == "create":
        create(args)
    elif args.command == "verify":
        verify(args.bundle.resolve())
        print("Bundle verified")
    else:
        load(args.bundle.resolve())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Offline bundle error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

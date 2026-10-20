"""Ревизии Alembic уникальны, legacy-совместимость идёт после опубликованной 0025."""

import ast
from collections import defaultdict
from pathlib import Path

VERSIONS = Path(__file__).resolve().parents[1] / "migrations" / "versions"


def test_migration_chain_has_unique_revisions_and_one_head():
    files_by_revision = defaultdict(list)
    parents = {}
    for path in sorted(VERSIONS.glob("*.py")):
        values = {
            target.id: ast.literal_eval(node.value)
            for node in ast.parse(path.read_text()).body
            if isinstance(node, ast.Assign)
            for target in node.targets
            if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}
        }
        if "revision" not in values:
            continue
        revision = values["revision"]
        files_by_revision[revision].append(path.name)
        parents[revision] = values["down_revision"]

    duplicates = {key: paths for key, paths in files_by_revision.items() if len(paths) > 1}
    assert not duplicates, f"Повторные ревизии Alembic: {duplicates}"
    assert files_by_revision["0025"] == ["0025_russian_service_names.py"]
    assert files_by_revision["0026"] == ["0026_legacy_brigade_dispatch.py"]
    assert files_by_revision["0027"] == ["0027_draft_deletion_and_stop.py"]
    assert files_by_revision["0028"] == ["0028_pack_created_at.py"]
    # Бригада называется своим номером (капитан, 19.10) — после ветки генератора.
    assert files_by_revision["0029"] == ["0029_brigade_names.py"]
    assert parents["0029"] == "0028"
    assert parents["0028"] == "0027"
    assert parents["0027"] == "0026"
    assert parents["0026"] == "0025"
    assert parents["0025"] == "0024"
    assert files_by_revision["0030"] == ["0030_job_error_reads.py"]
    assert parents["0030"] == "0029"
    assert set(parents.values()) - {None} <= parents.keys()
    assert set(parents) - set(parents.values()) == {"0030"}

    # Единственной головы недостаточно: отдельный замкнутый цикл не должен потеряться.
    visited = set()
    revision = "0030"
    while revision is not None:
        assert revision not in visited, f"Цикл миграций: {revision}"
        visited.add(revision)
        revision = parents[revision]
    assert visited == parents.keys()

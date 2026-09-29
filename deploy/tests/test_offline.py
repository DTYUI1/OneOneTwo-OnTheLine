import json

import pytest

from deploy.offline import inventory, verify


def test_bundle_detects_changed_and_extra_files(tmp_path):
    payload = tmp_path / "models" / "model.gguf"
    payload.parent.mkdir()
    payload.write_bytes(b"model bytes")
    manifest = {"format": "arm112-offline-v1", "files": inventory(tmp_path)}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    assert verify(tmp_path) == manifest
    payload.write_bytes(b"changed bytes")
    with pytest.raises(ValueError, match="inventory/hash mismatch"):
        verify(tmp_path)

    payload.write_bytes(b"model bytes")
    (tmp_path / "unexpected.txt").write_text("unexpected", encoding="utf-8")
    with pytest.raises(ValueError, match="inventory/hash mismatch"):
        verify(tmp_path)

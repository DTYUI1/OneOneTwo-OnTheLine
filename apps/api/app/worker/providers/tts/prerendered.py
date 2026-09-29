import json
from pathlib import Path


class PrerenderedTTS:
    name = "prerendered"

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir.resolve()

    async def resolve(self, voice_profile: str, phrase_id: str) -> tuple[str, int]:
        manifest_path = self.data_dir / "voices" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for profile in manifest["profiles"]:
            if profile["id"] != voice_profile:
                continue
            for item in profile["files"]:
                if item["phrase_id"] != phrase_id:
                    continue
                path = (self.data_dir / item["path"]).resolve()
                if not path.is_relative_to(self.data_dir) or not path.is_file():
                    raise ValueError("Пре-рендерированная реплика отсутствует.")
                return path.relative_to(self.data_dir).as_posix(), int(item["duration_ms"])
        raise ValueError("Пре-рендерированная реплика отсутствует.")

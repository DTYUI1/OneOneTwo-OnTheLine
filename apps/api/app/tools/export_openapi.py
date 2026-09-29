import argparse
import json

from app.api.database import create_database_app
from app.core.config import ROOT, Settings

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "contracts/openapi.json"
    app = create_database_app(Settings(api_mode="database"))
    content = json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not target.exists() or target.read_text(encoding="utf-8") != content:
            raise SystemExit(
                "OpenAPI устарел. Запустите "
                "uv run --package arm112-api python -m app.tools.export_openapi"
            )
    else:
        target.write_text(content, encoding="utf-8")

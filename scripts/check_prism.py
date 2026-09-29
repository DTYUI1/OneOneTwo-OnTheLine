"""Проверка реальных ответов запущенного Prism на каждом GET из контракта."""

import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker


def check(base_url: str) -> None:
    root = Path(__file__).resolve().parents[1]
    spec = yaml.safe_load((root / "contracts/openapi.draft.yaml").read_text(encoding="utf-8"))
    for path, methods in spec["paths"].items():
        if "get" not in methods:
            continue
        operation = methods["get"]
        route = path
        query = {}
        for parameter in operation.get("parameters", []):
            if parameter["in"] == "path":
                route = route.replace(
                    "{" + parameter["name"] + "}", "00000000-0000-4000-8000-000000000001"
                )
            if parameter["in"] == "query" and parameter.get("required"):
                query[parameter["name"]] = "1"
        if query:
            route += "?" + urllib.parse.urlencode(query)
        # Prism проверяет статические формы; C-01 не объявляет pending GET реализованным.
        code = "501" if operation.get("x-implementation-status") == "contract-ready" else "200"
        request = urllib.request.Request(
            base_url + route,
            headers={"Cookie": "session=prism-example", "Prefer": f"code={code}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status, body = response.status, response.read()
        except urllib.error.HTTPError as exc:
            status, body = exc.code, exc.read()
        if status != int(code):
            raise ValueError(f"Prism {route}: ожидался {code}, получен {status}")
        content = operation["responses"][code]["content"]
        if "application/json" in content:
            Draft202012Validator(
                {"components": spec["components"], **content["application/json"]["schema"]},
                format_checker=FormatChecker(),
            ).validate(json.loads(body))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:4010")
    check(parser.parse_args().base_url)

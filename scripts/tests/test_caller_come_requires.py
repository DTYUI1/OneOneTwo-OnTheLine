"""Внутренние prerequisites сюжета не могут ссылаться на неизвестные сведения."""

import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "caller_web", Path(__file__).parents[1] / "voices/bank/web.py"
)
assert SPEC and SPEC.loader
web = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(web)


@pytest.mark.parametrize("invalid", [[], "where", ["missing"], ["where", "where"], [1], ["who"]])
def test_invalid_come_requires(monkeypatch, invalid):
    tables = web.caller_plots()
    tables["pipe_access"]["come_requires"] = invalid
    monkeypatch.setattr(web, "caller_plots", lambda: tables)
    assert any("come_requires" in problem for problem in web.caller_plot_problems())


def test_real_come_requires():
    assert not web.caller_plot_problems()

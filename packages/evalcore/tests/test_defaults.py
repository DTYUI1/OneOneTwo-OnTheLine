"""Настройки оценщика объявлены в defaults; прежние импорты потребителей сохранены."""

import ast
import inspect

import pytest
from evalcore import brigade, comment, criteria, defaults


@pytest.mark.parametrize(
    ("name", "consumer", "expected"),
    [
        ("SERVICE_ARRIVAL_S", brigade, 20.0),
        ("AHEAD_BRANCHES", brigade, ("already", "surprise")),
        ("NO_REFUSAL_SERVICES", criteria, frozenset({"103"})),
        ("CARD_REPORT_EXT", criteria, "112"),
        ("_CASE_TYPE_MIN", comment, 5),
    ],
)
def test_tuning_constants_live_in_defaults(name, consumer, expected):
    assert hasattr(defaults, name), f"{name} должна быть объявлена в defaults.py"
    assert getattr(defaults, name) == expected
    # API ещё импортирует время приезда из brigade; переезд не ломает этот стык.
    assert getattr(consumer, name) is getattr(defaults, name)
    assignments = {
        node.id
        for statement in ast.parse(inspect.getsource(consumer)).body
        if isinstance(statement, ast.Assign | ast.AnnAssign)
        for node in ast.walk(statement)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)
    }
    assert name not in assignments, f"{name} не должна дублироваться в {consumer.__name__}"

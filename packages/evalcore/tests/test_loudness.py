"""Громкость голосового доклада: тихо, в норме, громко."""

import pytest
from evalcore.loudness import loudness_verdict


@pytest.mark.parametrize(
    ("dbfs", "clipped", "expected"),
    [
        (-25.0, 0.0, "ok"),
        (-40.0, 0.0, "ok"),
        (-45.0, 0.0, "quiet"),
        (-10.0, 0.0, "ok"),
        (-8.0, 0.0, "loud"),
        # Перегруз — громко, даже если средний уровень обычный: хрип в трубке.
        (-20.0, 0.02, "loud"),
    ],
)
def test_verdict_by_level_and_clipping(dbfs, clipped, expected):
    assert loudness_verdict(dbfs, clipped) == expected

from pkg.config import rate


def test_rate():
    assert rate() == 3

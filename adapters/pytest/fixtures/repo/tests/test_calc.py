from pkg.calc import add, mul


def test_add():
    assert add(1, 2) == 3


def test_mul():
    assert mul(2, 3) == 6

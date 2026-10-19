import pytest

from pkg.calc import add, clamp, mul


def test_add():
    assert add(1, 2) == 3


def test_add_again():
    assert add(2, 2) == 4


def test_add_strings():
    assert add("a", "b") == "ab"


def test_mul():
    assert mul(2, 3) == 6


def test_clamp():
    assert clamp(5, 0, 3) == 3
    assert clamp(-1, 0, 3) == 0
    assert clamp(2, 0, 3) == 2


def test_clamp_rejects_none():
    with pytest.raises(TypeError):
        clamp(None, 0, 3)

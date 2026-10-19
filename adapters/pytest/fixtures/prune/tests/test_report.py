from pkg.report import total
from tests.helpers import assert_total


def test_total():
    assert total([1, 2, 3]) == 6


def test_total_helper():
    assert_total([4, 5], 9)

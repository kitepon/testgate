from pkg.report import total


def assert_total(values, expected):
    assert total(values) == expected

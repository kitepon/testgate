from pkg.calc import add


def total(values):
    result = 0
    for v in values:
        result = add(result, v)
    return result

from pkg.solo import greet


def test_greet():
    assert greet("mana") == "hello, mana"

import json
from pathlib import Path


def rate():
    return json.loads((Path(__file__).parent / "settings.json").read_text())["rate"]

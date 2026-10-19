"""testgate prune 用の pytest プラグイン。プロジェクトの python（pytest が入っている物）へ `-p testgate_prune_plugin` で読み込む。

試験ごとの結果を JSONL（環境変数 TG_PRUNE_OUT）へ追記する。kill されても途中までは残る。
kind（狙い／前提）はここでは決めない。判定に要る事実（例外の型の継承、最後の frame の位置、失敗文）だけを残し、
判定は prune.mjs の classifyKind が行う。

環境変数:
  TG_PRUNE_OUT           結果の JSONL（必須）
  TG_PRUNE_TEST_TIMEOUT  試験 1 本（setup・call・teardown それぞれ）の上限、秒。無ければ上限なし（SIGALRM の無い OS でも上限なし）
  TG_PRUNE_EXCLUDE       除外する試験の glob の JSON 配列。nodeid・ファイル path・試験名のどれかに一致したら外す
"""
import fnmatch
import json
import os
import signal
import threading

import pytest

OUT = os.environ.get("TG_PRUNE_OUT")
ROOT = os.getcwd()
try:
    TEST_TIMEOUT = float(os.environ.get("TG_PRUNE_TEST_TIMEOUT") or 0)
except ValueError:
    TEST_TIMEOUT = 0
try:
    EXCLUDE = [str(g) for g in json.loads(os.environ.get("TG_PRUNE_EXCLUDE") or "[]")]
except ValueError:
    EXCLUDE = []
MAX_ERROR = 4000


class TestgateTestTimeout(Exception):
    """試験 1 本の上限を超えた。"""

    __test__ = False


def _is_worker(config):
    return hasattr(config, "workerinput")  # pytest-xdist の worker。結果は controller 側で書く


def _write(rec):
    if not OUT:
        return
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _posix(path):
    p = str(path).replace("\\", "/")
    root = ROOT.replace("\\", "/").rstrip("/") + "/"
    return p[len(root):] if p.startswith(root) else p


def _frames(longrepr):
    """表示された frame（pytest が隠した物を除く）を、例外の発生位置から外へ向かう順で返す。"""
    entries = getattr(getattr(longrepr, "reprtraceback", None), "reprentries", None) or []
    out = []
    for e in entries:
        loc = getattr(e, "reprfileloc", None)
        if loc is None:
            continue
        out.append({"path": _posix(loc.path), "line": int(loc.lineno)})
    out.reverse()
    return out


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    exc = call.excinfo
    if not rep.failed or exc is None:
        return
    try:
        message = exc.exconly()
    except Exception:  # noqa: BLE001
        message = repr(exc.value)
    facts = {
        "types": [c.__name__ for c in exc.type.__mro__ if c is not object],
        "message": message,
        "frames": _frames(rep.longrepr),
    }
    # user_properties は setup・call・teardown の報告で同じ list を共有するので、写しに足す
    rep.user_properties = list(rep.user_properties) + [("tg_facts", json.dumps(facts, ensure_ascii=False))]


def _facts_of(report):
    for k, v in report.user_properties:
        if k == "tg_facts":
            try:
                return json.loads(v)
            except ValueError:
                break
    text = getattr(report, "longreprtext", "") or str(getattr(report, "longrepr", ""))
    return {"types": [], "message": text.strip().split("\n")[-1] if text.strip() else "", "frames": []}


_CONFIG = [None]


def pytest_configure(config):
    _CONFIG[0] = config
    config._tg_prune_worker = _is_worker(config)


def pytest_runtest_logreport(report):
    cfg = _CONFIG[0]
    if cfg is not None and getattr(cfg, "_tg_prune_worker", False):
        return
    if report.when == "call" or report.outcome != "passed":
        rec = {
            "t": "r", "id": report.nodeid, "when": report.when, "outcome": report.outcome,
            "file": _posix(report.location[0]), "line": report.location[1] + 1 if isinstance(report.location[1], int) else None,
            "dur": round(getattr(report, "duration", 0) or 0, 4),
        }
        if report.failed:
            rec.update(_facts_of(report))
            rec["message"] = (rec.get("message") or "")[:MAX_ERROR]
        _write(rec)


def pytest_collectreport(report):
    cfg = _CONFIG[0]
    if cfg is not None and getattr(cfg, "_tg_prune_worker", False):
        return
    if report.failed:
        text = getattr(report, "longreprtext", "") or str(report.longrepr)
        _write({"t": "c", "id": report.nodeid, "message": text[-MAX_ERROR:], "types": ["CollectError"], "frames": []})


def pytest_sessionfinish(session, exitstatus):
    if _is_worker(session.config):
        return
    _write({"t": "end", "exit": int(exitstatus)})


def pytest_collection_modifyitems(config, items):
    if not EXCLUDE:
        return
    keep, dropped = [], []
    for it in items:
        names = (it.nodeid, _posix(str(getattr(it, "path", "") or it.fspath)), it.name)
        (dropped if any(fnmatch.fnmatchcase(n, g) for n in names for g in EXCLUDE) else keep).append(it)
    if dropped:
        if not _is_worker(config):
            for it in dropped:
                _write({"t": "x", "id": it.nodeid})
        config.hook.pytest_deselected(items=dropped)
        items[:] = keep


# ---- 試験 1 本の上限 ----

def _alarm_ok():
    return TEST_TIMEOUT > 0 and hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread()


def _timed(phase):
    @pytest.hookimpl(hookwrapper=True, tryfirst=True)
    def hook(item):
        if not _alarm_ok():
            yield
            return

        def on_alarm(signum, frame):
            raise TestgateTestTimeout(f"{phase} が {TEST_TIMEOUT:g} 秒を超えた")

        old = signal.signal(signal.SIGALRM, on_alarm)
        signal.setitimer(signal.ITIMER_REAL, TEST_TIMEOUT)
        try:
            yield
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)

    hook.__name__ = f"pytest_runtest_{phase}"
    return hook


pytest_runtest_setup = _timed("setup")
pytest_runtest_call = _timed("call")
pytest_runtest_teardown = _timed("teardown")

"""testgate prune（pytest）の Python 側の道具。cosmic-ray（変異の列挙と適用）を使い、試験は自前で流す。

道具の venv の python で動かす（cosmic-ray 8.7.0 の内部 API を使うので版を固定している）。標準入力は使わず、引数は JSON ファイル。

  enumerate CFG   変異を全部列挙して CFG.out へ JSON で書く
  run CFG         選んだ変異を 1 件ずつ適用して pytest を流し、結果を CFG.out へ JSONL で 1 件ずつ追記する

cosmic-ray の `exec` を使わない理由: 変異ごとの出力が 1 つの文字列にしか残らず、落ちた試験を全部は取れない
（契約の killedBy の要件）。mutmut 3 は最初の失敗で止め、記録も試験ごとではない。
"""
import json
import os
import queue
import random
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import parso.utils

from cosmic_ray.commands.init import _all_work_items
from cosmic_ray.mutating import use_mutation
from cosmic_ray.plugins import get_operator
from cosmic_ray.util import read_python_source


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def spec_of(item):
    m = item.mutations[0]
    return {
        "file": None, "operator": m.operator_name, "args": m.operator_args, "occurrence": m.occurrence,
        "start": list(m.start_pos), "end": list(m.end_pos), "fn": m.definition_name,
    }


def enumerate_items(cfg):
    root = Path(cfg["root"])
    items, skipped = [], []
    for rel in cfg["files"]:
        path = root / rel
        try:
            for it in _all_work_items([path], {}):
                s = spec_of(it)
                s["file"] = rel
                items.append(s)
        except Exception as e:  # noqa: BLE001  parso が読めない構文（新しい版の構文など）は、そのファイルだけ外す
            skipped.append({"file": rel, "error": f"{type(e).__name__}: {e}"[:300]})
    items.sort(key=lambda s: (s["file"], s["start"], s["end"], s["operator"], s["occurrence"]))
    return items, skipped


def offset_of(lines, pos):
    row, col = pos
    return sum(len(x) for x in lines[: row - 1]) + col


def replacement_of(original, mutated, start, end):
    """位置の範囲（元コード上）を置き換えた後の完全なコード。位置の外が元と一致しない時は、先頭・末尾の共通部分を除いた範囲で代える。"""
    lines = parso.utils.split_lines(original, keepends=True)
    a, b = offset_of(lines, start), offset_of(lines, end)
    tail = len(original) - b
    if mutated[:a] == original[:a] and tail >= 0 and (tail == 0 or mutated.endswith(original[b:])) and len(mutated) - tail >= a:
        return mutated[a: len(mutated) - tail]
    p = 0
    while p < min(len(original), len(mutated)) and original[p] == mutated[p]:
        p += 1
    q = 0
    while q < min(len(original), len(mutated)) - p and original[-1 - q] == mutated[-1 - q]:
        q += 1
    return mutated[p: len(mutated) - q]


def kill_tree(proc):
    try:
        if hasattr(os, "killpg"):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError, OSError):
        pass


def run_pytest(cmd, cwd, env, timeout, log_path):
    """pytest を 1 回流す。戻りは (exit code or None, timed_out)。出力は log_path の末尾へ追記する。"""
    with open(log_path, "ab") as log:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                start_new_session=hasattr(os, "setsid"))
        try:
            return proc.wait(timeout=timeout), False
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            proc.wait()
            return None, True


def read_records(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def run_one(spec, worker, cfg):
    root = Path(worker["root"])
    target = root / spec["file"]
    op = get_operator(spec["operator"])(**(spec["args"] or {}))
    res_file = worker["results"]
    if os.path.exists(res_file):
        os.remove(res_file)
    env = dict(cfg["env"], TG_PRUNE_OUT=res_file)
    t0 = time.time()
    with use_mutation(target, op, spec["occurrence"]) as (original, mutated):
        if mutated is None:
            return {"status": "nomutation"}
        rec = {"replacement": replacement_of(original, mutated, spec["start"], spec["end"])}
        code, timed_out = run_pytest(cfg["cmd"], str(root), env, cfg["timeout"], worker["log"])
    rec["dur"] = round(time.time() - t0, 3)
    rec["exit"] = code
    recs = read_records(res_file)
    rec["records"] = [r for r in recs if r.get("t") in ("r", "c") and (r.get("outcome") == "failed" or r.get("t") == "c")]
    rec["ran"] = sum(1 for r in recs if r.get("t") == "r" and r.get("when") == "call")
    rec["ended"] = any(r.get("t") == "end" for r in recs)
    rec["status"] = "timeout" if timed_out else "done"
    return rec


def run_items(cfg):
    items = cfg["items"]
    q = queue.Queue()
    for i, s in enumerate(items):
        q.put((i, s))
    lock = threading.Lock()
    done = [0]

    def work(worker):
        while True:
            try:
                i, spec = q.get_nowait()
            except queue.Empty:
                return
            try:
                rec = run_one(spec, worker, cfg)
            except Exception as e:  # noqa: BLE001
                rec = {"status": "error", "error": f"{type(e).__name__}: {e}"[:500]}
            rec.update({"index": i, "file": spec["file"], "operator": spec["operator"], "occurrence": spec["occurrence"],
                        "start": spec["start"], "end": spec["end"], "fn": spec["fn"]})
            with lock:
                with open(cfg["out"], "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                done[0] += 1
                print(f"[{done[0]}/{len(items)}] {spec['file']}:{spec['start'][0]} {spec['operator']} -> {rec['status']}", flush=True)

    threads = [threading.Thread(target=work, args=(w,)) for w in cfg["workers"]]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def main():
    cmd, cfg_path = sys.argv[1], sys.argv[2]
    cfg = load(cfg_path)
    if cmd == "enumerate":
        items, skipped = enumerate_items(cfg)
        # 標本は seed から決まる（同じ seed・同じ commit なら同じ標本）。位置を先に選び、同じ位置の置換先は最大 max_per_position 件に絞る。
        # 演算子の置換は置換先ごとに別の変異になる（`a + b` の + だけで 11 件）ので、位置ごとの重みを揃える。
        cap = int(cfg.get("max_per_position") or 3)
        n = cfg.get("sample") or 0
        by_pos = {}
        for i, s in enumerate(items):
            by_pos.setdefault((s["file"], tuple(s["start"]), tuple(s["end"])), []).append(i)
        keys = sorted(by_pos)
        random.Random(f"testgate-prune:{cfg.get('seed', '')}:positions").shuffle(keys)
        chosen = []
        for k in keys:
            idx = by_pos[k]
            if len(idx) > cap:
                idx = sorted(random.Random(f"testgate-prune:{cfg.get('seed', '')}:{k}").sample(idx, cap))
            chosen.extend(idx)
            if 0 < n <= len(chosen):
                break
        if 0 < n < len(chosen):
            chosen = chosen[:n]
        chosen.sort()
        picked = [items[i] for i in chosen]
        positions = len({(s["file"], tuple(s["start"]), tuple(s["end"])) for s in picked})
        files = {}
        for rel in sorted({s["file"] for s in picked}):
            files[rel] = read_python_source(Path(cfg["root"]) / rel)
        with open(cfg["out"], "w", encoding="utf-8") as f:
            json.dump({"total": len(items), "sampled": len(picked), "positions": positions, "items": picked, "skipped": skipped, "sources": files}, f, ensure_ascii=False)
    elif cmd == "run":
        run_items(cfg)
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()

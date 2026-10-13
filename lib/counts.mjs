// アダプタ無しの大まかな件数読み（段階0用）。pytest / jest / cargo / go / node --test の合計行を拾う。
// RTK が短縮した出力（[RTK:…] の印、rtk test の末尾5行、PASS (0) FAIL (0)）は件数を消している事があるので、
// 成功や 0 件で補わず「取得不能」として返す（ドリリーの指摘、2026-10-13）。
export function genericCounts(text) {
  if (!text) return { countsUnavailable: true, reason: 'no output' }
  if (/\[RTK:[A-Z_]+\]/.test(text)) return { countsUnavailable: true, reason: 'rtk passthrough/notice' }
  const m = {}
  let x
  if ((x = /(\d+) passed/.exec(text))) m.passed = +x[1]
  if ((x = /(\d+) failed/.exec(text))) m.failed = +x[1]
  if ((x = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(text))) { m.passed = +x[1]; m.failed = +x[2] }
  if ((x = /Tests:\s+(?:(\d+) failed, )?(\d+) passed/.exec(text))) { m.passed = +x[2]; if (x[1]) m.failed = +x[1] }
  if ((x = /ℹ pass (\d+)/.exec(text))) m.passed = +x[1]
  if ((x = /ℹ fail (\d+)/.exec(text))) m.failed = +x[1]
  // rtk の要約行（PASS (n) FAIL (m)）は、読み込めなかったファイルを落として 0/0 になる事がある。0/0 は信用しない
  if ((x = /PASS \((\d+)\)\s+FAIL \((\d+)\)/.exec(text)) && m.passed === undefined) {
    if (+x[1] === 0 && +x[2] === 0) return { countsUnavailable: true, reason: 'rtk summary 0/0' }
    m.passed = +x[1]; m.failed = +x[2]
  }
  if (m.passed === undefined && m.failed === undefined) return { countsUnavailable: true, reason: 'no summary line' }
  return m
}


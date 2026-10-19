package prunefix

import (
	"testing"
	"time"
)

// TestRun は他の試験より先に走る。Run の nil 判定が壊れると別の goroutine で nil の関数を呼んで panic し、プロセスごと落ちる。
func TestRun(t *testing.T) {
	out := make(chan int, 2)
	Run(func() int { return 7 }, out)
	Run(nil, out)
	select {
	case v := <-out:
		if v != 7 {
			t.Errorf("Run = %d, want 7", v)
		}
	case <-time.After(2 * time.Second):
		t.Error("Run: 結果が来ない")
	}
}

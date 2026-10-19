package prunefix

import "testing"

func TestAdd(t *testing.T) {
	if got := Add(1, 2); got != 3 {
		t.Errorf("Add(1, 2) = %d, want 3", got)
	}
}

// TestAddAgain は TestAdd と同じ変異を殺す（冗長の例）。
func TestAddAgain(t *testing.T) {
	if got := Add(10, 5); got != 15 {
		t.Errorf("Add(10, 5) = %d, want 15", got)
	}
}

func TestClamp(t *testing.T) {
	cases := []struct {
		name         string
		x, lo, hi, w int
	}{
		{"below", -5, 0, 10, 0},
		{"inside", 5, 0, 10, 5},
		{"above", 15, 0, 10, 10},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Clamp(c.x, c.lo, c.hi); got != c.w {
				t.Errorf("Clamp(%d, %d, %d) = %d, want %d", c.x, c.lo, c.hi, got, c.w)
			}
		})
	}
}

// TestMeanEmpty は空の入力。Mean の空判定が壊れると 0 除算の panic（製品側）で落ちる。
func TestMeanEmpty(t *testing.T) {
	if got := Mean(nil); got != 0 {
		t.Errorf("Mean(nil) = %d, want 0", got)
	}
}

func TestMean(t *testing.T) {
	if got := Mean([]int{2, 4, 6}); got != 4 {
		t.Errorf("Mean = %d, want 4", got)
	}
}

func TestIsPositive(t *testing.T) {
	if !IsPositive(3) {
		t.Error("IsPositive(3) = false")
	}
	if IsPositive(0) {
		t.Error("IsPositive(0) = true")
	}
}

// TestFirstSetup は First の戻りの先頭が無い時に添字で落ちる（試験本文の panic。前提）。
func TestFirstSetup(t *testing.T) {
	s, ok := First([]string{"a"})
	if !ok {
		t.Fatalf("First: ok = false")
	}
	if s != "a" {
		t.Errorf("First = %q, want a", s)
	}
}

func TestCounter(t *testing.T) {
	var c Counter
	c.Inc()
	if got := c.Inc(); got != 2 {
		t.Errorf("Inc = %d, want 2", got)
	}
}

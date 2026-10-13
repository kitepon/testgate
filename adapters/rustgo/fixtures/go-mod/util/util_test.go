package util

import "testing"

func TestDoubleSum(t *testing.T) {
	if DoubleSum(1, 2) != 6 {
		t.Fatal("bad")
	}
}

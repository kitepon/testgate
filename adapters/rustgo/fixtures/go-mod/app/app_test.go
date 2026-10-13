package app

import "testing"

func TestRun(t *testing.T) {
	if Run() != 10 {
		t.Fatal("bad")
	}
}

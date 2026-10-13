package core

import "testing"

func TestAdd(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Fatal("bad")
	}
}

func TestAddNeg(t *testing.T) {
	if Add(-1, -2) != -3 {
		t.Fatal("bad")
	}
}

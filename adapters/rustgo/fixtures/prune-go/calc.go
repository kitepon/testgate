package prunefix

// Add は 2 つの整数の和。
func Add(a, b int) int {
	return a + b
}

// Clamp は x を lo..hi に収める。
func Clamp(x, lo, hi int) int {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// Mean は平均（空なら 0）。
func Mean(xs []int) int {
	if len(xs) == 0 {
		return 0
	}
	sum := 0
	for _, x := range xs {
		sum += x
	}
	return sum / len(xs)
}

// IsPositive は x > 0。
func IsPositive(x int) bool {
	return x > 0
}

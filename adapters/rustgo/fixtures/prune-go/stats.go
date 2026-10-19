package prunefix

// First は先頭の要素。空なら ok=false。
func First(xs []string) (string, bool) {
	if len(xs) > 0 {
		return xs[0], true
	}
	return "", false
}

// Counter は呼ばれた回数を数える。
type Counter struct {
	n int
}

func (c *Counter) Inc() int {
	c.n++
	return c.n
}

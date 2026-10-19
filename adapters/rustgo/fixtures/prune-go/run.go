package prunefix

// Run は fn を別の goroutine で呼び、結果を out へ送る。fn が nil なら何もしない。
func Run(fn func() int, out chan<- int) {
	if fn == nil {
		return
	}
	go func() { out <- fn() }()
}

use prunefix::{add, first};

#[test]
fn adds_in_integration() {
    assert_eq!(add(2, 2), 4);
}

// first の戻りを unwrap する（前提が壊れると製品の None で panic。前提）。
#[test]
fn first_unwraps() {
    let v = vec![7, 8];
    assert_eq!(*first(&v).unwrap(), 7);
}

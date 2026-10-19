//! 刈り込みの試験用の小さな crate。

/// 2 つの整数の和。
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// x を lo..=hi に収める。
pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 {
    if x < lo {
        return lo;
    }
    if x > hi {
        return hi;
    }
    x
}

/// 平均（空なら 0）。
pub fn mean(xs: &[i32]) -> i32 {
    if xs.is_empty() {
        return 0;
    }
    let mut sum = 0;
    for x in xs {
        sum += x;
    }
    sum / xs.len() as i32
}

pub fn is_positive(x: i32) -> bool {
    x > 0
}

pub fn first<'a, T>(xs: &'a [T]) -> Option<&'a T> {
    if !xs.is_empty() {
        Some(&xs[0])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_works() {
        assert_eq!(add(1, 2), 3);
    }

    #[test]
    fn add_again() {
        assert_eq!(add(10, 5), 15);
    }

    #[test]
    fn clamp_edges() {
        assert_eq!(clamp(-5, 0, 10), 0);
        assert_eq!(clamp(5, 0, 10), 5);
        assert_eq!(clamp(15, 0, 10), 10);
    }

    // 空の入力。mean の空判定が壊れると 0 除算の panic（製品側）で落ちる。
    #[test]
    fn mean_empty() {
        assert_eq!(mean(&[]), 0);
    }

    #[test]
    fn mean_values() {
        assert_eq!(mean(&[2, 4, 6]), 4);
    }

    #[test]
    fn positive() {
        assert!(is_positive(3));
        assert!(!is_positive(0));
    }
}

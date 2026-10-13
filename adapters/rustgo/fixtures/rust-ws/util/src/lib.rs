pub fn double_sum(a: i32, b: i32) -> i32 { fxcore::add(a, b) * 2 }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn doubles() { assert_eq!(double_sum(1, 2), 6); }
}

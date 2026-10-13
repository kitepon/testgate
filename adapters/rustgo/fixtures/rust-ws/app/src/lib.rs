pub fn run() -> i32 { util::double_sum(2, 3) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn runs() { assert_eq!(run(), 10); }
}

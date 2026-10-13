pub fn shout(s: &str) -> String { s.to_uppercase() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn shouts() { assert_eq!(shout("a"), "A"); }
    #[test] fn shouts_empty() { assert_eq!(shout(""), ""); }
}

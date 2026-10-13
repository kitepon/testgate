import Testing
@testable import Util
@Test func shouts() { #expect(shout("hi") == "HI!") }
@Test func shoutsEmpty() { #expect(shout("") == "!") }

import XCTest
@testable import App
final class GreeterTests: XCTestCase {
    func testTotal() { XCTAssertEqual(total(2, 3), "total=5") }
}

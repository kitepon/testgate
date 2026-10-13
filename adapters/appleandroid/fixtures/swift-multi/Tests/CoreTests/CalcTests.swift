import XCTest
@testable import Core
final class CalcTests: XCTestCase {
    func testAdd() { XCTAssertEqual(add(2, 3), 5) }
    func testMul() { XCTAssertEqual(mul(2, 3), 6) }
}

// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "swift-multi",
    targets: [
        .target(name: "Core"),
        .target(name: "App", dependencies: ["Core"]),
        .target(name: "Util"),
        .testTarget(name: "CoreTests", dependencies: ["Core"]),
        .testTarget(name: "AppTests", dependencies: ["App"]),
        .testTarget(name: "UtilTests", dependencies: ["Util"]),
    ]
)

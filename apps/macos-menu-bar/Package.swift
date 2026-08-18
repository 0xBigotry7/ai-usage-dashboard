// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "UsageMenuBar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "UsageMenuBar", targets: ["UsageMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "UsageMenuBar",
            path: "Sources/UsageMenuBar"
        ),
        .testTarget(
            name: "UsageMenuBarTests",
            dependencies: ["UsageMenuBar"],
            path: "Tests/UsageMenuBarTests"
        )
    ]
)

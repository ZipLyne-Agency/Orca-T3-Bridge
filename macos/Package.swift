// swift-tools-version: 6.0
import PackageDescription

let package = Package(name: "OrcaT3", platforms: [.macOS(.v13)], products: [
    .executable(name: "OrcaT3", targets: ["OrcaT3"])
], dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")
], targets: [
    .target(name: "BridgeCore"),
    .executableTarget(name: "OrcaT3", dependencies: ["BridgeCore", .product(name: "Sparkle", package: "Sparkle")],
        linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
    .testTarget(name: "BridgeCoreTests", dependencies: ["BridgeCore"])
], swiftLanguageModes: [.v6])

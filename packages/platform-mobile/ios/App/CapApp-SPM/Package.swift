// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../../../node_modules/.pnpm/@aparajita+capacitor-secure-storage@8.0.0/node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.pnpm/@capacitor+app@8.1.1_@capacitor+core@8.5.0/node_modules/@capacitor/app"),
        .package(name: "CapacitorClipboard", path: "../../../../../node_modules/.pnpm/@capacitor+clipboard@8.0.1_@capacitor+core@8.5.0/node_modules/@capacitor/clipboard"),
        .package(name: "CapacitorDevice", path: "../../../../../node_modules/.pnpm/@capacitor+device@8.0.3_@capacitor+core@8.5.0/node_modules/@capacitor/device"),
        .package(name: "CapacitorFilesystem", path: "../../../../../node_modules/.pnpm/@capacitor+filesystem@8.1.3_@capacitor+core@8.5.0/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorPreferences", path: "../../../../../node_modules/.pnpm/@capacitor+preferences@8.0.1_@capacitor+core@8.5.0/node_modules/@capacitor/preferences"),
        .package(name: "CapacitorShare", path: "../../../../../node_modules/.pnpm/@capacitor+share@8.0.1_@capacitor+core@8.5.0/node_modules/@capacitor/share"),
        .package(name: "CapacitorSplashScreen", path: "../../../../../node_modules/.pnpm/@capacitor+splash-screen@8.0.2_@capacitor+core@8.5.0/node_modules/@capacitor/splash-screen")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorClipboard", package: "CapacitorClipboard"),
                .product(name: "CapacitorDevice", package: "CapacitorDevice"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen")
            ]
        )
    ]
)

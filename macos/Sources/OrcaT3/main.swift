import AppKit
import SwiftUI
import BridgeCore
import Darwin

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let bridge = BridgeController()
    private var updates: AppUpdates!
    private var controlsWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var terminating = false
    private var wakeObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        updates = AppUpdates()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification,
            object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.bridge.wakeFromSleep() } }
        let launchedAtLogin = NSAppleEventManager.shared().currentAppleEvent?
            .paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        Task {
            await bridge.launch()
            if !launchedAtLogin {
                if bridge.hasConfiguration { showControls() } else { showSettings() }
            }
        }
    }

    private func showControls() {
        bridge.updateLoginStatus()
        if controlsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 500),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Orca T3 Bridge"
            window.contentViewController = NSHostingController(rootView: PanelView(bridge: bridge, updates: updates,
                showSettings: { [weak self] in self?.showSettings() }, quit: { NSApp.terminate(nil) }))
            window.isReleasedWhenClosed = false
            window.center(); controlsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        controlsWindow?.makeKeyAndOrderFront(nil)
    }
    private func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 660),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Orca T3 Bridge"
            window.contentViewController = NSHostingController(rootView: SetupView(bridge: bridge, updates: updates))
            window.isReleasedWhenClosed = false
            window.center(); settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if bridge.hasConfiguration { showControls() } else { showSettings() }
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateNow }
        terminating = true
        Task { await bridge.prepareToQuit(); NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
    }
}

// A worker may exit between a status check and a stdin write.
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

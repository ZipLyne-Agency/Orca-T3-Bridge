import AppKit
import Combine
import ServiceManagement
import BridgeCore

struct BridgeInfo: Decodable {
    let orcaApp: String
    let t3URL: String?
    let t3Executable: String?
    let t3BaseDir: String?
    let stateDir: String
}

@MainActor
final class BridgeController: ObservableObject {
    @Published var phase = "paused"
    @Published var message = "Connect your existing Orca sessions to T3."
    @Published var discovered = 0
    @Published var lastSync: Date?
    @Published var busy = false
    @Published var enabled: Bool
    @Published var loginEnabled = false
    @Published var loginNeedsApproval = false
    @Published var loginMessage: String?
    @Published var t3App = "/Applications/T3 Code Nightly.app"
    @Published var orcaApp = "/Applications/Orca.app"
    @Published var t3URL = ""
    @Published var t3BaseDir = ""
    @Published var hasConfiguration = false
    private var worker: ProcessSession?
    private var workerTask: Task<Void, Never>?
    private var restartTask: Task<Void, Never>?
    private var generation = UUID()
    private var restartBudget = RestartBudget()
    private var lastDiagnostic: String?
    private var stopping = false
    private var quitting = false
    private var commandTask: Task<Data, Error>?
    private let defaults: UserDefaults
    private let fileManager = FileManager.default
    let configURL: URL
    let executable: URL
    let entrypoint: URL

    init(bundle: Bundle = .main, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: "syncEnabled")
        configURL = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".config/orca-t3-bridge/config.json")
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        executable = bundle.bundleURL.appendingPathComponent("Contents/MacOS/node-\(architecture)")
        entrypoint = bundle.bundleURL.appendingPathComponent("Contents/Resources/bridge/dist/src/cli.js")
        hasConfiguration = fileManager.fileExists(atPath: configURL.path)
        if fileManager.fileExists(atPath: "/Applications/T3 Code.app") { t3App = "/Applications/T3 Code.app" }
        t3BaseDir = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".t3").path
        updateLoginStatus()
    }

    var isInstalled: Bool {
        let parent = Bundle.main.bundleURL.deletingLastPathComponent().standardizedFileURL.path
        return parent == "/Applications" || parent == fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
    }
    var title: String {
        switch phase {
        case "connected": "Connected"
        case "connecting": "Connecting"
        case "waiting": "Waiting for apps"
        case "attention": "Needs attention"
        default: "Sync paused"
        }
    }
    private var environment: [String: String] {
        var result = ProcessInfo.processInfo.environment
        for key in ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"] { result.removeValue(forKey: key) }
        result["NODE_NO_WARNINGS"] = "1"
        return result
    }
    private func arguments(_ command: [String]) -> [String] {
        [entrypoint.path] + command + ["--config", configURL.path]
    }
    func command(_ command: [String]) async throws -> Data {
        let task = Task { try await runCommand(executable: executable, arguments: arguments(command), environment: environment) }
        commandTask = task
        defer { commandTask = nil }
        let data = try await task.value
        if quitting { throw CancellationError() }
        return data
    }

    func launch() async {
        if hasConfiguration, let data = try? await command(["desktop", "info"]),
           let info = try? JSONDecoder().decode(BridgeInfo.self, from: data) {
            orcaApp = info.orcaApp
            if let path = info.t3Executable, let range = path.range(of: ".app/") { t3App = String(path[..<range.lowerBound]) + ".app" }
            if let path = info.t3BaseDir { t3BaseDir = path }
        }
        if enabled && hasConfiguration && isInstalled { startWorker() }
        else if enabled && !isInstalled { setState("attention", "Open the installed copy in Applications to resume syncing.") }
    }

    func connect() async {
        guard !busy, !quitting else { return }
        guard isInstalled else { setState("attention", "Move Orca T3 Bridge to Applications, then open it there."); return }
        busy = true; setState("connecting", "Connecting your local apps...")
        defer { busy = false }
        await stopWorker()
        var args = ["desktop", "connect"]
        if !hasConfiguration {
            args += ["--t3-app", t3App, "--orca-app", orcaApp, "--t3-base-dir", t3BaseDir]
            if !t3URL.trimmingCharacters(in: .whitespaces).isEmpty { args += ["--t3-url", t3URL] }
        }
        do {
            _ = try await command(args)
            hasConfiguration = true
            enabled = true; defaults.set(true, forKey: "syncEnabled")
            restartBudget.reset()
            if !defaults.bool(forKey: "loginPreferenceSet") { setLogin(true) }
            startWorker()
        } catch { hasConfiguration = fileManager.fileExists(atPath: configURL.path); setState("attention", error.localizedDescription) }
    }

    func pause() async {
        enabled = false; defaults.set(false, forKey: "syncEnabled")
        await stopWorker(); setState("paused", "New sessions will sync when you resume. Existing T3 conversations remain available.")
    }

    func syncNow() {
        if worker != nil { worker?.wake() }
        else if enabled { restartBudget.reset(); startWorker() }
        else { Task { await connect() } }
    }

    private func startWorker() {
        guard worker == nil, enabled, !stopping, !quitting, isInstalled else { return }
        restartTask?.cancel(); restartTask = nil
        let current = UUID(); generation = current
        setState("connecting", "Checking Orca and T3...")
        do {
            let session = try ProcessSession(executable: executable, arguments: arguments(["desktop", "run"]), environment: environment)
            worker = session
            workerTask = Task { [weak self] in
                var lines = LineBuffer(); var diagnostics = Data(); var exitStatus: Int32?
                for await event in session.events {
                    guard let self, self.generation == current else { continue }
                    switch event {
                    case .output(let data):
                        do {
                            for line in try lines.append(data) {
                                let update = try JSONDecoder().decode(WorkerEvent.self, from: line)
                                self.setState(update.phase, update.message)
                                if let count = update.discovered { self.discovered = count }
                                if let stamp = update.lastSync { self.lastSync = ISO8601DateFormatter().date(from: stamp) }
                            }
                        } catch { self.setState("attention", "The bridge returned an incompatible status. Check for an app update."); session.stop() }
                    case .error(let data):
                        diagnostics.append(data)
                        if diagnostics.count > 16_384 { self.setState("attention", "The bridge produced too many diagnostics."); session.stop() }
                    case .exited(let status):
                        exitStatus = status
                    }
                }
                guard let self, self.generation == current else { return }
                self.worker = nil
                if self.stopping || self.quitting || !self.enabled || self.phase == "attention" { return }
                if exitStatus != 0, let text = String(data: diagnostics, encoding: .utf8), !text.isEmpty {
                    self.lastDiagnostic = text.trimmingCharacters(in: .whitespacesAndNewlines)
                } else if exitStatus == nil { self.lastDiagnostic = "The bridge status stream ended unexpectedly." }
                self.scheduleRestart()
            }
        } catch { setState("attention", "The bundled bridge could not start. Reinstall the app from the official download.") }
    }

    private func scheduleRestart() {
        guard let delay = restartBudget.nextDelay(now: Date()) else {
            setState("attention", lastDiagnostic ?? "The bridge stopped repeatedly. Choose Sync Now to retry, or open the guide."); return
        }
        setState("waiting", lastDiagnostic ?? "Reconnecting the local bridge...")
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.enabled else { return }
            self.startWorker()
        }
    }

    func stopWorker() async {
        stopping = true; restartTask?.cancel(); restartTask = nil
        worker?.stop()
        await workerTask?.value
        worker = nil; workerTask = nil; stopping = false
    }

    func prepareToQuit() async {
        quitting = true
        commandTask?.cancel()
        _ = try? await commandTask?.value
        await stopWorker()
    }
    func wakeFromSleep() { if enabled { syncNow() }; updateLoginStatus() }
    func setState(_ phase: String, _ message: String) {
        self.phase = phase; self.message = message
    }

    func setLogin(_ enabled: Bool) {
        defaults.set(true, forKey: "loginPreferenceSet")
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            loginMessage = nil
        } catch { loginMessage = "macOS could not change the login item. Check System Settings > General > Login Items." }
        updateLoginStatus()
    }
    func updateLoginStatus() {
        loginEnabled = SMAppService.mainApp.status == .enabled
        loginNeedsApproval = SMAppService.mainApp.status == .requiresApproval
    }
    func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
    func openApp(_ path: String) { NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: .init()) }
    func showConfiguration() { NSWorkspace.shared.activateFileViewerSelecting([configURL]) }
    func openGuide() { NSWorkspace.shared.open(URL(string: "https://ziplyne-agency.github.io/Orca-T3-Bridge/")!) }
}

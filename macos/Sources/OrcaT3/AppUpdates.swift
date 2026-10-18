import AppKit
import Combine
import Sparkle

@MainActor
final class AppUpdates: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published var canCheck = false
    @Published var automatic = true
    private var observations: Set<AnyCancellable> = []
    private(set) var controller: SPUStandardUpdaterController!

    override init() {
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        controller.updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main).assign(to: &$canCheck)
        controller.updater.publisher(for: \.automaticallyDownloadsUpdates).receive(on: RunLoop.main).assign(to: &$automatic)
        controller.startUpdater()
    }
    func check() { controller.checkForUpdates(nil) }
    func setAutomatic(_ value: Bool) {
        controller.updater.automaticallyChecksForUpdates = value
        controller.updater.automaticallyDownloadsUpdates = value
    }
}

import SwiftUI

struct PanelView: View {
    @ObservedObject var bridge: BridgeController
    @ObservedObject var updates: AppUpdates
    var showSettings: () -> Void
    var quit: () -> Void
    private var tint: Color { bridge.phase == "connected" ? .green : bridge.phase == "attention" ? .orange : .secondary }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "link").font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(.white).frame(width: 46, height: 46)
                    .background(LinearGradient(colors: [.indigo, .blue], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Orca T3 Bridge").font(.headline)
                    Text("Your agents, connected.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Circle().fill(tint).frame(width: 9, height: 9).accessibilityLabel(bridge.title)
            }
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text(bridge.title).font(.system(size: 16, weight: .semibold))
                    Spacer()
                    if bridge.phase == "connecting" { ProgressView().controlSize(.small) }
                }
                Text(bridge.message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let last = bridge.lastSync {
                    HStack {
                        Label("\(bridge.discovered) sessions", systemImage: "bubble.left.and.bubble.right")
                        Spacer()
                        Text(last, style: .time)
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            HStack(spacing: 10) {
                Button { bridge.syncNow() } label: {
                    Label(bridge.enabled ? "Sync Now" : "Connect", systemImage: "arrow.triangle.2.circlepath")
                        .frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent).disabled(bridge.busy)
                if bridge.enabled {
                    Button("Pause") { Task { await bridge.pause() } }.buttonStyle(.bordered).disabled(bridge.busy)
                }
            }
            HStack {
                Button("Open Orca") { bridge.openApp(bridge.orcaApp) }
                Spacer()
                Button("Open T3") { bridge.openApp(bridge.t3App) }
            }.buttonStyle(.link).font(.callout)
            Divider()
            VStack(spacing: 8) {
                Toggle("Open at login", isOn: Binding(get: { bridge.loginEnabled }, set: { bridge.setLogin($0) }))
                Toggle("Automatic updates", isOn: Binding(get: { updates.automatic }, set: { updates.setAutomatic($0) }))
            }.toggleStyle(.switch).controlSize(.small).font(.callout)
            if bridge.loginNeedsApproval {
                Button("Allow launch at login in System Settings") { bridge.openLoginSettings() }.font(.caption)
            }
            if let note = bridge.loginMessage { Text(note).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button("Settings", action: showSettings)
                Button("Guide") { bridge.openGuide() }
                Spacer()
                Menu {
                    Button("Check for Updates...") { updates.check() }.disabled(!updates.canCheck)
                    Button("Quit Bridge", action: quit)
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).frame(width: 22)
            }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
        }.padding(20).frame(width: 360)
    }
}

struct SetupView: View {
    @ObservedObject var bridge: BridgeController
    @ObservedObject var updates: AppUpdates
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Image(systemName: "link").font(.system(size: 35, weight: .semibold)).foregroundStyle(.indigo)
                    Spacer()
                    Text("BY ZIPLYNE").font(.system(size: 10, weight: .bold, design: .rounded)).tracking(2).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Keep Orca.\nTake T3 anywhere.").font(.system(size: 30, weight: .bold, design: .rounded))
                    Text("Your existing agents stay in Orca. Read their progress and reply from T3 on your Mac or phone.")
                        .font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 15) {
                    step("1", "Open your apps", "Keep Orca and T3 Code open on this Mac.")
                    step("2", "Connect once", "The bridge finds your existing agent sessions and keeps new ones in sync.")
                    step("3", "Use T3 anywhere", "Pair your phone with this T3 environment using T3's normal setup.")
                }
                Divider()
                if !bridge.isInstalled {
                    Label("Move this app to Applications before connecting.", systemImage: "folder.badge.gearshape").foregroundStyle(.orange)
                }
                if !bridge.hasConfiguration {
                    DisclosureGroup("App locations and connection") {
                        VStack(alignment: .leading, spacing: 10) {
                            field("Orca app", text: $bridge.orcaApp)
                            field("T3 app", text: $bridge.t3App)
                            field("T3 data directory", text: $bridge.t3BaseDir)
                            field("T3 address (blank = automatic)", text: $bridge.t3URL)
                        }.padding(.top, 10)
                    }
                } else {
                    HStack {
                        Label("Existing configuration found", systemImage: "checkmark.circle.fill").foregroundStyle(.secondary)
                        Spacer()
                        Button("Show File") { bridge.showConfiguration() }
                    }.font(.caption)
                    Text("Connecting keeps your imported conversations and delivery receipts. A matching command-line sync service is replaced by this app.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(bridge.message).font(.callout).foregroundStyle(bridge.phase == "attention" ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button { Task { await bridge.connect() } } label: {
                        Text(bridge.enabled ? "Reconnect" : "Connect Orca and T3").frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent).controlSize(.large).disabled(bridge.busy || !bridge.isInstalled)
                    if bridge.busy { ProgressView().controlSize(.small) }
                }
                HStack {
                    Button("Read the guide") { bridge.openGuide() }
                    Spacer()
                    Button("Check for Updates...") { updates.check() }.disabled(!updates.canCheck)
                }.font(.caption)
                Text("After connecting, the bridge runs in the background at login. Open Orca T3 Bridge from Applications or Spotlight to manage syncing, login and updates. Closing the window keeps syncing active.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(30)
        }.frame(width: 500, height: 660)
    }
    private func step(_ number: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number).font(.system(size: 12, weight: .bold)).foregroundStyle(.indigo)
                .frame(width: 25, height: 25).background(Color.indigo.opacity(0.1), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, text: text).textFieldStyle(.roundedBorder)
        }
    }
}

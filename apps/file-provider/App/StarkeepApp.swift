import SwiftUI
import FileProvider

@main
struct StarkeepApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var domainEnabled = false
    @State private var domainUserEnabled = true
    @State private var watches: [DataServerClient.WatchStatus] = []
    @State private var statusMessage = "Checking..."

    let client = DataServerClient()
    private let domainIdentifier = NSFileProviderDomainIdentifier("com.amkoller.fileprovider")

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "externaldrive.fill.badge.icloud")
                .font(.system(size: 64))
                .foregroundColor(.blue)

            Text("Starkeep")
                .font(.largeTitle)
                .bold()

            Text(statusMessage)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)

            Toggle("Show in Finder Sidebar", isOn: $domainEnabled)
                .toggleStyle(.switch)
                .onChange(of: domainEnabled) { _, newValue in
                    Task { await toggleDomain(enabled: newValue) }
                }
                .frame(width: 250)

            if domainEnabled && !domainUserEnabled {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Extension not approved")
                            .font(.callout)
                            .fontWeight(.medium)
                        Text("Enable StarkeepFileProvider in System Settings → General → Login Items & Extensions.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button("Open Settings") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!)
                    }
                    .controlSize(.small)
                }
                .padding(10)
                .background(Color.orange.opacity(0.1))
                .cornerRadius(8)
                .frame(maxWidth: 420)
            }

            Divider()

            // Watch management
            Text("Watched Directories")
                .font(.headline)

            if watches.isEmpty {
                Text("No directories being watched.")
                    .foregroundColor(.secondary)
                    .font(.caption)
            } else {
                List(watches, id: \.id) { watch in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(watch.directoryPath)
                                .font(.system(.body, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text("\(watch.targetType) — \(watch.syncedFiles)/\(watch.totalFiles) files")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Text(watch.state)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(watch.state == "watching" ? Color.green.opacity(0.2) : Color.orange.opacity(0.2))
                            .cornerRadius(4)
                    }
                }
                .frame(maxHeight: 200)
            }

            Button("Add Directory...") {
                addDirectory()
            }
        }
        .padding(40)
        .frame(minWidth: 500, minHeight: 450)
        .task {
            await checkDomain()
            await refreshWatches()
        }
    }

    func checkDomain() async {
        do {
            let domains = try await NSFileProviderManager.domains()
            let found = domains.first { $0.identifier == domainIdentifier }
            domainEnabled = found != nil
            domainUserEnabled = found.map { $0.userEnabled } ?? true
            if let domain = found, let manager = NSFileProviderManager(for: domain) {
                try? await manager.signalEnumerator(for: .rootContainer)
            }
        } catch {
            statusMessage = "Error checking domain: \(error.localizedDescription)"
        }
    }

    func toggleDomain(enabled: Bool) async {
        let domain = NSFileProviderDomain(
            identifier: domainIdentifier,
            displayName: "Starkeep"
        )

        do {
            if enabled {
                try await NSFileProviderManager.add(domain)
                statusMessage = "Showing in Finder sidebar"
            } else {
                try await NSFileProviderManager.remove(domain)
                statusMessage = "Removed from Finder"
            }
        } catch {
            statusMessage = "Error: \(error.localizedDescription)"
            domainEnabled = !enabled
        }
    }

    func refreshWatches() async {
        do {
            watches = try await client.fetchWatches()
            if statusMessage == "Checking..." {
                statusMessage = "Data server connected. \(watches.count) watch(es) active."
            }
        } catch {
            if statusMessage == "Checking..." {
                statusMessage = "Data server not reachable."
            }
        }
    }

    func addDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Watch"
        panel.message = "Choose a directory to sync with Starkeep"

        guard panel.runModal() == .OK, let url = panel.url else { return }

        let alert = NSAlert()
        alert.messageText = "Sync as which type?"
        alert.informativeText = url.path
        alert.addButton(withTitle: "Photos")
        alert.addButton(withTitle: "Documents")
        alert.addButton(withTitle: "Notes")
        alert.addButton(withTitle: "Cancel")

        let types = ["media:photo", "document", "note"]
        let response = alert.runModal()
        let index = response.rawValue - 1000
        guard index >= 0 && index < types.count else { return }
        let targetType = types[index]

        Task {
            do {
                let _ = try await client.createWatch(directoryPath: url.path, targetType: targetType)
                await refreshWatches()
            } catch {
                let message = error.localizedDescription
                if message.contains("EPERM") || message.contains("operation not permitted") {
                    let alert = NSAlert()
                    alert.alertStyle = .warning
                    alert.messageText = "Permission Denied"
                    alert.informativeText = "\(url.path) is protected by macOS. Grant Full Disk Access to your terminal app in System Settings, then restart the data server."
                    alert.addButton(withTitle: "Open Privacy Settings")
                    alert.addButton(withTitle: "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
                    }
                } else {
                    statusMessage = "Failed to create watch: \(message)"
                }
            }
        }
    }
}

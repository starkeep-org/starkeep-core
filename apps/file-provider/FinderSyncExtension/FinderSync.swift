import Cocoa
import FinderSync

class FinderSyncExtension: FIFinderSync {

    var watchedDirectories: [DataServerClient.WatchStatus] = []
    var fileStatusCache: [String: String] = [:]
    private var pollTimer: Timer?

    override init() {
        super.init()

        // Register badge images using SF Symbols
        let syncedImage = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: "Synced")!
        let syncingImage = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "Syncing")!
        let errorImage = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: "Error")!

        FIFinderSyncController.default().setBadgeImage(syncedImage, label: "Synced", forBadgeIdentifier: SyncBadge.synced.rawValue)
        FIFinderSyncController.default().setBadgeImage(syncingImage, label: "Syncing", forBadgeIdentifier: SyncBadge.syncing.rawValue)
        FIFinderSyncController.default().setBadgeImage(errorImage, label: "Error", forBadgeIdentifier: SyncBadge.error.rawValue)

        // Monitor the user's home directory so context menus appear on any folder.
        // Badges are only shown for files within actually-watched directories.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: NSHomeDirectory())]

        // Initial refresh
        refreshWatchedDirectories()

        // Poll every 5 seconds
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.refreshWatchedDirectories()
        }
    }

    // MARK: - Directory Observation

    func refreshWatchedDirectories() {
        Task {
            do {
                let watches = try await DataServerClient().fetchWatches()
                await MainActor.run {
                    self.watchedDirectories = watches
                    // Always include home so context menus appear everywhere
                    var urls = Set(watches.compactMap { URL(fileURLWithPath: $0.directoryPath) })
                    urls.insert(URL(fileURLWithPath: NSHomeDirectory()))
                    FIFinderSyncController.default().directoryURLs = urls
                }
            } catch {
                NSLog("StarkeepFinderSync: Failed to refresh watched directories: \(error)")
            }
        }
    }

    override func requestBadgeIdentifier(for url: URL) {
        let path = url.path
        if let badge = fileStatusCache[path] {
            FIFinderSyncController.default().setBadgeIdentifier(badge, for: url)
        }
        // If not cached, no badge is shown
    }

    override func beginObservingDirectory(at url: URL) {
        // Find the matching watch for this directory
        let dirPath = url.path
        guard let watch = watchedDirectories.first(where: { dirPath.hasPrefix($0.directoryPath) }) else {
            return
        }

        Task {
            do {
                let files = try await DataServerClient().fetchWatchFiles(watchId: watch.id)
                await MainActor.run {
                    for file in files {
                        switch file.status {
                        case "synced":
                            self.fileStatusCache[file.filePath] = SyncBadge.synced.rawValue
                        case "syncing", "pending":
                            self.fileStatusCache[file.filePath] = SyncBadge.syncing.rawValue
                        case "error":
                            self.fileStatusCache[file.filePath] = SyncBadge.error.rawValue
                        default:
                            self.fileStatusCache[file.filePath] = SyncBadge.synced.rawValue
                        }
                    }
                }
            } catch {
                NSLog("StarkeepFinderSync: Failed to fetch watch files: \(error)")
            }
        }
    }

    override func endObservingDirectory(at url: URL) {
        let dirPath = url.path
        fileStatusCache = fileStatusCache.filter { !$0.key.hasPrefix(dirPath) }
    }

    // MARK: - Context Menu

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        guard menuKind == .contextualMenuForItems else { return nil }

        guard let items = FIFinderSyncController.default().selectedItemURLs(), !items.isEmpty else {
            return nil
        }

        let menu = NSMenu(title: "Starkeep")

        // Check if any selected item is a directory
        for item in items {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: item.path, isDirectory: &isDir), isDir.boolValue else {
                continue
            }

            let dirPath = item.path
            if let watch = watchedDirectories.first(where: { $0.directoryPath == dirPath }) {
                // Directory is watched — offer to stop
                let stopItem = NSMenuItem(title: "Stop Syncing with Starkeep", action: #selector(stopSyncing(_:)), keyEquivalent: "")
                stopItem.representedObject = watch.id
                stopItem.target = self
                menu.addItem(stopItem)
            } else {
                // Directory is not watched — offer type submenu
                let syncItem = NSMenuItem(title: "Sync with Starkeep", action: nil, keyEquivalent: "")
                let submenu = NSMenu(title: "Sync with Starkeep")

                let types = [
                    ("Photos", "media:photo"),
                    ("Videos", "media:video"),
                    ("Documents", "document"),
                    ("Notes", "note"),
                ]

                for (label, targetType) in types {
                    let typeItem = NSMenuItem(title: label, action: #selector(startSyncing(_:)), keyEquivalent: "")
                    typeItem.representedObject = ["directoryPath": dirPath, "targetType": targetType]
                    typeItem.target = self
                    submenu.addItem(typeItem)
                }

                syncItem.submenu = submenu
                menu.addItem(syncItem)
            }
        }

        return menu.items.isEmpty ? nil : menu
    }

    @objc func startSyncing(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: String],
              let directoryPath = info["directoryPath"],
              let targetType = info["targetType"] else { return }

        Task {
            do {
                let _ = try await DataServerClient().createWatch(directoryPath: directoryPath, targetType: targetType)
                refreshWatchedDirectories()
            } catch {
                NSLog("StarkeepFinderSync: Failed to create watch: \(error)")
            }
        }
    }

    @objc func stopSyncing(_ sender: NSMenuItem) {
        guard let watchId = sender.representedObject as? String else { return }

        Task {
            do {
                try await DataServerClient().deleteWatch(id: watchId)
                refreshWatchedDirectories()
            } catch {
                NSLog("StarkeepFinderSync: Failed to delete watch: \(error)")
            }
        }
    }

    // MARK: - Toolbar Item

    override var toolbarItemName: String {
        return "Starkeep"
    }

    override var toolbarItemImage: NSImage {
        return NSImage(systemSymbolName: "checkmark.circle", accessibilityDescription: "Starkeep")!
    }

    override var toolbarItemToolTip: String {
        return "Starkeep"
    }
}

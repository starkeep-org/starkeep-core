import FileProvider

final class Enumerator: NSObject, NSFileProviderEnumerator {
    let containerIdentifier: NSFileProviderItemIdentifier
    let client: DataServerClient

    init(containerIdentifier: NSFileProviderItemIdentifier, client: DataServerClient) {
        self.containerIdentifier = containerIdentifier
        self.client = client
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let browsePath = Self.browsePathFor(containerIdentifier)
                let result = try await client.browse(path: browsePath)

                var items: [NSFileProviderItem] = []

                // Add folders
                for folder in result.folders {
                    items.append(FolderItem(folder: folder, parentIdentifier: containerIdentifier))
                }

                // Add files
                for file in result.files {
                    items.append(FileProviderItem(file: file, parentIdentifier: containerIdentifier))
                }

                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let anchor = NSFileProviderSyncAnchor(
            "\(Date().timeIntervalSince1970)".data(using: .utf8)!
        )
        completionHandler(anchor)
    }

    /// Map File Provider identifiers to browse paths
    private static func browsePathFor(_ identifier: NSFileProviderItemIdentifier) -> String {
        switch identifier {
        case .rootContainer:
            return "/"
        default:
            let raw = identifier.rawValue
            // "folder:watch:XXXX" → "/watch:XXXX"
            // "folder:watch:XXXX/sub/path" → "/watch:XXXX/sub/path"
            // "folder:virtual:library" → "/virtual:library"
            // "folder:library-type:note" → "/library-type:note"
            if raw.hasPrefix("folder:") {
                return "/" + String(raw.dropFirst(7))
            }
            return "/"
        }
    }
}

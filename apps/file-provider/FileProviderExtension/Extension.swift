import FileProvider
import UniformTypeIdentifiers

/// Starkeep File Provider — exposes records as files in Finder.
///
/// Identifier scheme:
///   - `.rootContainer` → root
///   - `"type:<recordType>"` → type folder (e.g., "type:media:photo")
///   - `"record:<id>"` → individual record
@objc(StarkeepFileProviderExtension)
final class Extension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    let client = DataServerClient()
    let tempDir: URL

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        self.tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("StarkeepFileProvider", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        super.init()
    }

    func invalidate() {}

    // MARK: - Item lookup

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        Task {
            do {
                let item = try await resolveItem(identifier)
                completionHandler(item, nil)
            } catch {
                completionHandler(nil, error)
            }
        }
        return Progress()
    }

    // MARK: - Enumeration

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws
        -> NSFileProviderEnumerator
    {
        return Enumerator(containerIdentifier: containerItemIdentifier, client: client)
    }

    // MARK: - Content fetch (the key part — called when user opens a file)

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)

        Task {
            do {
                guard let recordId = recordId(from: itemIdentifier) else {
                    throw NSFileProviderError(.noSuchItem)
                }

                let (downloadedURL, _) = try await client.downloadFile(recordId: recordId)
                let record = try await client.fetchRecord(id: recordId)
                let item = FileProviderItem(record: record)

                // Move to a stable temp path
                let dest = tempDir.appendingPathComponent(itemIdentifier.rawValue)
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: downloadedURL, to: dest)

                progress.completedUnitCount = 100
                completionHandler(dest, item, nil)
            } catch {
                completionHandler(nil, nil, error)
            }
        }

        return progress
    }

    // MARK: - Create (drag-and-drop / paste into Finder)

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields,
                    contents url: URL?, options: NSFileProviderCreateItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        Task {
            do {
                let parentId = itemTemplate.parentItemIdentifier.rawValue
                let type = parentId.hasPrefix("type:") ? String(parentId.dropFirst(5)) : "document"
                let filename = itemTemplate.filename
                let ext = (filename as NSString).pathExtension.lowercased()
                let title = (filename as NSString).deletingPathExtension
                let contentType = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"

                var fileData: Data?
                if let url {
                    fileData = try Data(contentsOf: url)
                }

                let record = try await client.createRecord(
                    type: type,
                    payload: ["title": title],
                    fileName: filename,
                    contentType: contentType,
                    fileData: fileData
                )

                let item = FileProviderItem(record: record)
                completionHandler(item, [], false, nil)
            } catch {
                completionHandler(nil, [], false, error)
            }
        }
        return Progress()
    }

    // MARK: - Modify

    func modifyItem(_ item: NSFileProviderItem, baseVersion: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields, contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        // For now, return the item unchanged
        completionHandler(item, [], false, nil)
        return Progress()
    }

    // MARK: - Delete

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        // TODO: call data server delete endpoint
        completionHandler(nil)
        return Progress()
    }

    // MARK: - Helpers

    private func resolveItem(_ identifier: NSFileProviderItemIdentifier) async throws -> NSFileProviderItem {
        switch identifier {
        case .rootContainer:
            return RootItem()
        case .trashContainer:
            return TrashItem()
        default:
            let raw = identifier.rawValue
            if raw.hasPrefix("folder:") {
                // Browse the parent to find the actual folder metadata (so itemCount matches)
                let folderId = String(raw.dropFirst(7))
                let result = try await client.browse(path: "/")
                if let folder = result.folders.first(where: { $0.id == folderId }) {
                    return FolderItem(folder: folder, parentIdentifier: .rootContainer)
                }
                // Fallback: construct a minimal folder item
                let name = folderId.split(separator: "/").last.map(String.init) ?? folderId
                let folder = DataServerClient.BrowseFolder(name: name, id: folderId, type: "folder", itemCount: 0)
                return FolderItem(folder: folder, parentIdentifier: .rootContainer)
            } else if raw.hasPrefix("record:") {
                let id = String(raw.dropFirst(7))
                let record = try await client.fetchRecord(id: id)
                return FileProviderItem(record: record)
            }
            throw NSFileProviderError(.noSuchItem)
        }
    }

    private func recordId(from identifier: NSFileProviderItemIdentifier) -> String? {
        let raw = identifier.rawValue
        guard raw.hasPrefix("record:") else { return nil }
        return String(raw.dropFirst(7))
    }
}

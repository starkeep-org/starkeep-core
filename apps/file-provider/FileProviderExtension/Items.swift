import FileProvider
import UniformTypeIdentifiers

// MARK: - Root container

final class RootItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { "Starkeep" }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems] }
    var itemVersion: NSFileProviderItemVersion { NSFileProviderItemVersion(contentVersion: Data(), metadataVersion: Data()) }
}

// MARK: - Folder item (watched directory, subfolder, or virtual folder)

final class FolderItem: NSObject, NSFileProviderItem {
    let browseFolderId: String
    let name: String
    let parentId: String
    let count: Int

    init(folder: DataServerClient.BrowseFolder, parentIdentifier: NSFileProviderItemIdentifier) {
        self.browseFolderId = folder.id
        self.name = folder.name
        self.parentId = parentIdentifier.rawValue
        self.count = folder.itemCount
    }

    var itemIdentifier: NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier("folder:\(browseFolderId)")
    }
    var parentItemIdentifier: NSFileProviderItemIdentifier {
        parentId == NSFileProviderItemIdentifier.rootContainer.rawValue
            ? .rootContainer
            : NSFileProviderItemIdentifier(parentId)
    }
    var filename: String { name }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems] }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: "\(count)".data(using: .utf8) ?? Data(), metadataVersion: Data())
    }
    var childItemCount: NSNumber? { NSNumber(value: count) }
}

// MARK: - File item

final class FileProviderItem: NSObject, NSFileProviderItem {
    let file: DataServerClient.BrowseFile
    let parentId: String

    init(file: DataServerClient.BrowseFile, parentIdentifier: NSFileProviderItemIdentifier) {
        self.file = file
        self.parentId = parentIdentifier.rawValue
    }

    // Legacy init from Record (for item lookup)
    init(record: DataServerClient.Record) {
        self.file = DataServerClient.BrowseFile(
            id: record.id,
            name: record.payload?["title"]?.stringValue ?? record.payload?["name"]?.stringValue ?? record.id,
            relativePath: nil,
            mime_type: record.mime_type,
            size_bytes: record.size_bytes,
            updated_at: record.updated_at,
            created_at: record.created_at
        )
        self.parentId = NSFileProviderItemIdentifier.rootContainer.rawValue
    }

    var itemIdentifier: NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier("record:\(file.id)")
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier {
        parentId == NSFileProviderItemIdentifier.rootContainer.rawValue
            ? .rootContainer
            : NSFileProviderItemIdentifier(parentId)
    }

    var filename: String {
        let name = file.name
        // Add extension if not already present
        if name.contains(".") { return name }
        let ext = fileExtension
        return ext.isEmpty ? name : "\(name).\(ext)"
    }

    var contentType: UTType {
        if let mime = file.mime_type, let uttype = UTType(mimeType: mime) {
            return uttype
        }
        return .data
    }

    var documentSize: NSNumber? {
        if let size = file.size_bytes { return NSNumber(value: size) }
        return nil
    }

    var capabilities: NSFileProviderItemCapabilities {
        [.allowsReading, .allowsDeleting]
    }

    var itemVersion: NSFileProviderItemVersion {
        let v = (file.updated_at ?? "").data(using: .utf8) ?? Data()
        return NSFileProviderItemVersion(contentVersion: v, metadataVersion: v)
    }

    var contentModificationDate: Date? {
        file.updated_at.flatMap { Self.parseDate($0) }
    }

    var creationDate: Date? {
        file.created_at.flatMap { Self.parseDate($0) }
    }

    private static func parseDate(_ string: String) -> Date? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fmt.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }

    private var fileExtension: String {
        if let mime = file.mime_type {
            if let uttype = UTType(mimeType: mime), let ext = uttype.preferredFilenameExtension {
                return ext
            }
        }
        return ""
    }
}

import Foundation

/// Client for the Starkeep data server HTTP API.
struct DataServerClient {
    let baseURL: URL

    init(baseURL: URL = URL(string: "http://127.0.0.1:9820")!) {
        self.baseURL = baseURL
    }

    // MARK: - Types

    struct RecordType: Decodable {
        let record_type: String
        let count: Int
        let latest_updated: String
    }

    struct TypesResponse: Decodable {
        let types: [RecordType]
        let total: Int
    }

    struct Record: Decodable {
        let id: String
        let type: String
        let created_at: String
        let updated_at: String
        let owner_id: String
        let payload: [String: AnyCodable]?
        let mime_type: String?
        let size_bytes: Int?
        let object_storage_key: String?
    }

    struct RecordsResponse: Decodable {
        let records: [Record]
    }

    struct SingleRecordResponse: Decodable {
        let record: Record
    }

    struct FileURLResponse: Decodable {
        let url: String
        let mimeType: String?
        let sizeBytes: Int?
        let expiresIn: Int?
    }

    struct CreateResponse: Decodable {
        let record: Record
    }

    struct WatchStatus: Decodable {
        let id: String
        let directoryPath: String
        let targetType: String
        let state: String
        let totalFiles: Int
        let syncedFiles: Int
        let lastScanAt: String?
    }

    struct WatchesResponse: Decodable {
        let watches: [WatchStatus]
    }

    struct WatchFileInfo: Decodable {
        let filePath: String
        let relativePath: String
        let contentHash: String
        let dataRecordId: String
        let status: String
    }

    struct WatchFilesResponse: Decodable {
        let files: [WatchFileInfo]
    }

    struct FileStatusResponse: Decodable {
        let watched: Bool
        let synced: Bool
        let watchId: String?
        let recordId: String?
    }

    struct DirectoryStatusResponse: Decodable {
        let watched: Bool
        let watchId: String?
        let directoryPath: String?
        let targetType: String?
    }

    // MARK: - Browse API

    struct BrowseFolder: Decodable {
        let name: String
        let id: String
        let type: String
        let itemCount: Int
    }

    struct BrowseFile: Decodable {
        let id: String
        let name: String
        let relativePath: String?
        let mime_type: String?
        let size_bytes: Int?
        let updated_at: String?
        let created_at: String?
    }

    struct BrowseResponse: Decodable {
        let path: String
        let folders: [BrowseFolder]
        let files: [BrowseFile]
    }

    func browse(path: String = "/") async throws -> BrowseResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("browse"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try JSONDecoder().decode(BrowseResponse.self, from: data)
    }

    // MARK: - API

    func fetchTypes() async throws -> [RecordType] {
        let (data, _) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("data/types"))
        return try JSONDecoder().decode(TypesResponse.self, from: data).types
    }

    func fetchRecords(type: String, limit: Int = 1000) async throws -> [Record] {
        var components = URLComponents(url: baseURL.appendingPathComponent("data/records"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "type", value: type),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try JSONDecoder().decode(RecordsResponse.self, from: data).records
    }

    func fetchRecord(id: String) async throws -> Record {
        let (data, _) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("data/records/\(id)"))
        return try JSONDecoder().decode(SingleRecordResponse.self, from: data).record
    }

    func fetchFileURL(recordId: String, expiresIn: Int = 3600) async throws -> FileURLResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("data/records/\(recordId)/file-url"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "expiresIn", value: String(expiresIn))]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try JSONDecoder().decode(FileURLResponse.self, from: data)
    }

    func downloadFile(recordId: String) async throws -> (URL, String?) {
        let fileURLResponse = try await fetchFileURL(recordId: recordId)
        let remoteURL = URL(string: fileURLResponse.url)!
        let (tempURL, _) = try await URLSession.shared.download(from: remoteURL)
        return (tempURL, fileURLResponse.mimeType)
    }

    func fetchWatches() async throws -> [WatchStatus] {
        let (data, _) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("watches"))
        return try JSONDecoder().decode(WatchesResponse.self, from: data).watches
    }

    struct ServerError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    func createWatch(directoryPath: String, targetType: String, recursive: Bool = true) async throws -> WatchStatus {
        let body: [String: Any] = ["directoryPath": directoryPath, "targetType": targetType, "recursive": recursive]
        var request = URLRequest(url: baseURL.appendingPathComponent("watches"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            struct ErrorBody: Decodable { let error: String }
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Unknown server error"
            throw ServerError(message: message)
        }
        struct Wrapper: Decodable { let watch: WatchStatus }
        return try JSONDecoder().decode(Wrapper.self, from: data).watch
    }

    func deleteWatch(id: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("watches/\(id)"))
        request.httpMethod = "DELETE"
        let _ = try await URLSession.shared.data(for: request)
    }

    func fetchWatchFiles(watchId: String, limit: Int = 5000) async throws -> [WatchFileInfo] {
        var components = URLComponents(url: baseURL.appendingPathComponent("watches/\(watchId)/files"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try JSONDecoder().decode(WatchFilesResponse.self, from: data).files
    }

    func fetchFileStatus(path: String) async throws -> FileStatusResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("watches/file-status"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try JSONDecoder().decode(FileStatusResponse.self, from: data)
    }

    func fetchDirectoryStatus(path: String) async throws -> DirectoryStatusResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("watches/directory-status"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try JSONDecoder().decode(DirectoryStatusResponse.self, from: data)
    }

    func createRecord(type: String, payload: [String: String], fileName: String?, contentType: String?, fileData: Data?) async throws -> Record {
        var body: [String: Any] = ["type": type, "payload": payload]
        if let fileName { body["fileName"] = fileName }
        if let contentType { body["contentType"] = contentType }
        if let fileData { body["fileBase64"] = fileData.base64EncodedString() }

        var request = URLRequest(url: baseURL.appendingPathComponent("data/records"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(CreateResponse.self, from: data).record
    }
}

// MARK: - AnyCodable helper for dynamic JSON payloads

struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) { value = string }
        else if let int = try? container.decode(Int.self) { value = int }
        else if let double = try? container.decode(Double.self) { value = double }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if container.decodeNil() { value = NSNull() }
        else { value = "" }
    }

    var stringValue: String? { value as? String }
}

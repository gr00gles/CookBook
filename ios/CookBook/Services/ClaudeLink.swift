import Foundation
import Observation

/// The "Let Claude send recipes" permission.
///
/// Turning it on creates this person's inbox on the CookBook server and a
/// private connector link. They add that link to Claude as a custom connector;
/// recipes Claude saves wait in the inbox until the app collects them.
/// Turning it off, or making a new link, stops the old link working.
@MainActor
@Observable
final class ClaudeLink {
    private(set) var connectorURL: String?
    private(set) var serverURL: String
    private(set) var isWorking = false
    private(set) var lastChecked: Date?
    /// How many recipes the last check brought in.
    private(set) var lastArrivals = 0
    var errorMessage: String?

    private var inboxID: String?
    private var readKey: String?
    private var isChecking = false

    private enum Keys {
        static let inboxID = "claude.inboxID"
        static let readKey = "claude.readKey"
        static let connectorURL = "claude.connectorURL"
        static let serverURL = "serverURL"
        static let importedIDs = "claude.importedIDs"
    }

    static let builtInServerURL = (Bundle.main.object(forInfoDictionaryKey: "CookBookServerURL") as? String) ?? ""

    init() {
        let defaults = UserDefaults.standard
        serverURL = defaults.string(forKey: Keys.serverURL) ?? Self.builtInServerURL
        inboxID = defaults.string(forKey: Keys.inboxID)
        readKey = Keychain.get(Keys.readKey)
        connectorURL = Keychain.get(Keys.connectorURL)
    }

    var isEnabled: Bool { connectorURL != nil }
    var hasInbox: Bool { inboxID != nil && readKey != nil }

    var hasServer: Bool {
        guard let url = URL(string: serverURL), url.scheme == "https", url.host != nil else { return false }
        return !serverURL.contains("YOUR-ACCOUNT")
    }

    // MARK: Permission

    func enable() async {
        guard !isWorking else { return }
        guard hasServer else { errorMessage = LinkError.noServer.message; return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            if let inboxID, readKey != nil {
                let (data, status) = try await send("POST", "v1/inboxes/\(inboxID)/connector")
                if status == 200 {
                    setConnector(try JSONDecoder().decode(ConnectorResponse.self, from: data).connectorUrl)
                    return
                }
                guard status == 401 || status == 404 else { throw LinkError.server(status) }
                // The server no longer knows this inbox. Start a new one below.
            }
            let (data, status) = try await send("POST", "v1/inboxes", authorized: false)
            guard status == 201 else { throw LinkError.server(status) }
            let created = try JSONDecoder().decode(CreatedInbox.self, from: data)
            setInbox(id: created.inboxId, key: created.readKey)
            setConnector(created.connectorUrl)
        } catch {
            errorMessage = LinkError.message(for: error)
        }
    }

    func disable() async {
        guard !isWorking else { return }
        guard let inboxID else { setConnector(nil); return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let (_, status) = try await send("DELETE", "v1/inboxes/\(inboxID)/connector")
            guard status == 204 || status == 401 || status == 404 else { throw LinkError.server(status) }
            setConnector(nil)
        } catch {
            errorMessage = "Claude can still send recipes. " + LinkError.message(for: error)
        }
    }

    /// Replaces the link. The old one stops working.
    func makeNewLink() async {
        await enable()
    }

    func setServerURL(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard trimmed != serverURL else { return }
        serverURL = trimmed
        UserDefaults.standard.set(trimmed, forKey: Keys.serverURL)
        // An inbox belongs to one server.
        setInbox(id: nil, key: nil)
        setConnector(nil)
    }

    // MARK: Collecting recipes

    func checkInbox(into store: RecipeStore) async {
        guard let inboxID, readKey != nil, hasServer, !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        do {
            let (data, status) = try await send("GET", "v1/inboxes/\(inboxID)/recipes")
            if status == 401 || status == 404 {
                // The inbox is gone, for example after the server was reset.
                setInbox(id: nil, key: nil)
                setConnector(nil)
                errorMessage = "The connection to Claude was reset. Turn on “Let Claude send recipes” again to get a new link."
                return
            }
            guard status == 200 else { return }
            let inbox = try JSONDecoder().decode(InboxResponse.self, from: data)
            lastChecked = Date()
            if inbox.sending == false, connectorURL != nil { setConnector(nil) }

            var imported = Set(UserDefaults.standard.stringArray(forKey: Keys.importedIDs) ?? [])
            var arrivals: [Recipe] = []
            for item in inbox.recipes where !imported.contains(item.id) {
                let content = item.recipe.content
                arrivals.append(Recipe(
                    content: content,
                    tags: item.recipe.tags,
                    source: ParserBridge.shared.markdown(for: content),
                    fromClaude: true,
                    isNew: true,
                    createdAt: Date(timeIntervalSince1970: item.receivedAt / 1000)
                ))
                imported.insert(item.id)
            }
            store.add(contentsOf: arrivals)
            lastArrivals = arrivals.count
            UserDefaults.standard.set(Array(imported.suffix(500)), forKey: Keys.importedIDs)

            let ids = inbox.recipes.map(\.id)
            if !ids.isEmpty {
                _ = try await send("POST", "v1/inboxes/\(inboxID)/ack", body: ["ids": ids])
            }
        } catch {
            // Offline or the server is unreachable. The next check tries again.
        }
    }

    // MARK: Private

    private struct CreatedInbox: Decodable {
        var inboxId: String
        var readKey: String
        var connectorUrl: String
    }

    private struct ConnectorResponse: Decodable {
        var connectorUrl: String
    }

    private enum LinkError: Error {
        case noServer
        case server(Int)

        var message: String {
            switch self {
            case .noServer: return "Add your CookBook server address under Server first."
            case .server(let status): return "The CookBook server answered with an error (\(status)). Try again in a moment."
            }
        }

        static func message(for error: Error) -> String {
            if let error = error as? LinkError { return error.message }
            if error is URLError { return "Couldn't reach the CookBook server. Check your connection and try again." }
            return "Something went wrong: \(error.localizedDescription)"
        }
    }

    private func setInbox(id: String?, key: String?) {
        inboxID = id
        readKey = key
        UserDefaults.standard.set(id, forKey: Keys.inboxID)
        Keychain.set(key, for: Keys.readKey)
    }

    private func setConnector(_ url: String?) {
        connectorURL = url
        Keychain.set(url, for: Keys.connectorURL)
    }

    private func send(_ method: String, _ path: String, body: [String: Any]? = nil, authorized: Bool = true) async throws -> (Data, Int) {
        guard let base = URL(string: serverURL), base.host != nil else { throw LinkError.noServer }
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authorized, let readKey {
            request.setValue("Bearer \(readKey)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

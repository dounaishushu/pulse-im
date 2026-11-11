import Foundation
import Combine

enum RealtimeTextSendFailure: LocalizedError {
    case unavailable, rejected(String)
    var errorDescription: String? {
        switch self { case .unavailable: return "实时连接暂不可用"; case .rejected(let message): return message }
    }
}

@MainActor final class RealtimeClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var lastMessage: Message?
    @Published private(set) var lastPinsSnapshot: MessagePinsSnapshot?
    @Published private(set) var lastPersonalDeletion: PersonalMessageDeletion?
    @Published private(set) var subscriptionRevision = 0
    @Published private(set) var metadataRevision = 0
    @Published private(set) var historyInvalidationRevision = 0
    private static var goReadyScope: String?
    private static let goRelay = Notification.Name("pulse.go-v2.realtime-relay")
    private var relayObserver: NSObjectProtocol?
    private var relayScope: String { endpointIdentity + "|" + token }
    private let client: APIClient
    private var ticketWork: Task<Void, Never>?
    private var endpoint: URL
    private var failedRouteAPI: URL?
    private var routeObserver: NSObjectProtocol?
    private let token: String
    private let conversationID: Int?
    private let endpointIdentity: String
    private let onMessage: (Message) -> Void
    private let onConversationUpdate: (Int) -> Void
    private let onReady: () -> Void
    private let onNotificationUpdate: () -> Void
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var generation = UUID()
    private var reconnectWork: Task<Void, Never>?
    private var heartbeatWork: Task<Void, Never>?
    private var retryDelay = 1
    private var stopped = true
    private var authenticated = false
    private var openedAt: TimeInterval = 0
    private var receivedAt: TimeInterval = 0
    private var pingAt: TimeInterval = 0
    private struct TextSubmission {
        let operation: UUID
        let requestID: String
        let senderID: Int
        let continuation: CheckedContinuation<Message, Error>
        let timeout: Task<Void, Never>
    }
    private var textSubmission: TextSubmission?
    private var fastTextEnabled = true

    init(conversationID: Int, token: String, onMessage: @escaping (Message) -> Void) {
        self.conversationID = conversationID; self.token = token; self.onMessage = onMessage
        self.client = APIClient.shared.captureSession()
        self.endpoint = APIClient.shared.webSocketURL; self.endpointIdentity = APIClient.shared.endpointIdentity
        self.onConversationUpdate = { _ in }; self.onReady = {}; self.onNotificationUpdate = {}
        observeRoutes(); observeGoRelay()
    }
    init(token: String, onConversationUpdate: @escaping (Int) -> Void, onReady: @escaping () -> Void, onNotificationUpdate: @escaping () -> Void = {}) {
        self.conversationID = nil; self.token = token; self.onMessage = { _ in }
        self.client = APIClient.shared.captureSession()
        self.endpoint = APIClient.shared.webSocketURL; self.endpointIdentity = APIClient.shared.endpointIdentity
        self.onConversationUpdate = onConversationUpdate; self.onReady = onReady; self.onNotificationUpdate = onNotificationUpdate
        observeRoutes(); observeGoRelay()
    }
    deinit {
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        if let relayObserver { NotificationCenter.default.removeObserver(relayObserver) }
        reconnectWork?.cancel(); heartbeatWork?.cancel(); ticketWork?.cancel()
        task?.cancel(with: .normalClosure, reason: nil); session?.invalidateAndCancel()
    }
    private func observeRoutes() {
        routeObserver = NotificationCenter.default.addObserver(forName: .pulseRouteChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in guard let self, !self.stopped, self.currentSession else { return }; self.reconnectNow() }
        }
    }
    private var currentSession: Bool { APIClient.shared.webSocketToken == token && APIClient.shared.endpointIdentity == endpointIdentity }
    func connect() {
        guard currentSession, !token.isEmpty else { return }; stopped = false
        if client.isGoV2, conversationID != nil {
            fastTextEnabled = false
            if Self.goReadyScope == relayScope { handleGo(["type": "ready"]) }
            return
        }
        if task == nil && reconnectWork == nil && ticketWork == nil { open() }
    }
    func close() {
        publishGoDisconnect()
        finishText(.failure(RealtimeTextSendFailure.unavailable))
        stopped = true; generation = UUID(); reconnectWork?.cancel(); reconnectWork = nil
        ticketWork?.cancel(); ticketWork = nil
        heartbeatWork?.cancel(); heartbeatWork = nil
        task?.cancel(with: .normalClosure, reason: nil); task = nil
        session?.invalidateAndCancel(); session = nil; connected = false; authenticated = false
    }
    func reconnectNow() { close(); retryDelay = 1; connect() }

    /// One acknowledged submission at a time preserves the conversation's send order.
    func sendQueuedText(conversationID: Int, senderID: Int, body: [String: Any], requestID: String) async throws -> Message {
        guard connected, authenticated, !stopped, currentSession, fastTextEnabled,
              endpoint == APIClient.shared.webSocketURL,
              self.conversationID == conversationID, senderID > 0, !requestID.isEmpty,
              textSubmission == nil, let socket = task else { throw RealtimeTextSendFailure.unavailable }
        let object: [String: Any] = ["type": "message", "conversation_id": conversationID,
                                   "message_type": "text", "body": body, "request_id": requestID]
        let bytes = try JSONSerialization.data(withJSONObject: object)
        guard bytes.count <= 65_536, let text = String(data: bytes, encoding: .utf8) else { throw RealtimeTextSendFailure.unavailable }
        let operation = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                    guard let self, self.textSubmission?.operation == operation else { return }
                    // A server without ACK support must not delay every queued message.
                    self.fastTextEnabled = false
                    self.finishText(.failure(RealtimeTextSendFailure.unavailable))
                }
                textSubmission = TextSubmission(operation: operation, requestID: requestID, senderID: senderID,
                                                continuation: continuation, timeout: timeout)
                socket.send(.string(text)) { [weak self] error in
                    guard error != nil else { return }
                    Task { @MainActor [weak self] in
                        guard let self, self.textSubmission?.operation == operation else { return }
                        self.retry(socket)
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.textSubmission?.operation == operation else { return }
                self.finishText(.failure(CancellationError()))
            }
        }
    }

    private func finishText(_ result: Result<Message, Error>) {
        guard let submission = textSubmission else { return }
        textSubmission = nil; submission.timeout.cancel()
        submission.continuation.resume(with: result)
    }
    private func open() {
        guard !stopped, currentSession, task == nil else { return }
        generation = UUID(); let current = generation
        connected = false; authenticated = false
        openedAt = ProcessInfo.processInfo.systemUptime; receivedAt = openedAt; pingAt = openedAt
        if client.isGoV2 { guard conversationID == nil else { return }; openGo(generation: current); return }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        let session = URLSession(configuration: configuration); self.session = session
        endpoint = APIClient.shared.webSocketURL; failedRouteAPI = VerifiedRoutes.shared.current.apiURL
        let socket = session.webSocketTask(with: endpoint); task = socket; socket.resume()
        send(["type": "auth", "token": token, "client_platform": "ios", "client_version": APIClient.appVersion])
        receive(socket, generation: current)
        startHeartbeat(socket, generation: current)
    }
    private func openGo(generation current: UUID) {
        ticketWork = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let url = try await self.client.goWebSocketURL()
                guard !Task.isCancelled, !self.stopped, self.currentSession, self.generation == current else { return }
                self.ticketWork = nil
                self.openedAt = ProcessInfo.processInfo.systemUptime; self.receivedAt = self.openedAt; self.pingAt = self.openedAt
                let configuration = URLSessionConfiguration.ephemeral
                configuration.httpCookieStorage = nil; configuration.urlCache = nil
                let session = URLSession(configuration: configuration, delegate: GoV2NoRedirect(), delegateQueue: nil)
                self.session = session
                let socket = session.webSocketTask(with: url); self.task = socket
                self.fastTextEnabled = false
                socket.resume(); self.receive(socket, generation: current); self.startHeartbeat(socket, generation: current)
            } catch {
                guard !Task.isCancelled, !self.stopped, self.currentSession, self.generation == current else { return }
                self.ticketWork = nil
                if let failure = error as? GoV2Error, case .http(401, _) = failure {
                    self.close()
                    NotificationCenter.default.post(name: .pulseSessionBlocked, object: "auth.revoked", userInfo: ["session_token": self.token, "endpoint_identity": self.endpointIdentity])
                    return
                }
                let delay = self.retryDelay; self.retryDelay = min(30, delay * 2)
                self.reconnectWork = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    guard let self, !self.stopped, self.currentSession else { return }
                    self.reconnectWork = nil; self.open()
                }
            }
        }
    }
    private func send(_ object: [String: Any]) {
        guard !stopped, let socket = task, let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        let current = generation
        socket.send(.string(text)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in guard let self, self.generation == current, self.task === socket else { return }; self.retry(socket) }
        }
    }
    private func receive(_ socket: URLSessionWebSocketTask, generation current: UUID) {
        guard !stopped, generation == current, task === socket else { return }
        socket.receive { [weak self] result in
            Task { @MainActor in
                guard let self, !self.stopped, self.generation == current, self.task === socket else { return }
                guard self.currentSession else { self.close(); return }
                switch result {
                case .success(let message): self.receivedAt = ProcessInfo.processInfo.systemUptime; self.handle(message); self.receive(socket, generation: current)
                case .failure: self.retry(socket)
                }
            }
        }
    }
    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message, let data = text.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { return }
        if type == "auth.revoked" || type == "client.update_required" {
            finishText(.failure(RealtimeTextSendFailure.rejected("登录状态或客户端版本已失效，请重新登录或更新。")))
            close(); NotificationCenter.default.post(name: .pulseSessionBlocked, object: type, userInfo: ["session_token": token, "endpoint_identity": endpointIdentity]); return
        }
        if client.isGoV2 {
            handleGo(object)
            if conversationID == nil {
                NotificationCenter.default.post(name: Self.goRelay, object: nil, userInfo: ["scope": relayScope, "payload": object])
            }
            return
        }
        if type == "auth.ok" {
            authenticated = true
            if let conversationID { send(["type": "subscribe", "conversation_id": conversationID]) }
            else { send(["type": "inbox.subscribe"]) }
        }
        let ready = conversationID == nil ? type == "inbox.subscribe.ok" : type == "subscribe.ok" && (object["conversation_id"] as? Int) == conversationID
        if ready {
            connected = true; fastTextEnabled = true; retryDelay = 1; subscriptionRevision += 1; onReady()
        }
        if type == "error", textSubmission != nil {
            let reason = object["message"] as? String ?? "消息发送未获确认"
            if reason.lowercased().contains("unsupported websocket event") {
                fastTextEnabled = false; finishText(.failure(RealtimeTextSendFailure.unavailable))
            } else if object["code"] as? String == "REQUEST_REJECTED", object["retryable"] as? Bool != true {
                finishText(.failure(RealtimeTextSendFailure.rejected(reason)))
            } else { finishText(.failure(RealtimeTextSendFailure.unavailable)) }
        }
        if type == "error", (object["retryable"] as? Bool) == true || !connected {
            if let socket = task { retry(socket) }; return
        }
        if type == "notification.updated", conversationID == nil { onNotificationUpdate() }
        if type == "conversation.updated", conversationID == nil, let payload = object["data"] as? [String: Any], let id = payload["conversation_id"] as? Int, id > 0 {
            onConversationUpdate(id)
        }
        if type == "conversation.updated", let conversationID, let payload = object["data"] as? [String: Any],
           payload["conversation_id"] as? Int == conversationID { metadataRevision += 1 }
        if type == "message.deleted", let payload = object["data"], let payloadData = try? JSONSerialization.data(withJSONObject: payload), let deletion = try? JSONDecoder().decode(PersonalMessageDeletion.self, from: payloadData) {
            if conversationID == nil { onConversationUpdate(deletion.conversationId) }
            else if deletion.conversationId == conversationID { lastPersonalDeletion = deletion }
        }
        if ["message.ack", "message.new", "message.updated", "message.recalled"].contains(type), let payload = object["data"], let payloadData = try? JSONSerialization.data(withJSONObject: payload), let message = try? JSONDecoder().decode(Message.self, from: payloadData), message.conversationId == conversationID {
            if let submission = textSubmission,
               IOSMessageDelivery.matches(message, requestID: submission.requestID, conversationID: conversationID ?? 0, senderID: submission.senderID) {
                finishText(.success(message))
            }
            if type != "message.ack" { lastMessage = message; onMessage(message) }
        }
        if type == "conversation.pins", let payload = object["data"], let payloadData = try? JSONSerialization.data(withJSONObject: payload), let snapshot = try? JSONDecoder().decode(MessagePinsSnapshot.self, from: payloadData), snapshot.conversationId == conversationID {
            lastPinsSnapshot = snapshot
        }
    }
    /// Go keeps exactly one socket per login. Chat pages observe the app inbox
    /// instead of opening competing sockets that would evict each other.
    private func observeGoRelay() {
        guard client.isGoV2, conversationID != nil else { return }
        relayObserver = NotificationCenter.default.addObserver(forName: Self.goRelay, object: nil, queue: .main) { [weak self] notification in
            let scope = notification.userInfo?["scope"] as? String
            let object = notification.userInfo?["payload"] as? [String: Any]
            Task { @MainActor [weak self] in
                guard let self, !self.stopped, self.currentSession, scope == self.relayScope, let object else { return }
                self.handleGo(object)
            }
        }
    }
    private func handleGo(_ object: [String: Any]) {
        let type = object["type"] as? String ?? ""
        if type == "disconnected" { connected = false; authenticated = false; return }
        if type == "ready" {
            if conversationID == nil { Self.goReadyScope = relayScope }
            authenticated = true; connected = true; fastTextEnabled = false; retryDelay = 1; subscriptionRevision += 1; onReady()
        } else if type.hasSuffix(".changed") {
            if let wire = object["conversation_id"] as? String, let id = try? client.goConversationID(wire) {
                if conversationID == nil { onConversationUpdate(id) }
                else if conversationID == id {
                    if ["membership.changed", "personal.changed"].contains(type) { historyInvalidationRevision += 1 }
                    metadataRevision += 1; subscriptionRevision += 1
                }
            } else { onNotificationUpdate() }
        }
    }
    private func publishGoDisconnect() {
        guard client.isGoV2, conversationID == nil else { return }
        if Self.goReadyScope == relayScope { Self.goReadyScope = nil }
        NotificationCenter.default.post(name: Self.goRelay, object: nil, userInfo: ["scope": relayScope, "payload": ["type": "disconnected"]])
    }
    private func startHeartbeat(_ socket: URLSessionWebSocketTask, generation current: UUID) {
        heartbeatWork?.cancel()
        heartbeatWork = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                guard let self, !self.stopped, self.generation == current, self.task === socket else { return }
                guard self.currentSession else { self.close(); return }
                let now = ProcessInfo.processInfo.systemUptime
                if (!self.connected && now - self.openedAt >= 12) || (self.connected && now - self.receivedAt >= 35) { self.retry(socket); return }
                if self.authenticated && self.textSubmission == nil && now - self.pingAt >= 10 { self.pingAt = now; self.send(["type": "ping"]) }
            }
        }
    }
    private func retry(_ socket: URLSessionWebSocketTask) {
        guard !stopped, task === socket, reconnectWork == nil else { return }
        publishGoDisconnect()
        finishText(.failure(RealtimeTextSendFailure.unavailable))
        generation = UUID(); connected = false
        heartbeatWork?.cancel(); heartbeatWork = nil
        socket.cancel(with: .goingAway, reason: nil); task = nil
        session?.invalidateAndCancel(); session = nil
        let delay = retryDelay; retryDelay = min(30, retryDelay * 2)
        reconnectWork = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, !self.stopped else { return }
            if !self.client.isGoV2, let failed = self.failedRouteAPI { _ = await VerifiedRoutes.shared.failover(failed: failed) }
            guard !Task.isCancelled, !self.stopped, self.currentSession else { return }
            self.reconnectWork = nil; self.open()
        }
    }
}

@MainActor final class IOSTextOutbox: ObservableObject {
    static let shared = IOSTextOutbox()
    enum Phase: Equatable { case queued, sending, failed }
    struct Item: Identifiable {
        let id = "ios-text-\(UUID().uuidString)"
        let client: APIClient
        let token: String
        let actorID: Int
        let endpoint: String
        let conversationID: Int
        let text: String
        let replyToID: Int?
        let mentionUserIDs: [Int]
        let realtime: RealtimeClient?
        var phase: Phase = .queued
        var error = ""
        var lane: Lane { Lane(token: token, actorID: actorID, endpoint: endpoint, conversationID: conversationID) }
    }
    struct Lane: Hashable { let token: String; let actorID: Int; let endpoint: String; let conversationID: Int }
    struct Acceptance { let item: Item; let message: Message }
    @Published private(set) var items: [Item] = []
    @Published private(set) var acceptance: Acceptance?
    private var flights: [Lane: String] = [:]
    private var blockedLanes = Set<Lane>()

    func updateSendPermission(token: String, actorID: Int, endpoint: String, conversationID: Int, allowed: Bool) {
        guard APIClient.shared.webSocketToken == token, APIClient.shared.endpointIdentity == endpoint else { return }
        let lane = Lane(token: token, actorID: actorID, endpoint: endpoint, conversationID: conversationID)
        if allowed { blockedLanes.remove(lane) } else {
            blockedLanes.insert(lane)
            for index in items.indices where items[index].lane == lane && items[index].phase == .queued {
                items[index].phase = .failed; items[index].error = "已禁止发言"
            }
        }
        // An unmute never pumps retained drafts; the user explicitly retries.
    }

    func pending(token: String, actorID: Int?, endpoint: String, conversationID: Int) -> [Item] {
        items.filter { $0.token == token && $0.actorID == actorID && $0.endpoint == endpoint && $0.conversationID == conversationID }
    }
    func enqueue(client: APIClient, token: String, actorID: Int, endpoint: String, conversationID: Int, text: String, replyToID: Int?, mentionUserIDs: [Int] = [], realtime: RealtimeClient? = nil) {
        let item = Item(client: client, token: token, actorID: actorID, endpoint: endpoint, conversationID: conversationID, text: text, replyToID: replyToID, mentionUserIDs: mentionUserIDs, realtime: realtime)
        items.append(item)
        // The composer is cleared synchronously before this task starts network work.
        Task { pump(item.lane) }
    }
    func retry(_ id: String) {
        guard let index = items.firstIndex(where: { $0.id == id && $0.phase == .failed }), allowed(items[index]) else { return }
        items[index].phase = .queued; items[index].error = ""
        pump(items[index].lane)
    }
    func discard(_ id: String) {
        guard let item = items.first(where: { $0.id == id && $0.phase == .failed }),
              APIClient.shared.webSocketToken == item.token, APIClient.shared.endpointIdentity == item.endpoint else { return }
        items.removeAll { $0.id == id }; pump(item.lane)
    }
    func confirm(_ message: Message, token: String, actorID: Int?, endpoint: String) {
        guard let request = message.body["request_id"]?.stringValue,
              let item = items.first(where: { $0.id == request && $0.token == token && $0.actorID == actorID && $0.endpoint == endpoint }),
              matches(item, message) else { return }
        // Realtime can settle a submission before its HTTP response arrives.
        items.removeAll { $0.id == item.id }
        if flights[item.lane] == item.id { flights[item.lane] = nil }
        pump(item.lane)
    }
    private func allowed(_ item: Item) -> Bool {
        APIClient.shared.webSocketToken == item.token && APIClient.shared.endpointIdentity == item.endpoint && !blockedLanes.contains(item.lane)
    }
    private func matches(_ item: Item, _ message: Message) -> Bool {
        IOSMessageDelivery.matches(message, requestID: item.id, conversationID: item.conversationID, senderID: item.actorID)
    }
    private func submit(_ item: Item, body: [String: Any]) async throws -> Message {
        guard !Task.isCancelled, allowed(item) else { throw CancellationError() }
        if let realtime = item.realtime {
            do {
                return try await realtime.sendQueuedText(conversationID: item.conversationID, senderID: item.actorID, body: body, requestID: item.id)
            } catch {
                if error is CancellationError { throw error }
                if let failure = error as? RealtimeTextSendFailure, case .rejected = failure { throw error }
            }
        }
        guard !Task.isCancelled, allowed(item) else { throw CancellationError() }
        return try await item.client.sendRawMessage(conversationID: item.conversationID, type: "text", body: body, requestID: item.id)
    }
    private func pump(_ lane: Lane) {
        guard flights[lane] == nil, let index = items.firstIndex(where: { $0.lane == lane }), items[index].phase == .queued else { return }
        guard allowed(items[index]) else { items[index].phase = .failed; items[index].error = blockedLanes.contains(lane) ? "已禁止发言" : "账号或服务器已切换，请返回原账号重试"; return }
        items[index].phase = .sending
        let item = items[index]; flights[lane] = item.id
        Task {
            do {
                var body: [String: Any] = ["text": item.text]
                if let replyToID = item.replyToID { body["reply_to_id"] = replyToID }
                if !item.mentionUserIDs.isEmpty { body["mention_user_ids"] = item.mentionUserIDs }
                let message = try await submit(item, body: body)
                if items.contains(where: { $0.id == item.id }) {
                    guard matches(item, message) else { throw NSError(domain: "TextOutbox", code: 1, userInfo: [NSLocalizedDescriptionKey: "消息回执无效，请重试"]) }
                    items.removeAll { $0.id == item.id }
                    acceptance = Acceptance(item: item, message: message)
                }
            } catch {
                if let index = items.firstIndex(where: { $0.id == item.id }) { items[index].phase = .failed; items[index].error = error.localizedDescription }
            }
            if flights[lane] == item.id { flights[lane] = nil }
            pump(lane)
        }
    }
}


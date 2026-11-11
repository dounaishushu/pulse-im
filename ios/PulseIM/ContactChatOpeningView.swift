import SwiftUI

/// Captured at the tap so returning or switching accounts cannot redirect a late reply.
struct IOSContactChatRequest: Identifiable {
    let id = UUID()
    let userID: Int
    let title: String
    let actorID: Int
    let token: String
    let client: APIClient
    let cachedConversation: Conversation?

    @MainActor init?(userID: Int, title: String, session: AppSession) {
        guard session.isSignedIn, let actorID = session.user?.id, let token = session.token,
              userID > 0, userID != actorID else { return nil }
        self.userID = userID; self.title = title; self.actorID = actorID; self.token = token
        self.client = APIClient.shared.captureSession()
        self.cachedConversation = session.conversations.first { $0.id > 0 && $0.type == "direct" && $0.peerUserId == userID }
    }
}

/// One presentation owns both the opening feedback and its resulting chat.
/// The contacts list never waits in a disabled state behind a network operation.
@MainActor struct ContactChatOpeningView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    let request: IOSContactChatRequest
    @State private var conversation: Conversation?
    @State private var attempt = UUID()
    @State private var error = ""

    init(request: IOSContactChatRequest) {
        self.request = request
        _conversation = State(initialValue: request.cachedConversation)
    }
    private var current: Bool {
        session.isSignedIn && session.token == request.token && session.user?.id == request.actorID
            && request.client.endpointIdentity == APIClient.shared.endpointIdentity && !appLock.isLocked && !session.updateRequired
    }
    var body: some View {
        Group {
            if let conversation { ChatView(conversation: conversation, actorID: request.actorID) }
            else {
                VStack(spacing: 0) {
                    ZStack {
                        Text(request.title.isEmpty ? "聊天" : request.title).font(.system(size: 18, weight: .semibold)).lineLimit(1).padding(.horizontal, 54)
                        HStack {
                            Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).frame(width: 48, height: 48) }
                                .accessibilityLabel("返回联系人").accessibilityIdentifier("contact_chat_open_back")
                            Spacer()
                        }
                    }.frame(height: 52).background(PulsePalette.surface)
                    Divider()
                    Spacer()
                    if error.isEmpty {
                        ProgressView().tint(Color(red: 0.20, green: 0.60, blue: 0.86)).scaleEffect(1.3).padding(.bottom, 20)
                        Text("正在打开会话…").font(.subheadline).foregroundStyle(PulsePalette.muted)
                    } else {
                        Text(error).font(.subheadline).foregroundStyle(PulsePalette.muted).multilineTextAlignment(.center).padding(.horizontal, 24)
                        Button("重新打开") { error = ""; attempt = UUID() }.buttonStyle(.borderedProminent).padding(.top, 18)
                    }
                    Spacer()
                }
                .background(PulsePalette.background)
                .toolbar(.hidden, for: .navigationBar)
                .accessibilityIdentifier("contact_chat_opening")
            }
        }
        .task(id: attempt) { await open() }
        .pulseOnChange(of: session.token) { _ in if !current { dismiss() } }
        .pulseOnChange(of: session.user?.id) { _ in if !current { dismiss() } }
        .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in if !current { dismiss() } }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { dismiss() } }
        .pulseOnChange(of: session.updateRequired) { required in if required { dismiss() } }
    }
    @MainActor private func open() async {
        guard current else { dismiss(); return }
        guard conversation == nil else { return }
        let generation = attempt
        do {
            let result = try await request.client.createDirectConversation(userID: request.userID)
            guard !Task.isCancelled, attempt == generation else { return }
            guard current else { dismiss(); return }
            guard result.id > 0, result.type == "direct", result.peerUserId == nil || result.peerUserId == request.userID else { throw APIClientError.invalidResponse }
            conversation = result
            Task { if current { try? await session.refreshConversations() } }
        } catch {
            guard !Task.isCancelled, attempt == generation else { return }
            guard current else { dismiss(); return }
            self.error = error.localizedDescription
        }
    }
}

import SwiftUI

struct EditMessageView: View {
    let message: Message
    let onUpdated: (Message) -> Void
    private let client: APIClient
    private let openingToken: String
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var error = ""
    @State private var isSaving = false
    @State private var isVisible = false

    init(message: Message, onUpdated: @escaping (Message) -> Void) {
        self.message = message
        self.onUpdated = onUpdated
        self.client = APIClient.shared.captureSession()
        self.openingToken = APIClient.shared.webSocketToken
        _text = State(initialValue: message.body["text"]?.stringValue ?? "")
    }

    private var canEdit: Bool {
        session.user?.id == message.senderId && message.type == "text" && message.recalledAt == nil &&
        (client.isGoV2 || session.user?.internalStaff == true)
    }
    var body: some View {
        PulseNavigationStack {
            Form { TextField("消息内容", text: $text, axis: .vertical).lineLimit(3...8) }
                .navigationTitle("编辑消息")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(isSaving || !canEdit || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }
                .alert("编辑失败", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") {} } message: { Text(error) }
        }
        .onAppear { isVisible = true; if !canEdit { dismiss() } }
        .onDisappear { isVisible = false }
        .pulseOnChange(of: session.token) { token in if token != openingToken { dismiss() } }
        .pulseOnChange(of: session.user?.internalStaff) { enabled in if !client.isGoV2 && enabled != true { dismiss() } }
    }

    private func save() {
        guard isVisible, !isSaving, session.token == openingToken, canEdit else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                if !client.isGoV2 { guard try await session.verifyInternalStaffForMessageActions() else { dismiss(); return } }
                guard isVisible, canEdit, session.token == openingToken, client.endpointIdentity == APIClient.shared.endpointIdentity else { dismiss(); return }
                let updated = try await client.editMessage(message, text: text.trimmingCharacters(in: .whitespacesAndNewlines))
                guard isVisible, session.token == openingToken else { return }
                onUpdated(updated)
                dismiss()
            } catch { if isVisible, session.token == openingToken { self.error = error.localizedDescription } }
        }
    }
}

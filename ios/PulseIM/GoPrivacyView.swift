import SwiftUI

struct GoPrivacyView: View {
    let invitations: Bool
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @State private var client: APIClient?
    @State private var snapshot: GoContactPrivacy?
    @State private var rule = GoPrivacyRule(visibility: "everyone", allow: [], deny: [])
    @State private var names: [String: String] = [:]
    @State private var account = ""
    @State private var busy = false
    @State private var error = ""
    private var active: Bool {
        client?.webSocketToken == session.token && client?.endpointIdentity == APIClient.shared.endpointIdentity && !appLock.isLocked && scenePhase == .active && !session.updateRequired
    }
    private var editable: Bool { snapshot != nil && (!invitations || snapshot?.canManageGroupInvites == true) }
    var body: some View {
        Form {
            Section(invitations ? "谁能邀请我入群" : "谁能发起临时聊天") {
                Picker("允许范围", selection: $rule.visibility) {
                    Text("所有人").tag("everyone")
                    Text("联系人").tag("contacts")
                    Text("无人").tag("nobody")
                }.disabled(!editable)
                if !invitations { Text("此设置用于非好友。已拉黑的账号不能联系您。").font(.footnote).foregroundStyle(.secondary) }
            }
            exceptionSection("始终允许", ids: rule.allow, allow: true)
            exceptionSection("始终拒绝", ids: rule.deny, allow: false)
            Section("添加例外账号") {
                TextField("完整账号", text: $account).textInputAutocapitalization(.never).autocorrectionDisabled()
                HStack {
                    Button("加入允许名单") { Task { await addException(allow: true) } }
                    Spacer()
                    Button("加入拒绝名单") { Task { await addException(allow: false) } }
                }.disabled(!editable || account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("例外名单不能越过拉黑限制。").font(.footnote).foregroundStyle(.secondary)
            }
            if invitations, snapshot != nil, !editable { Text("当前账号不能修改邀请隐私。") }
            if !error.isEmpty { Text(error).foregroundStyle(PulsePalette.danger) }
            if snapshot == nil || !error.isEmpty { Button("重新加载") { Task { await load() } } }
        }
        .disabled(busy || !active)
        .navigationTitle(invitations ? "群邀请隐私" : "临时聊天隐私")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(!editable || busy || !active) } }
        .task { await load() }
        .pulseOnChange(of: session.token) { _ in dismiss() }
        .pulseOnChange(of: appLock.isLocked) { if $0 { dismiss() } }
        .pulseOnChange(of: session.updateRequired) { if $0 { dismiss() } }
    }
    private func exceptionSection(_ title: String, ids: [String], allow: Bool) -> some View {
        Section(title) {
            ForEach(ids, id: \.self) { id in
                HStack {
                    Text(names[id] ?? "账号资料待刷新")
                    Spacer()
                    Button("移除", role: .destructive) { if allow { rule.allow.removeAll { $0 == id } } else { rule.deny.removeAll { $0 == id } } }
                }
            }
            if ids.isEmpty { Text("暂无例外").foregroundStyle(.secondary) }
        }.disabled(!editable)
    }
    @MainActor private func load() async {
        guard !busy else { return }
        let captured = APIClient.shared.captureSession(); client = captured
        busy = true; error = ""; defer { busy = false }
        do {
            let result = try await captured.goPrivacy(); guard active, !Task.isCancelled else { return }
            snapshot = result; rule = invitations ? result.groupInvites : result.temporaryChat
            names = Dictionary((result.exceptionUsers ?? []).map { ($0.id, $0.account) }, uniquingKeysWith: { first, _ in first })
        } catch { if active { self.error = error.localizedDescription } }
    }
    @MainActor private func addException(allow: Bool) async {
        guard active, editable, !busy, let client else { return }
        let name = account.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true; error = ""; defer { busy = false }
        do {
            let user = try await client.goPrivacyAccount(name); guard active, !Task.isCancelled else { return }
            rule.allow.removeAll { $0 == user.id }; rule.deny.removeAll { $0 == user.id }
            if allow { rule.allow.append(user.id) } else { rule.deny.append(user.id) }
            names[user.id] = user.account; account = ""
        } catch { if active { self.error = error.localizedDescription } }
    }
    @MainActor private func save() async {
        guard active, editable, !busy, let client, let snapshot else { return }
        busy = true; error = ""; defer { busy = false }
        do {
            _ = try await client.updateGoPrivacy(["expected_version": snapshot.version, invitations ? "group_invites" : "temporary_chat": rule.dictionary])
            guard active, !Task.isCancelled else { return }; dismiss()
        } catch { if active { self.error = error.localizedDescription } }
    }
}

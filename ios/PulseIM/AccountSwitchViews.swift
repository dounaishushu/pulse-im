import SwiftUI

struct IOSLoginScreen: View {
    @EnvironmentObject private var session: AppSession
    @State private var showingAccounts = false
    var body: some View {
        LoginView()
            .overlay(alignment: .topTrailing) {
                if !session.savedAccounts.isEmpty {
                    Button("已保存账号") { showingAccounts = true }
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(PulsePalette.accent)
                        .padding(.horizontal, 14).padding(.vertical, 10).background(.white, in: Capsule())
                        .padding(.top, 38).padding(.trailing, 18)
                        .accessibilityIdentifier("auth_saved_accounts")
                }
            }
            .pulseSheet(isPresented: $showingAccounts) { IOSSavedAccountsView(allowsAdding: false) }
    }
}

struct IOSAddAccountView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("取消") { dismiss() }.accessibilityIdentifier("add_account_cancel")
                Spacer()
                Text("添加账号").font(.headline)
                Spacer()
                Text("取消").hidden().accessibilityHidden(true)
            }
            .padding(.horizontal, 20).frame(height: 48).background(PulsePalette.surface)
            Text("原账号会保留，登录成功后切换至新账号")
                .font(.system(size: 12)).foregroundStyle(PulsePalette.muted)
                .frame(maxWidth: .infinity).padding(.bottom, 10).background(PulsePalette.surface)
            LoginView(addingAccount: true, onAuthenticated: { dismiss() })
                .ignoresSafeArea(edges: .bottom)
        }
        .background(PulsePalette.surface).statusBar(hidden: false)
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { dismiss() } }
    }
}

struct IOSSavedAccountsView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    var allowsAdding = true
    @State private var showingAddAccount = false
    @State private var operation: Task<Void, Never>?
    @State private var error = ""

    var body: some View {
        PulseNavigationStack {
            List {
                Section("已登录账号") {
                    ForEach(session.savedAccounts) { account in
                        Button { select(account) } label: {
                            HStack(spacing: 12) {
                                PulseAvatar(title: account.nickname.isEmpty ? account.account : account.nickname, size: 42)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(account.nickname.isEmpty ? account.account : account.nickname).foregroundStyle(PulsePalette.ink)
                                    Text(account.account.isEmpty ? "用户 ID：\(account.userID)" : account.account)
                                        .font(.caption).foregroundStyle(PulsePalette.muted)
                                }
                                Spacer()
                                if isCurrent(account) { Image(systemName: "checkmark.circle.fill").foregroundStyle(PulsePalette.accent) }
                            }.contentShape(Rectangle())
                        }
                        .disabled(session.changingAccount || isCurrent(account))
                        .accessibilityIdentifier("saved_account_\(account.userID)")
                    }
                }
                if session.changingAccount { HStack { ProgressView(); Text("正在验证账号…") } }
                if !error.isEmpty { Text(error).foregroundStyle(PulsePalette.danger).accessibilityIdentifier("account_switch_error") }
                if allowsAdding {
                    Section { Button { showingAddAccount = true } label: { Label("添加账号", systemImage: "plus.circle") }.disabled(session.changingAccount) }
                }
            }
            .navigationTitle("切换账号").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { operation?.cancel(); dismiss() } } }
        }
        .pulseFullScreenCover(isPresented: $showingAddAccount) { IOSAddAccountView() }
        .onDisappear { operation?.cancel() }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { operation?.cancel(); dismiss() } }
    }
    private func isCurrent(_ account: SavedAccount) -> Bool { session.isSignedIn && session.user?.id == account.userID && account.server == APIClient.shared.serverIdentity }
    private func select(_ account: SavedAccount) {
        guard !session.changingAccount else { return }
        operation?.cancel(); error = ""
        operation = Task {
            let succeeded = await session.switchAccount(account)
            guard !Task.isCancelled else { return }
            if succeeded { dismiss() } else { error = session.error }
        }
    }
}

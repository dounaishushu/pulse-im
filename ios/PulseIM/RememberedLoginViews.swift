import SwiftUI

@MainActor struct IOSRememberedLoginPicker: View {
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    let server: String
    let selected: (RememberedLoginAccount) -> Void
    let removed: (RememberedLoginAccount) -> Void
    @State private var rows: [RememberedLoginAccount] = []
    @State private var error = ""
    var body: some View {
        NavigationStack {
            List {
                ForEach(rows) { row in
                    HStack {
                        Button {
                            guard !appLock.isLocked else { return }
                            selected(row); dismiss()
                        } label: {
                            HStack(spacing: 12) {
                                PulseAvatar(title: row.nickname.isEmpty ? row.account : row.nickname, size: 40, avatarURL: row.avatarURL)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(row.nickname.isEmpty ? row.account : row.nickname).foregroundStyle(PulsePalette.ink)
                                    Text(row.account).font(.caption).foregroundStyle(PulsePalette.muted)
                                }
                                Spacer()
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("remembered_account_\(row.id)")
                        Button { remove(row) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).padding(8) }
                            .buttonStyle(.borderless).accessibilityLabel("移除已记住的账号 \(row.account)")
                    }
                }
                if rows.isEmpty { Text("登录成功后可在这里选择账号").foregroundStyle(.secondary) }
                if !error.isEmpty { Text(error).foregroundStyle(PulsePalette.danger) }
            }
            .navigationTitle("已保存账号（最多10个）").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .task { do { rows = try IOSRememberedLogins.accounts(server: server) } catch { self.error = error.localizedDescription } }
        }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { dismiss() } }
    }
    private func remove(_ row: RememberedLoginAccount) {
        guard !appLock.isLocked else { return }
        do { try IOSRememberedLogins.remove(server: server, id: row.id); rows.removeAll { $0.id == row.id }; removed(row) }
        catch { self.error = error.localizedDescription }
    }
}

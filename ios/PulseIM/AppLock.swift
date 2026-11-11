import SwiftUI
import Combine
import CryptoKit
import LocalAuthentication
import Security

enum AppPasscodeKind: String, Equatable {
    case fourDigit = "four_digit"
    case custom = "custom"
}

@MainActor
final class AppLockManager: ObservableObject {
    @Published private(set) var hasPasscode: Bool
    @Published private(set) var isLocked = false
    @Published private(set) var faceIDEnabled: Bool
    @Published private(set) var autoLockSeconds: Int
    @Published private(set) var passcodeKind: AppPasscodeKind
    @Published private(set) var faceIDAvailable = false

    private let defaults = UserDefaults.standard
    private let lastBackgroundKey = "pulse_app_lock_last_background"
    private let faceIDKey = "pulse_app_lock_face_id"
    private let autoLockKey = "pulse_app_lock_auto_lock_seconds"
    private let passcodeKindKey = "pulse_app_lock_passcode_kind"
    private let keychainService = "com.pulseim.app.lock"
    private let keychainAccount = "passcode-hash"

    init() {
        hasPasscode = Self.readKeychain(service: "com.pulseim.app.lock", account: "passcode-hash") != nil
        faceIDEnabled = defaults.bool(forKey: faceIDKey)
        autoLockSeconds = defaults.object(forKey: autoLockKey) == nil ? 0 : defaults.integer(forKey: autoLockKey)
        passcodeKind = AppPasscodeKind(rawValue: defaults.string(forKey: passcodeKindKey) ?? "four_digit") ?? .fourDigit
        refreshFaceIDAvailability()
        lockIfNeeded()
    }

    var autoLockTitle: String {
        switch autoLockSeconds {
        case 60: return "离开 1 分钟后"
        case 300: return "离开 5 分钟后"
        case 3600: return "离开 1 小时后"
        case 18000: return "离开 5 小时后"
        default: return "停用"
        }
    }

    func setPasscode(_ code: String, kind: AppPasscodeKind) throws {
        try validate(code, kind: kind)
        guard Self.saveKeychain(Self.digest(code), service: keychainService, account: keychainAccount) else {
            throw AppLockError.keychainFailure
        }
        passcodeKind = kind
        hasPasscode = true
        isLocked = false
        faceIDEnabled = false
        autoLockSeconds = 0
        defaults.set(kind.rawValue, forKey: passcodeKindKey)
        defaults.set(false, forKey: faceIDKey)
        defaults.set(0, forKey: autoLockKey)
        defaults.removeObject(forKey: lastBackgroundKey)
    }

    func changePasscode(current: String, newCode: String, kind: AppPasscodeKind) throws {
        guard verify(current) else { throw AppLockError.invalidCurrentPasscode }
        let previousFaceID = faceIDEnabled
        let previousAutoLock = autoLockSeconds
        try setPasscode(newCode, kind: kind)
        faceIDEnabled = previousFaceID
        autoLockSeconds = previousAutoLock
        defaults.set(previousFaceID, forKey: faceIDKey)
        defaults.set(previousAutoLock, forKey: autoLockKey)
    }

    func verify(_ code: String) -> Bool {
        guard let saved = Self.readKeychain(service: keychainService, account: keychainAccount) else { return false }
        return saved == Self.digest(code)
    }

    func removePasscode() {
        Self.deleteKeychain(service: keychainService, account: keychainAccount)
        hasPasscode = false
        isLocked = false
        faceIDEnabled = false
        autoLockSeconds = 0
        defaults.removeObject(forKey: faceIDKey)
        defaults.removeObject(forKey: autoLockKey)
        defaults.removeObject(forKey: passcodeKindKey)
        defaults.removeObject(forKey: lastBackgroundKey)
    }

    func setAutoLock(seconds: Int) {
        autoLockSeconds = max(0, seconds)
        defaults.set(autoLockSeconds, forKey: autoLockKey)
    }

    func enableFaceID() async -> Bool {
        guard hasPasscode, faceIDAvailable else { return false }
        guard await authenticateWithFaceID() else { return false }
        faceIDEnabled = true
        defaults.set(true, forKey: faceIDKey)
        return true
    }

    func disableFaceID() {
        faceIDEnabled = false
        defaults.set(false, forKey: faceIDKey)
    }

    func unlock(with code: String) -> Bool {
        guard verify(code) else { return false }
        isLocked = false
        defaults.removeObject(forKey: lastBackgroundKey)
        return true
    }

    func authenticateAndUnlock() async -> Bool {
        guard isLocked, faceIDEnabled else { return false }
        guard await authenticateWithFaceID() else { return false }
        isLocked = false
        defaults.removeObject(forKey: lastBackgroundKey)
        return true
    }

    func recordBackground() {
        guard hasPasscode else { return }
        defaults.set(Date().timeIntervalSince1970, forKey: lastBackgroundKey)
    }

    func checkWhenActive() {
        lockIfNeeded()
    }

    private func lockIfNeeded() {
        guard hasPasscode, autoLockSeconds > 0 else { return }
        let timestamp = defaults.double(forKey: lastBackgroundKey)
        guard timestamp > 0, Date().timeIntervalSince1970 - timestamp >= Double(autoLockSeconds) else { return }
        isLocked = true
    }

    private func validate(_ code: String, kind: AppPasscodeKind) throws {
        if kind == .fourDigit {
            guard code.count == 4, code.allSatisfy({ $0.isNumber }) else { throw AppLockError.invalidFourDigitPasscode }
        } else {
            guard (4...32).contains(code.count) else { throw AppLockError.invalidCustomPasscode }
        }
    }

    private func refreshFaceIDAvailability() {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        faceIDAvailable = context.biometryType == .faceID
    }

    private func authenticateWithFaceID() async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error), context.biometryType == .faceID else { return false }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "使用 Face ID 解锁应用") { success, _ in
                continuation.resume(returning: success)
            }
        }
    }

    private static func digest(_ value: String) -> Data { Data(SHA256.hash(data: Data(value.utf8))) }

    private static func readKeychain(service: String, account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    private static func saveKeychain(_ value: Data, service: String, account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { return SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess }
        return status == errSecSuccess
    }

    private static func deleteKeychain(service: String, account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}

enum AppLockError: LocalizedError {
    case invalidFourDigitPasscode
    case invalidCustomPasscode
    case invalidCurrentPasscode
    case passcodesDoNotMatch
    case keychainFailure

    var errorDescription: String? {
        switch self {
        case .invalidFourDigitPasscode: return "请输入 4 位数字锁定码。"
        case .invalidCustomPasscode: return "自定义锁定码长度需要为 4 至 32 位。"
        case .invalidCurrentPasscode: return "当前锁定码不正确。"
        case .passcodesDoNotMatch: return "两次输入的锁定码不一致。"
        case .keychainFailure: return "锁定码保存失败，请稍后重试。"
        }
    }
}

struct IOSAppLockScreen: View {
    @EnvironmentObject private var appLock: AppLockManager
    @State private var code = ""
    @State private var error = ""

    var body: some View {
        ZStack {
            PulsePalette.background.ignoresSafeArea()
            VStack(spacing: 22) {
                Spacer()
                Image(systemName: "lock.fill")
                    .font(.system(size: 38, weight: .semibold))
                    .foregroundStyle(PulsePalette.accent)
                    .frame(width: 84, height: 84)
                    .background(PulsePalette.accentSoft)
                    .clipShape(Circle())
                Text("应用已锁定").font(.system(size: 27, weight: .bold)).foregroundStyle(PulsePalette.ink)
                Text("请输入锁定码以继续使用\(PulseApp.name)")
                    .font(.system(size: 15))
                    .foregroundStyle(PulsePalette.muted)
                SecureField(appLock.passcodeKind == .fourDigit ? "四位数字锁定码" : "锁定码", text: $code)
                    .keyboardType(appLock.passcodeKind == .fourDigit ? .numberPad : .default)
                    .textContentType(.password)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
                    .frame(height: 52)
                    .background(PulsePalette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(PulsePalette.line, lineWidth: 1))
                    .padding(.horizontal, 42)
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(PulsePalette.danger) }
                Button("解锁") {
                    if appLock.unlock(with: code) { code = ""; error = "" } else { error = "锁定码不正确，请重新输入。" }
                }
                .buttonStyle(PulsePrimaryButtonStyle())
                .padding(.horizontal, 42)
                if appLock.faceIDEnabled {
                    Button {
                        Task { if !(await appLock.authenticateAndUnlock()) { error = "Face ID 验证失败，请使用锁定码解锁。" } }
                    } label: {
                        Label("使用 Face ID 解锁", systemImage: "faceid")
                            .font(.system(size: 16, weight: .medium))
                    }
                    .foregroundStyle(PulsePalette.accent)
                }
                Spacer()
            }
            .frame(maxWidth: 480)
            .padding(24)
        }
        .onAppear { code = "" }
        .task {
            if appLock.faceIDEnabled { _ = await appLock.authenticateAndUnlock() }
        }
    }
}

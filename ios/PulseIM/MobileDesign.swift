import SwiftUI
import UIKit

enum PulseApp {
    static var name: String {
        guard let value = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return "小猿口算" }
        return value
    }
}

enum PulsePalette {
    static let background = Color(uiColor: .secondarySystemBackground)
    static let surface = Color(uiColor: .systemBackground)
    static let ink = Color(uiColor: .label)
    static let muted = Color(uiColor: .secondaryLabel)
    static let accent = Color(hex: 0x2F80ED)
    static let accentSoft = Color(hex: 0xE8F1FF)
    static let line = Color(uiColor: .separator)
    static let danger = Color(hex: 0xE45151)
    static let warning = Color(hex: 0xF59E0B)
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

extension View {
    /// Keep iOS 17's change-handler capture behavior while supporting iOS 16.
    @ViewBuilder func pulseOnChange<Value: Equatable>(of value: Value, perform action: @escaping (Value) -> Void) -> some View {
        if #available(iOS 17.0, *) {
            onChange(of: value) { _, newValue in action(newValue) }
        } else {
            onChange(of: value, perform: action)
        }
    }
}

struct PulseAvatar: View {
    let title: String
    var tint: Color = PulsePalette.accent
    var size: CGFloat = 52
    var avatarURL: String? = nil

    var body: some View {
        Group {
            if let avatarURL, let url = APIClient.shared.mediaURL(avatarURL) {
                ZStack { initials; StableAvatarImage(url: url) }
            } else { initials }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
    }

    private var initials: some View {
        Text(String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.system(size: size * 0.34, weight: .bold)).foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(tint.gradient)
    }
}

struct PulseTopBar: View {
    let eyebrow: String
    let title: String
    var trailing: (() -> AnyView)? = nil
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(eyebrow.uppercased()).font(.system(size: 11, weight: .bold)).tracking(1.2).foregroundStyle(PulsePalette.accent)
                Text(title).font(.system(size: 28, weight: .bold, design: .rounded)).foregroundStyle(PulsePalette.ink)
            }
            Spacer()
            if let trailing { trailing() }
        }
        .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12).background(PulsePalette.surface)
    }
}

struct PulseCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        content().padding(14).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous)).overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PulsePalette.line, lineWidth: 1))
    }
}

struct PulseTabBar: View {
    @Binding var selection: Int
    var pendingFriendRequestCount = 0
    let items: [(String, String)] = [("聊天", "bubble.left.and.bubble.right.fill"), ("联系人", "person.2.fill"), ("探索", "bag.fill"), ("任务", "checklist"), ("我的", "person.crop.circle.fill")]
    var body: some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { index in
                Button { selection = index } label: {
                    VStack(spacing: 4) {
                        Image(systemName: items[index].1).font(.system(size: 17, weight: .semibold))
                            .overlay(alignment: .topTrailing) {
                                if index == 1 { PulseCountBadge(count: pendingFriendRequestCount).offset(x: 10, y: -7) }
                            }
                        Text(items[index].0).font(.system(size: 10, weight: .medium))
                    }
                        .foregroundStyle(selection == index ? PulsePalette.accent : PulsePalette.muted).frame(maxWidth: .infinity).padding(.vertical, 7)
                }.buttonStyle(.plain)
                .accessibilityLabel(items[index].0)
                .accessibilityValue(index == 1 && pendingFriendRequestCount > 0 ? "\(pendingFriendRequestCount)条待处理好友申请" : "")
            }
        }.padding(.horizontal, 4).padding(.top, 4).padding(.bottom, 3).background(PulsePalette.surface.shadow(.drop(color: .black.opacity(0.1), radius: 10, y: -3)))
    }
}

struct PulseCountBadge: View {
    let count: Int
    var body: some View {
        if let text = IOSFriendRequestInbox.badgeText(for: count) {
            Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                .background(Color(red: 1, green: 0.23, blue: 0.19)).clipShape(Capsule())
                .overlay(Capsule().stroke(PulsePalette.surface, lineWidth: 1))
                .fixedSize().allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

struct PulseField: ViewModifier {
    let title: String
    let icon: String
    @Binding var text: String
    func body(content: Content) -> some View { HStack(spacing: 10) { Image(systemName: icon).foregroundStyle(PulsePalette.muted).frame(width: 20); content }.padding(.horizontal, 12).frame(height: 48).background(PulsePalette.background).clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous)) }
}

extension View { func pulseField(title: String, text: Binding<String>, icon: String) -> some View { modifier(PulseField(title: title, icon: icon, text: text)) } }

struct PulseSecureField: View {
    let title: String
    @Binding var text: String
    let icon: String
    var body: some View { SecureField(title, text: $text).pulseField(title: title, text: $text, icon: icon) }
}

struct PulsePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label.font(.headline).foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 48).background(PulsePalette.accent.opacity(configuration.isPressed ? 0.75 : 1)).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)) }
}

struct PulseOutlineButtonStyle: ButtonStyle {
    let tint: Color
    func makeBody(configuration: Configuration) -> some View { configuration.label.font(.headline).foregroundStyle(tint).frame(maxWidth: .infinity).frame(height: 48).background(PulsePalette.surface).overlay(RoundedRectangle(cornerRadius: 14).stroke(tint.opacity(0.35), lineWidth: 1)).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)).opacity(configuration.isPressed ? 0.7 : 1) }
}

struct EmptyState: View {
    let icon: String
    let title: String
    let message: String
    var body: some View { VStack(spacing: 10) { Image(systemName: icon).font(.system(size: 36)).foregroundStyle(PulsePalette.accent); Text(title).font(.headline).foregroundStyle(PulsePalette.ink); Text(message).font(.subheadline).foregroundStyle(PulsePalette.muted) }.frame(maxWidth: .infinity) }
}

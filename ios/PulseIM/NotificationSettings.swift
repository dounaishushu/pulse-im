import SwiftUI
import AVFoundation

enum PulseNotificationCategory: String, CaseIterable, Identifiable {
    case privateChat = "private"
    case group = "group"
    case channel = "channel"

    var id: String { rawValue }

    var sectionTitle: String {
        switch self {
        case .privateChat: return "消息通知"
        case .group: return "群组消息通知"
        case .channel: return "频道通知"
        }
    }

    var description: String {
        switch self {
        case .privateChat: return "为特定用户设置自定义通知。"
        case .group: return "为特定群组设置自定义通知。"
        case .channel: return "为特定频道设置自定义通知。"
        }
    }

    var enabledKey: String { "pulse_notify_\(rawValue)_enabled" }
    var previewKey: String { "pulse_notify_\(rawValue)_preview" }
    var soundKey: String { "pulse_notify_\(rawValue)_sound" }
    var exceptionKey: String { "pulse_notify_\(rawValue)_exceptions" }
}

struct PulseNotificationSound: Identifiable, Hashable {
    let id: String
    let title: String

    static let sections: [(String, [PulseNotificationSound])] = [
        ("提醒铃声", [
            .init(id: "none", title: "无"),
            .init(id: "Note", title: "Note"),
            .init(id: "Aurora", title: "Aurora"),
            .init(id: "Bamboo", title: "Bamboo"),
            .init(id: "Chord", title: "Chord"),
            .init(id: "Circles", title: "Circles"),
            .init(id: "Complete", title: "Complete"),
            .init(id: "Hello", title: "Hello"),
            .init(id: "Input", title: "Input"),
            .init(id: "Keys", title: "Keys"),
            .init(id: "Popcorn", title: "Popcorn"),
            .init(id: "Pulse", title: "Pulse"),
            .init(id: "Synth", title: "Synth")
        ]),
        ("经典", [
            .init(id: "Tri-tone", title: "Tri-tone"),
            .init(id: "Tremolo", title: "Tremolo")
        ]),
        ("提示", [
            .init(id: "Bell", title: "Bell"),
            .init(id: "Calypso", title: "Calypso"),
            .init(id: "Chime", title: "Chime"),
            .init(id: "Glass", title: "Glass"),
            .init(id: "Telegraph", title: "Telegraph")
        ])
    ]

    static var all: [PulseNotificationSound] { sections.flatMap { $0.1 } }
}

enum PulseNotificationStore {
    private static let defaults = UserDefaults.standard

    static func bool(forKey key: String, defaultValue: Bool) -> Bool {
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        return defaults.bool(forKey: key)
    }

    static func sound(for category: PulseNotificationCategory) -> String {
        defaults.string(forKey: category.soundKey) ?? (category == .privateChat ? "none" : "Note")
    }

    static func setSound(_ value: String, for category: PulseNotificationCategory) {
        defaults.set(value, forKey: category.soundKey)
    }

    static func exceptionIDs(for category: PulseNotificationCategory) -> Set<Int> {
        if let values = defaults.array(forKey: category.exceptionKey) as? [Int] {
            return Set(values)
        }
        if let values = defaults.array(forKey: category.exceptionKey) as? [NSNumber] {
            return Set(values.map { $0.intValue })
        }
        return []
    }

    static func setExceptionIDs(_ ids: Set<Int>, for category: PulseNotificationCategory) {
        defaults.set(Array(ids).sorted(), forKey: category.exceptionKey)
    }

    static func soundTitle(_ value: String) -> String {
        PulseNotificationSound.all.first(where: { $0.id == value })?.title ?? "无"
    }

    static func resetExceptions() {
        PulseNotificationCategory.allCases.forEach { defaults.removeObject(forKey: $0.exceptionKey) }
    }

    static func category(from userInfo: [AnyHashable: Any]) -> PulseNotificationCategory {
        let raw = ["conversation_type", "chat_type", "conversationType", "type"]
            .compactMap { key in stringValue(userInfo[key]) }
            .first(where: { !$0.isEmpty })?.lowercased() ?? "private"

        if raw.contains("channel") { return .channel }
        if raw.contains("group") { return .group }
        return .privateChat
    }

    static func conversationID(from userInfo: [AnyHashable: Any]) -> Int? {
        for key in ["conversation_id", "conversationId", "chat_id", "chatId"] {
            if let number = numberValue(userInfo[key]) { return number }
        }
        return nil
    }

    static func isException(_ userInfo: [AnyHashable: Any], category: PulseNotificationCategory) -> Bool {
        guard let id = conversationID(from: userInfo) else { return false }
        return exceptionIDs(for: category).contains(id)
    }

    static func shouldPresent(_ userInfo: [AnyHashable: Any]) -> Bool {
        if isNewContactNotification(userInfo) {
            return bool(forKey: "pulse_new_contacts", defaultValue: false)
        }
        let category = category(from: userInfo)
        let enabled = bool(forKey: category.enabledKey, defaultValue: true)
        if enabled || isException(userInfo, category: category) { return true }
        return false
    }

    static func shouldPlaySound(_ userInfo: [AnyHashable: Any]) -> Bool {
        let category = category(from: userInfo)
        guard bool(forKey: "pulse_in_app_sound", defaultValue: true) else { return false }
        return sound(for: category) != "none"
    }

    static func soundName(_ userInfo: [AnyHashable: Any]) -> String {
        sound(for: category(from: userInfo))
    }

    static func shouldHidePreview(_ userInfo: [AnyHashable: Any]) -> Bool {
        let category = category(from: userInfo)
        return !bool(forKey: category.previewKey, defaultValue: true)
            || !bool(forKey: "pulse_in_app_preview", defaultValue: true)
    }

    static func shouldHideName() -> Bool {
        !bool(forKey: "pulse_lock_screen_name", defaultValue: true)
    }

    private static func isNewContactNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        let value = ["event", "event_type", "notification_type", "kind"]
            .compactMap { key in stringValue(userInfo[key])?.lowercased() }
            .joined(separator: " ")
        return value.contains("contact") && (value.contains("join") || value.contains("new"))
    }

    private static func stringValue(_ value: Any?) -> String? {
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        return nil
    }

    private static func numberValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String { return Int(value) }
        return nil
    }
}

final class PulseNotificationTonePlayer {
    static let shared = PulseNotificationTonePlayer()
    private var player: AVAudioPlayer?

    func play(named name: String) {
        guard name != "none" else {
            player?.stop()
            return
        }

        let frequencies: [Double]
        switch name {
        case "Note": frequencies = [880]
        case "Aurora": frequencies = [523, 659, 784]
        case "Bamboo": frequencies = [659, 784, 988]
        case "Chord": frequencies = [392, 494, 587]
        case "Circles": frequencies = [784, 659, 784, 988]
        case "Complete": frequencies = [523, 659, 784, 1047]
        case "Hello": frequencies = [659, 523, 659]
        case "Input": frequencies = [988, 784]
        case "Keys": frequencies = [440, 554, 659]
        case "Popcorn": frequencies = [784, 880, 784, 659]
        case "Pulse": frequencies = [440, 440, 659, 440]
        case "Synth": frequencies = [220, 330, 440, 660]
        case "Tri-tone": frequencies = [523, 659, 784]
        case "Tremolo": frequencies = [440, 440, 440, 440]
        case "Bell": frequencies = [784, 988]
        case "Calypso": frequencies = [523, 659, 784, 659]
        case "Chime": frequencies = [1047, 1319]
        case "Glass": frequencies = [1319, 1568, 1976]
        case "Telegraph": frequencies = [880, 880, 440]
        default: frequencies = [880]
        }

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try audioSession.setActive(true)
            player = try AVAudioPlayer(data: makeWaveData(frequencies: frequencies))
            player?.prepareToPlay()
            player?.play()
        } catch {
            player = nil
        }
    }

    private func makeWaveData(frequencies: [Double]) -> Data {
        let sampleRate = 44_100.0
        let noteDuration = 0.13
        let gapDuration = 0.025
        let samplesPerNote = Int(sampleRate * noteDuration)
        let samplesPerGap = Int(sampleRate * gapDuration)
        var pcm = Data(capacity: frequencies.count * samplesPerNote * 2)

        for (index, frequency) in frequencies.enumerated() {
            for frame in 0..<samplesPerNote {
                let progress = Double(frame) / Double(samplesPerNote)
                let attack = min(1, progress / 0.08)
                let release = min(1, (1 - progress) / 0.18)
                let envelope = max(0, min(attack, release))
                let value = sin(2 * Double.pi * frequency * Double(frame) / sampleRate) * 0.22 * envelope
                var sample = Int16(value * Double(Int16.max))
                withUnsafeBytes(of: &sample) { pcm.append(contentsOf: $0) }
            }
            if index < frequencies.count - 1 {
                pcm.append(contentsOf: Array(repeating: UInt8(0), count: samplesPerGap * 2))
            }
        }

        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        appendUInt32(UInt32(36 + pcm.count), to: &data)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        appendUInt32(16, to: &data)
        appendUInt16(1, to: &data)
        appendUInt16(1, to: &data)
        appendUInt32(UInt32(sampleRate), to: &data)
        appendUInt32(UInt32(sampleRate * 2), to: &data)
        appendUInt16(2, to: &data)
        appendUInt16(16, to: &data)
        data.append(contentsOf: Array("data".utf8))
        appendUInt32(UInt32(pcm.count), to: &data)
        data.append(contentsOf: pcm)
        return data
    }

    private func appendUInt16(_ value: UInt16, to data: inout Data) {
        var value = value.littleEndian
        withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
    }

    private func appendUInt32(_ value: UInt32, to data: inout Data) {
        var value = value.littleEndian
        withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
    }
}

struct IOSNotificationSoundView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var soundPickerCategory: PulseNotificationCategory?
    @State private var exceptionCategory: PulseNotificationCategory?
    @State private var showingResetConfirmation = false

    @AppStorage("pulse_notify_private_enabled") private var privateEnabled = true
    @AppStorage("pulse_notify_private_preview") private var privatePreview = true
    @AppStorage("pulse_notify_private_sound") private var privateSound = "none"
    @AppStorage("pulse_notify_group_enabled") private var groupEnabled = true
    @AppStorage("pulse_notify_group_preview") private var groupPreview = true
    @AppStorage("pulse_notify_group_sound") private var groupSound = "Note"
    @AppStorage("pulse_notify_channel_enabled") private var channelEnabled = true
    @AppStorage("pulse_notify_channel_preview") private var channelPreview = false
    @AppStorage("pulse_notify_channel_sound") private var channelSound = "Note"
    @AppStorage("pulse_in_app_sound") private var inAppSound = true
    @AppStorage("pulse_in_app_vibration") private var inAppVibration = false
    @AppStorage("pulse_in_app_preview") private var inAppPreview = true
    @AppStorage("pulse_lock_screen_name") private var lockScreenName = true
    @AppStorage("pulse_badge_muted") private var badgeMuted = true
    @AppStorage("pulse_badge_public_groups") private var badgePublicGroups = true
    @AppStorage("pulse_badge_channels") private var badgeChannels = true
    @AppStorage("pulse_badge_by_message") private var badgeByMessage = true
    @AppStorage("pulse_new_contacts") private var newContacts = false

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    notificationSection(title: "消息通知") {
                        notificationToggle("显示通知", isOn: $privateEnabled)
                        notificationToggle("消息预览", isOn: $privatePreview)
                        notificationLink(title: "声音", detail: PulseNotificationStore.soundTitle(privateSound)) { soundPickerCategory = .privateChat }
                        notificationLink(title: "例外", detail: "添加") { exceptionCategory = .privateChat }
                        notificationDescription("为特定用户设置自定义通知。")
                    }

                    notificationSection(title: "群组消息通知") {
                        notificationToggle("显示通知", isOn: $groupEnabled)
                        notificationToggle("消息预览", isOn: $groupPreview)
                        notificationLink(title: "声音", detail: PulseNotificationStore.soundTitle(groupSound)) { soundPickerCategory = .group }
                        notificationLink(title: "例外", detail: "添加") { exceptionCategory = .group }
                        notificationDescription("为特定群组设置自定义通知。")
                    }

                    notificationSection(title: "频道通知") {
                        notificationToggle("显示通知", isOn: $channelEnabled)
                        notificationToggle("消息预览", isOn: $channelPreview)
                        notificationLink(title: "声音", detail: PulseNotificationStore.soundTitle(channelSound)) { soundPickerCategory = .channel }
                        notificationLink(title: "例外", detail: "添加") { exceptionCategory = .channel }
                        notificationDescription("为特定频道设置自定义通知。")
                    }

                    notificationSection(title: "应用内通知") {
                        notificationToggle("应用内播放提醒音", isOn: $inAppSound)
                        notificationToggle("应用内振动提醒", isOn: $inAppVibration)
                        notificationToggle("应用内消息预览", isOn: $inAppPreview)
                    }

                    notificationSection(title: "锁屏显示") {
                        notificationToggle("在锁屏界面上显示名称", isOn: $lockScreenName)
                        notificationDescription("设备锁定后在通知栏上显示姓名。若需禁用，请确保“显示预览”功能也设置为“解锁时”或“从不”。")
                    }

                    notificationSection(title: "未读消息数量提示") {
                        notificationToggle("包含已关闭通知的聊天", isOn: $badgeMuted)
                        notificationToggle("包含公开群组", isOn: $badgePublicGroups)
                        notificationToggle("包含频道", isOn: $badgeChannels)
                        notificationToggle("按消息数统计未读", isOn: $badgeByMessage)
                        notificationDescription("关闭以后显示未读聊天数而非未读消息数。")
                    }

                    notificationSection(title: "新联系人加入") {
                        notificationToggle("新联系人加入", isOn: $newContacts)
                        notificationDescription("当你的联系人加入\(PulseApp.name)时接收推送通知。")
                    }

                    Button("重设所有通知选项", role: .destructive) {
                        showingResetConfirmation = true
                    }
                    .font(.system(size: 18))
                    .frame(maxWidth: .infinity, minHeight: 58)
                    .background(PulsePalette.surface)
                    .padding(.top, 12)

                    notificationDescription("撤消对所有联系人、群组和频道的自定义通知设置。")
                }
            }
            .background(PulsePalette.background)
            .scrollIndicators(.hidden)
            .navigationTitle("通知声音")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 22, weight: .medium))
                    }
                    .accessibilityLabel("返回")
                }
            }
            .pulseSheet(item: $soundPickerCategory) { category in
                IOSNotificationSoundPickerView(category: category) { value in
                    switch category {
                    case .privateChat: privateSound = value
                    case .group: groupSound = value
                    case .channel: channelSound = value
                    }
                }
            }
            .pulseSheet(item: $exceptionCategory) { category in
                IOSNotificationExceptionsView(category: category)
            }
            .alert("重设所有通知选项", isPresented: $showingResetConfirmation) {
                Button("取消", role: .cancel) {}
                Button("重设", role: .destructive) { resetAll() }
            } message: {
                Text("这将恢复所有通知开关、铃声和例外设置。")
            }
        }
    }

    @ViewBuilder
    private func notificationSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(title)
                    .font(.system(size: 17))
                    .foregroundStyle(PulsePalette.muted)
                Spacer()
            }
            .padding(.horizontal, 36)
            .frame(minHeight: 54)
            .background(PulsePalette.background)

            content()
        }
    }

    private func notificationToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(title, isOn: isOn)
            .font(.system(size: 20))
            .tint(Color(hex: 0x2BCB68))
            .padding(.horizontal, 36)
            .frame(minHeight: 70)
            .background(PulsePalette.surface)
    }

    private func notificationLink(title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 20))
                    .foregroundStyle(PulsePalette.ink)
                Spacer()
                Text(detail)
                    .font(.system(size: 18))
                    .foregroundStyle(PulsePalette.muted)
                Image(systemName: "chevron.right")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(PulsePalette.line)
            }
            .padding(.horizontal, 36)
            .frame(minHeight: 70)
            .background(PulsePalette.surface)
        }
        .buttonStyle(.plain)
    }

    private func notificationDescription(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 17))
            .foregroundStyle(PulsePalette.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 36)
            .padding(.vertical, 13)
            .background(PulsePalette.background)
    }

    private func resetAll() {
        privateEnabled = true
        privatePreview = true
        privateSound = "none"
        groupEnabled = true
        groupPreview = true
        groupSound = "Note"
        channelEnabled = true
        channelPreview = false
        channelSound = "Note"
        inAppSound = true
        inAppVibration = false
        inAppPreview = true
        lockScreenName = true
        badgeMuted = true
        badgePublicGroups = true
        badgeChannels = true
        badgeByMessage = true
        newContacts = false
        PulseNotificationStore.resetExceptions()
    }
}

struct IOSNotificationSoundPickerView: View {
    let category: PulseNotificationCategory
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected: String

    init(category: PulseNotificationCategory, onSave: @escaping (String) -> Void) {
        self.category = category
        self.onSave = onSave
        _selected = State(initialValue: PulseNotificationStore.sound(for: category))
    }

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(PulseNotificationSound.sections.enumerated()), id: \.offset) { _, section in
                        VStack(spacing: 0) {
                            HStack {
                                Text(section.0)
                                    .font(.system(size: 17))
                                    .foregroundStyle(PulsePalette.muted)
                                Spacer()
                            }
                            .padding(.horizontal, 36)
                            .frame(minHeight: 54)
                            .background(PulsePalette.background)

                            ForEach(section.1) { sound in
                                Button {
                                    selected = sound.id
                                    PulseNotificationTonePlayer.shared.play(named: sound.id)
                                } label: {
                                    HStack {
                                        Text(sound.title)
                                            .font(.system(size: 20))
                                            .foregroundStyle(PulsePalette.ink)
                                        Spacer()
                                        if selected == sound.id {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 23, weight: .semibold))
                                                .foregroundStyle(PulsePalette.accent)
                                        }
                                    }
                                    .padding(.horizontal, 28)
                                    .frame(minHeight: 64)
                                    .background(PulsePalette.surface)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .background(PulsePalette.background)
            .scrollIndicators(.hidden)
            .navigationTitle("提醒声音")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        PulseNotificationTonePlayer.shared.play(named: "none")
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        onSave(selected)
                        dismiss()
                    }
                }
            }
        }
    }
}

private struct PulseNotificationExceptionItem: Identifiable, Hashable {
    let id: Int
    let name: String
    let detail: String
    let avatarURL: String?
}

struct IOSNotificationExceptionsView: View {
    let category: PulseNotificationCategory
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var selectedIDs: Set<Int>
    @State private var showingPicker = false

    init(category: PulseNotificationCategory) {
        self.category = category
        _selectedIDs = State(initialValue: PulseNotificationStore.exceptionIDs(for: category))
    }

    private var candidates: [PulseNotificationExceptionItem] {
        switch category {
        case .privateChat:
            return session.contacts.map { contact in
                PulseNotificationExceptionItem(id: contact.id, name: contact.nickname, detail: contact.username.map { "@\($0)" } ?? "联系人", avatarURL: contact.avatarURL)
            }
        case .group, .channel:
            return session.conversations
                .filter { category == .group ? $0.type == "group" : $0.type == "channel" }
                .map { conversation in
                    PulseNotificationExceptionItem(id: conversation.id, name: conversation.name ?? (category == .group ? "群组" : "频道"), detail: category == .group ? "群组" : "频道", avatarURL: conversation.avatarURL)
                }
        }
    }

    private var visibleCandidates: [PulseNotificationExceptionItem] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return candidates }
        return candidates.filter { $0.name.localizedCaseInsensitiveContains(value) || $0.detail.localizedCaseInsensitiveContains(value) }
    }

    private var selectedItems: [PulseNotificationExceptionItem] {
        candidates.filter { selectedIDs.contains($0.id) }
    }

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 25))
                            .foregroundStyle(PulsePalette.muted)
                        TextField("搜索", text: $query)
                            .font(.system(size: 19))
                    }
                    .padding(.horizontal, 18)
                    .frame(height: 62)
                    .background(PulsePalette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .padding(.horizontal, 36)
                    .padding(.vertical, 14)

                    Button {
                        showingPicker = true
                    } label: {
                        HStack(spacing: 23) {
                            Image(systemName: category == .privateChat ? "person.badge.plus" : "plus.circle")
                                .font(.system(size: 28, weight: .medium))
                                .foregroundStyle(PulsePalette.accent)
                                .frame(width: 42)
                            Text("添加一个例外")
                                .font(.system(size: 20))
                                .foregroundStyle(PulsePalette.ink)
                            Spacer()
                        }
                        .padding(.horizontal, 36)
                        .frame(minHeight: 82)
                        .background(PulsePalette.surface)
                    }
                    .buttonStyle(.plain)

                    if !selectedItems.isEmpty {
                        VStack(spacing: 0) {
                            HStack {
                                Text("已添加")
                                    .font(.system(size: 17))
                                    .foregroundStyle(PulsePalette.muted)
                                Spacer()
                            }
                            .padding(.horizontal, 36)
                            .frame(minHeight: 52)
                            .background(PulsePalette.background)

                            ForEach(selectedItems) { item in
                                exceptionRow(item, removable: true)
                            }
                        }
                    } else if !visibleCandidates.isEmpty {
                        Text("点击“添加一个例外”选择联系人或会话。")
                            .font(.system(size: 17))
                            .foregroundStyle(PulsePalette.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 36)
                            .padding(.top, 17)
                    }

                    Spacer(minLength: 300)
                }
            }
            .background(PulsePalette.background)
            .scrollIndicators(.hidden)
            .navigationTitle("例外")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 22, weight: .medium))
                    }
                    .accessibilityLabel("返回")
                }
            }
            .pulseSheet(isPresented: $showingPicker) {
                IOSNotificationExceptionPickerView(category: category, candidates: candidates, selectedIDs: $selectedIDs)
            }
            .pulseOnChange(of: selectedIDs) { value in
                PulseNotificationStore.setExceptionIDs(value, for: category)
            }
        }
    }

    private func exceptionRow(_ item: PulseNotificationExceptionItem, removable: Bool) -> some View {
        HStack(spacing: 15) {
            PulseAvatar(title: item.name, size: 48, avatarURL: item.avatarURL)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name)
                    .font(.system(size: 19))
                    .foregroundStyle(PulsePalette.ink)
                Text(item.detail)
                    .font(.system(size: 15))
                    .foregroundStyle(PulsePalette.muted)
            }
            Spacer()
            if removable {
                Button {
                    selectedIDs.remove(item.id)
                } label: {
                    Image(systemName: "minus.circle")
                        .font(.system(size: 23))
                        .foregroundStyle(PulsePalette.danger)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 36)
        .frame(minHeight: 70)
        .background(PulsePalette.surface)
    }
}

private struct IOSNotificationExceptionPickerView: View {
    let category: PulseNotificationCategory
    let candidates: [PulseNotificationExceptionItem]
    @Binding var selectedIDs: Set<Int>
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var visibleCandidates: [PulseNotificationExceptionItem] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return candidates }
        return candidates.filter { $0.name.localizedCaseInsensitiveContains(value) || $0.detail.localizedCaseInsensitiveContains(value) }
    }

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 25))
                            .foregroundStyle(PulsePalette.muted)
                        TextField("搜索", text: $query)
                            .font(.system(size: 19))
                    }
                    .padding(.horizontal, 18)
                    .frame(height: 62)
                    .background(PulsePalette.background)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .padding(.horizontal, 36)
                    .padding(.vertical, 14)

                    ForEach(visibleCandidates) { item in
                        Button {
                            if selectedIDs.contains(item.id) {
                                selectedIDs.remove(item.id)
                            } else {
                                selectedIDs.insert(item.id)
                            }
                        } label: {
                            HStack(spacing: 15) {
                                PulseAvatar(title: item.name, size: 48, avatarURL: item.avatarURL)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.name)
                                        .font(.system(size: 19))
                                        .foregroundStyle(PulsePalette.ink)
                                    Text(item.detail)
                                        .font(.system(size: 15))
                                        .foregroundStyle(PulsePalette.muted)
                                }
                                Spacer()
                                if selectedIDs.contains(item.id) {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 23, weight: .semibold))
                                        .foregroundStyle(PulsePalette.accent)
                                }
                            }
                            .padding(.horizontal, 36)
                            .frame(minHeight: 70)
                            .background(PulsePalette.surface)
                        }
                        .buttonStyle(.plain)
                    }

                    if visibleCandidates.isEmpty {
                        Text("暂无可添加的联系人或会话")
                            .font(.system(size: 17))
                            .foregroundStyle(PulsePalette.muted)
                            .padding(.top, 30)
                    }
                }
            }
            .background(PulsePalette.background)
            .scrollIndicators(.hidden)
            .navigationTitle("添加例外")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

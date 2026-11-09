import SwiftUI

private struct IOSForwardSheetPresentation: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 16.4, *) {
            content.presentationBackground(.clear).presentationCornerRadius(0)
        } else {
            // Older iOS 16 uses its system sheet surface; forwarding stays available.
            content
        }
    }
}

@MainActor struct IOSMessageForwardSheet: View {
    let current: () -> Bool
    let sourceAvailable: (Int) -> Bool
    let onSent: (Message) -> Void
    let onComplete: (Int) -> Void
    private let client: APIClient
    @Environment(\.dismiss) private var dismiss
    @State private var batch: IOSMessageForwardBatch
    @State private var targets: [Conversation] = []
    @State private var resolvedTarget: Conversation?
    @State private var lockedKey: Int?
    @State private var query = ""
    @State private var page = 0
    @State private var hasMore = true
    @State private var loading = false
    @State private var loadFailed = false
    @State private var sending = false
    @State private var failed = false
    @State private var visible = true
    @State private var feedback = ""
    @State private var sendTask: Task<Void, Never>?
    private let blue = Color(hex: 0x0099DB)
    private let muted = Color(hex: 0x929BA4)

    init(batch: IOSMessageForwardBatch, current: @escaping () -> Bool, sourceAvailable: @escaping (Int) -> Bool,
         onSent: @escaping (Message) -> Void, onComplete: @escaping (Int) -> Void) {
        self.current = current; self.sourceAvailable = sourceAvailable; self.onSent = onSent; self.onComplete = onComplete
        self.client = APIClient.shared.captureSession(); _batch = State(initialValue: batch)
    }
    private var valid: Bool {
        visible && current() && client.endpointIdentity == APIClient.shared.endpointIdentity
            && client.webSocketToken == APIClient.shared.webSocketToken
    }
    private var keyword: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var filtered: [Conversation] {
        targets.filter { $0.type != "favorites" && (keyword.isEmpty || ($0.name ?? "").localizedCaseInsensitiveContains(keyword)) }
    }
    private var showFavorite: Bool { keyword.isEmpty || "收藏夹".localizedCaseInsensitiveContains(keyword) }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.18).ignoresSafeArea().onTapGesture { cancel() }
                VStack(spacing: 0) {
                    Text("选择接收者...").font(.system(size: 16, weight: .semibold)).foregroundStyle(.black)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).frame(height: 44)
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass").font(.system(size: 16)).foregroundStyle(Color(hex: 0x999999)).frame(width: 18)
                        TextField("搜索", text: $query).font(.system(size: 14)).foregroundStyle(.black)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("搜索接收者")
                            .disabled(sending || lockedKey != nil)
                    }.padding(.horizontal, 18).frame(height: 48).background(.white)
                    line
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if showFavorite { recipientRow(nil) }
                            ForEach(filtered) { target in
                                recipientRow(target)
                                    .onAppear { if target.id == filtered.last?.id && hasMore && !loadFailed { Task { await loadTargets() } } }
                            }
                            if filtered.isEmpty && !showFavorite && !loading {
                                Text("没有找到接收者").font(.system(size: 14)).foregroundStyle(muted).padding(24)
                            }
                            if hasMore && lockedKey == nil {
                                Button { Task { await loadTargets() } } label: {
                                    Text(loading ? "正在加载…" : loadFailed ? "重试加载会话" : "加载更多会话")
                                        .font(.system(size: 13)).foregroundStyle(blue).frame(maxWidth: .infinity).frame(height: 40)
                                }.buttonStyle(.plain).disabled(loading || sending)
                            }
                        }.padding(.top, 8).padding(.bottom, 4)
                    }.scrollIndicators(.visible)
                    line
                    HStack(spacing: 8) {
                        if !feedback.isEmpty {
                            Text(feedback).font(.system(size: 12)).foregroundStyle(muted).lineLimit(3).accessibilityAddTraits(.updatesFrequently)
                        }
                        Spacer(minLength: 0)
                        if failed {
                            Button { startForwarding(resolvedTarget, favorite: lockedKey == -1) } label: {
                                Text(batch.completed > 0 ? "继续转发 \(batch.items.count - batch.completed) 条" : "重试")
                                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(blue).padding(.vertical, 10)
                            }.buttonStyle(.plain).disabled(sending)
                        }
                        Button("取消") { cancel() }.font(.system(size: 14, weight: .semibold)).foregroundStyle(blue)
                            .buttonStyle(.plain).frame(width: 52, height: 40)
                    }.padding(.horizontal, 16).frame(minHeight: 54)
                }
                .frame(width: min(364, max(240, geometry.size.width - 24)), height: min(1000, geometry.size.height - 8))
                .background(.white).clipShape(RoundedRectangle(cornerRadius: 8))
                .shadow(color: .black.opacity(0.2), radius: 8, y: 3)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .presentationDetents([.large]).presentationDragIndicator(.hidden)
        .modifier(IOSForwardSheetPresentation())
        .task { await loadTargets() }
        .pulseOnChange(of: query) { _ in if !keyword.isEmpty { Task { await loadTargets() } } }
        .onDisappear { visible = false; sendTask?.cancel(); sendTask = nil }
    }
    private var line: some View { Color(hex: 0xE5E5E5).frame(height: 1) }
    private func cancel() { visible = false; sendTask?.cancel(); sendTask = nil; dismiss() }
    private func recipientRow(_ target: Conversation?) -> some View {
        let favorite = target == nil
        let key = target?.id ?? -1
        let name = favorite ? "收藏夹" : target?.name ?? "会话"
        let colors: [Color] = [Color(hex: 0x4CA5EE), Color(hex: 0xEE7253), Color(hex: 0x43BCD3), Color(hex: 0xF16E9B), Color(hex: 0x82C657)]
        return Button { startForwarding(target, favorite: favorite) } label: {
            HStack(spacing: 16) {
                ZStack {
                    Circle().fill(colors[favorite ? 0 : abs(key % colors.count)].gradient)
                    if favorite {
                        Image(systemName: "bookmark").font(.system(size: 21)).foregroundStyle(.white)
                    } else {
                        Text(String(name.prefix(1))).font(.system(size: 20)).foregroundStyle(.white)
                        if let raw = target?.avatarURL, let url = client.mediaURL(raw) {
                            StableAvatarImage(url: url)
                        }
                    }
                }.frame(width: 42, height: 42).clipShape(Circle()).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(name).font(.system(size: 14, weight: .semibold)).foregroundStyle(.black).lineLimit(1)
                    Text(favorite ? "转发消息到这里以便快速访问" : subtitle(target!)).font(.system(size: 14)).foregroundStyle(muted).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.horizontal, 16).frame(height: 56).contentShape(Rectangle())
                .background(lockedKey == key ? Color(hex: 0xF1F1F1) : Color.white)
        }.buttonStyle(.plain).disabled(sending || lockedKey != nil).accessibilityLabel("转发到 \(name)")
    }
    private func subtitle(_ target: Conversation) -> String {
        switch target.type {
        case "group": return "群组"
        case "channel": return "频道"
        case "customer_service": return "客服"
        default: return target.peerOnline == true ? "在线" : target.peerLastSeenAt != nil ? "近期曾上线" : "最近上线时间不可见"
        }
    }
    private func loadTargets() async {
        guard valid, !loading, !sending, lockedKey == nil, hasMore else { return }
        loading = true; loadFailed = false
        defer { loading = false }
        do {
            repeat {
                let result = try await client.forwardingConversations(page: page + 1)
                guard valid, !Task.isCancelled else { return }
                var known = Set(targets.map(\.id))
                for target in result.items where IOSMessageForwarding.targetAllowed(target) && known.insert(target.id).inserted { targets.append(target) }
                page += 1
                let size = max(1, result.size ?? 50)
                hasMore = !result.items.isEmpty && (result.total.map { page * size < $0 } ?? (result.items.count >= size))
                if lockedKey == nil { feedback = "" }
            } while !keyword.isEmpty && hasMore && valid && !Task.isCancelled && !sending
        } catch { if valid, !Task.isCancelled { loadFailed = true; if lockedKey == nil { feedback = error.localizedDescription } } }
    }
    private func startForwarding(_ chosen: Conversation?, favorite: Bool) {
        guard valid, !sending else { return }
        let key = favorite ? -1 : chosen?.id ?? 0
        guard key != 0, lockedKey == nil || lockedKey == key else { return }
        if let chosen, !IOSMessageForwarding.targetAllowed(chosen) { return }
        lockedKey = key; sending = true; failed = false; feedback = "正在转发…"
        sendTask = Task { @MainActor in
            do {
                let target: Conversation
                if let chosen { target = chosen }
                else if let cached = resolvedTarget ?? targets.first(where: { $0.type == "favorites" }) { target = cached }
                else { target = try await client.favoriteConversation() }
                guard valid, !Task.isCancelled else { return }
                guard IOSMessageForwarding.targetAllowed(target) else { throw IOSMessageForwardError.unavailable }
                resolvedTarget = target
                while let item = batch.pending {
                    guard valid, !Task.isCancelled else { return }
                    guard sourceAvailable(item.sourceID) else { throw IOSMessageForwardError.unavailable }
                    feedback = "正在转发 \(batch.completed + 1)/\(batch.items.count)…"
                    let message = try await client.sendRawMessage(conversationID: target.id, type: item.type,
                                                                 body: item.body.mapValues { $0.anyValue }, requestID: item.requestID)
                    guard valid, !Task.isCancelled else { return }
                    guard batch.acknowledge(requestID: item.requestID) else { throw IOSMessageForwardError.unavailable }
                    onSent(message)
                }
                guard valid, !Task.isCancelled else { return }
                sending = false; sendTask = nil; onComplete(batch.items.count); dismiss()
            } catch {
                if valid, !Task.isCancelled { failed = true; feedback = "已转发 \(batch.completed)/\(batch.items.count) 条。\(error.localizedDescription)" }
            }
            sending = false; sendTask = nil
        }
    }
}

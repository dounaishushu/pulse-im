import SwiftUI
import UIKit

/// Caption and time belong to the chat card. The gallery keeps the original image.
@MainActor struct IOSChatMediaBubble: View {
    let source: IOSChatMediaDescriptor
    let client: APIClient
    let active: Bool
    let activation: UUID
    let captionBackground: Color
    let captionForeground: Color
    let open: () -> Void
    @ObservedObject private var cache = IOSChatImageCache.shared
    @State private var image: UIImage?
    @State private var imageKey = ""
    @State private var failure = false
    @State private var attempt = 0
    @State private var request = UUID()

    private var originalURL: URL? { client.mediaURL(source.kind == .video ? source.thumbnailURL ?? source.rawURL : source.rawURL) }
    private var url: URL? { originalURL.map { source.kind == .image ? IOSChatImageCachePolicy.previewURL($0) : $0 } }
    private var posterFromVideo: Bool { source.kind == .video && source.thumbnailURL == nil }
    private var contentKey: String {
        IOSChatImageCache.scope(client) + "|" + (url.map { IOSChatImageCache.key($0, client: client) } ?? "invalid")
            + "|" + String(posterFromVideo) + "|" + String(cache.generation)
    }
    private var cached: UIImage? {
        guard let url else { return nil }
        if posterFromVideo { return cache.cachedVideoPoster(url, client: client) }
        return originalURL.flatMap { cache.cachedPreview($0, client: client) }
    }
    var body: some View {
        let key = contentKey
        let displayed = cached ?? (imageKey == key ? image : nil)
        let size = source.fittedSize(width: displayed.map { Double($0.size.width) }, height: displayed.map { Double($0.size.height) })
        let cardWidth = source.caption == nil ? size.width : max(180, size.width)
        let identity = source.requestID(scope: IOSChatImageCache.scope(client), active: active, activation: activation, generation: cache.generation)
        VStack(spacing: 0) {
          Button {
            guard active else { return }
            open()
        } label: {
            ZStack {
                if let displayed { Image(uiImage: displayed).resizable().scaledToFit() }
                else if failure && source.kind == .image {
                    Label("点按查看图片并重试", systemImage: "photo")
                        .font(.system(size: 12)).foregroundStyle(PulsePalette.muted).padding(12)
                } else if source.kind == .image { ProgressView().tint(PulsePalette.muted) }
                if source.kind == .video {
                    Image(systemName: "play.fill").font(.system(size: 24)).foregroundStyle(.white)
                        .frame(width: 50, height: 50).background(.black.opacity(0.4), in: Circle())
                }
            }
            .frame(width: CGFloat(cardWidth), height: CGFloat(size.height))
            .overlay(alignment: .bottomTrailing) {
              if source.caption == nil {
                Text(source.timeText).font(.system(size: 11, weight: .medium)).monospacedDigit()
                    .foregroundStyle(.white).padding(.horizontal, 5).padding(.vertical, 2)
                    .background(.black.opacity(0.45), in: Capsule()).padding(5)
                    .accessibilityLabel("发送时间 \(source.timeText)")
              }
            }
            .clipShape(RoundedRectangle(cornerRadius: source.caption == nil ? 10 : 0, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }.buttonStyle(.plain)
        .accessibilityLabel(source.kind == .image ? "查看图片" : "播放视频")
          if let caption = source.caption {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: caption).font(.system(size: 15)).foregroundStyle(captionForeground)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat-image-caption")
                Text(source.timeText).font(.system(size: 11)).monospacedDigit()
                    .foregroundStyle(captionForeground.opacity(0.65)).frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityLabel("发送时间 \(source.timeText)")
            }.padding(.horizontal, 10).padding(.top, 7).padding(.bottom, 5)
          }
        }
        .frame(width: CGFloat(cardWidth))
        .background(source.caption == nil ? Color.clear : captionBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .task(id: identity + "|" + String(attempt)) {
            let currentRequest = UUID(); request = currentRequest
            guard active else { return }
            if imageKey != key { image = nil; imageKey = key }
            failure = false
            func current() -> Bool {
                request == currentRequest && active && !Task.isCancelled && key == contentKey
                    && IOSChatImageCache.scope(client) == IOSChatImageCache.scope(APIClient.shared)
            }
            do {
                let loaded = try await IOSChatMediaLoader.load(source: source, current: current, operation: { item in
                    if item.kind == .video {
                        if let thumb = item.thumbnailURL, let thumbURL = client.mediaURL(thumb) {
                            return try await cache.load(thumbURL, client: client, maximumPixel: 640)
                        }
                        guard let videoURL = client.mediaURL(item.rawURL) else { throw IOSChatMediaFailure.unavailable }
                        return try await cache.loadVideoPoster(videoURL, client: client)
                    }
                    guard let imageURL = client.mediaURL(item.rawURL) else { throw IOSChatMediaFailure.unavailable }
                    return try await cache.loadPreview(imageURL, client: client)
                }, refresh: {
                    let page = try await client.locateMessage(conversationID: source.conversationID, messageID: source.messageID)
                    return try source.refreshed(from: page)
                })
                guard current() else { return }; image = loaded; imageKey = key
            } catch {
                guard current(), !IOSChatMediaLoader.isCancelled(error) else { return }
                failure = true
            }
        }
        .onDisappear { request = UUID() }
    }
}

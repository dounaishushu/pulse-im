import SwiftUI
import PhotosUI
import UIKit

/// The album result stays local until Send is pressed; dismissing returns to the conversation.
struct IOSPhotoSendPreview: View {
    let photos: [IOSPreparedPhoto]
    let onBack: () -> Void
    let onCancel: () -> Void
    let onSend: ([UUID]) -> Void
    @State private var selected: [UUID]
    @State private var page = 0
    @State private var image: UIImage?
    @State private var loading = true
    @State private var failed = false
    @State private var submitted = false
    @State private var reload = UUID()

    init(photos: [IOSPreparedPhoto], onBack: @escaping () -> Void, onCancel: @escaping () -> Void, onSend: @escaping ([UUID]) -> Void) {
        self.photos = photos; self.onBack = onBack; self.onCancel = onCancel; self.onSend = onSend
        _selected = State(initialValue: photos.map(\.id))
    }
    private var current: IOSPreparedPhoto? {
        guard selected.indices.contains(page) else { return nil }
        return photos.first { $0.id == selected[page] }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("取消", action: onCancel).accessibilityIdentifier("photo_preview_cancel")
                Spacer()
                Text("图片预览 \(selected.isEmpty ? 0 : page + 1)/\(selected.count)").font(.system(size: 16, weight: .medium))
                Spacer()
                Button("发送(\(selected.count))") {
                    guard !submitted, !selected.isEmpty else { return }; submitted = true; onSend(selected)
                }.buttonStyle(.borderedProminent).tint(.blue).accessibilityIdentifier("photo_preview_send")
                    .disabled(submitted || loading || failed || selected.isEmpty)
            }.font(.system(size: 16)).foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 12)
            ZStack {
                if let image { IOSZoomablePhoto(image: image).id(current?.id).accessibilityIdentifier("photo_preview_image") }
                else { Color.black }
                if loading { ProgressView().tint(.white) }
                if failed { Button("图片读取失败，点此重试") { reload = UUID() }.foregroundStyle(.white) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(selected.enumerated()), id: \.element) { offset, id in
                        if let photo = photos.first(where: { $0.id == id }) {
                            Button { selectPage(offset) } label: {
                                IOSPhotoDraftThumbnail(photo: photo)
                                    .overlay(alignment: .topTrailing) { Text("\(offset + 1)").font(.caption.bold()).padding(3).background(.blue, in: Circle()) }
                                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(offset == page ? Color.blue : .clear, lineWidth: 3))
                            }.buttonStyle(.plain).accessibilityLabel("预览第 \(offset + 1) 张图片")
                        }
                    }
                }.padding(.horizontal, 16).padding(.vertical, 6)
            }
            HStack {
                Button("重选", action: onBack).accessibilityIdentifier("photo_preview_back")
                Spacer()
                Button { selectPage(max(0, page - 1)) } label: { Image(systemName: "chevron.left").frame(width: 32, height: 40) }.disabled(page == 0).accessibilityLabel("上一张")
                Button("移除当前") {
                    guard selected.indices.contains(page) else { return }; image = nil; loading = true; selected.remove(at: page)
                    if selected.isEmpty { onCancel() } else { page = min(page, selected.count - 1) }
                }.disabled(submitted || selected.isEmpty).accessibilityIdentifier("photo_preview_remove")
                Button { selectPage(min(selected.count - 1, page + 1)) } label: { Image(systemName: "chevron.right").frame(width: 32, height: 40) }.disabled(page >= selected.count - 1).accessibilityLabel("下一张")
            }.foregroundStyle(.white).padding(.horizontal, 16)
            Text("双指缩放或双击查看图片").font(.system(size: 12)).foregroundStyle(.gray).padding(12)
        }.background(Color.black).preferredColorScheme(.dark).disabled(submitted)
            .presentationDetents([.large]).presentationDragIndicator(.hidden)
            .task(id: "\(current?.id.uuidString ?? "")-\(reload)") {
                image = nil; failed = false; loading = true
                guard let photo = current else { loading = false; return }
                let loaded = await Task.detached(priority: .userInitiated) { IOSPhotoPreparation.preview(photo.fileURL) }.value
                guard !Task.isCancelled, current?.id == photo.id else { return }
                image = loaded; failed = loaded == nil; loading = false
            }
    }
    private func selectPage(_ index: Int) {
        guard selected.indices.contains(index), index != page else { return }
        image = nil; loading = true; failed = false; page = index
    }
}

private struct IOSPhotoDraftThumbnail: View {
    let photo: IOSPreparedPhoto
    @State private var image: UIImage?
    var body: some View {
        Group { if let image { Image(uiImage: image).resizable().scaledToFill() } else { Color.gray.opacity(0.25) } }
            .frame(width: 54, height: 54).clipped().clipShape(RoundedRectangle(cornerRadius: 5))
            .task(id: photo.id) {
                let value = await Task.detached { IOSPhotoPreparation.preview(photo.fileURL, maximumPixelSize: 144) }.value
                if !Task.isCancelled { image = value }
            }
    }
}

struct IOSZoomablePhoto: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> PhotoZoomScrollView {
        let view = PhotoZoomScrollView(); view.delegate = context.coordinator
        view.backgroundColor = .black; view.showsHorizontalScrollIndicator = false; view.showsVerticalScrollIndicator = false
        view.contentInsetAdjustmentBehavior = .never; view.bouncesZoom = true
        view.photo.contentMode = .scaleAspectFit; view.addSubview(view.photo)
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2; view.addGestureRecognizer(doubleTap)
        view.setPhoto(image)
        return view
    }
    func updateUIView(_ view: PhotoZoomScrollView, context: Context) { if view.photo.image !== image { view.setPhoto(image) } }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? PhotoZoomScrollView)?.photo }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { (scrollView as? PhotoZoomScrollView)?.centerPhoto() }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let view = gesture.view as? PhotoZoomScrollView else { return }
            if view.zoomScale > view.minimumZoomScale + 0.01 { view.setZoomScale(view.minimumZoomScale, animated: true) }
            else {
                let scale = min(view.maximumZoomScale, view.minimumZoomScale * 2.5), point = gesture.location(in: view.photo)
                let size = CGSize(width: view.bounds.width / scale, height: view.bounds.height / scale)
                view.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

final class PhotoZoomScrollView: UIScrollView {
    let photo = UIImageView()
    private var fittedSize = CGSize.zero
    func setPhoto(_ image: UIImage) { photo.image = image; fittedSize = .zero; setNeedsLayout() }
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedSize, bounds.width > 0, bounds.height > 0, let image = photo.image, image.size.width > 0, image.size.height > 0 {
            fittedSize = bounds.size
            minimumZoomScale = 1; maximumZoomScale = 1; zoomScale = 1
            photo.frame = CGRect(origin: .zero, size: image.size); contentSize = image.size
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            maximumZoomScale = max(1, fit * 5); minimumZoomScale = fit; maximumZoomScale = fit * 5; zoomScale = fit
        }
        centerPhoto()
    }
    func centerPhoto() { contentInset = UIEdgeInsets(top: max(0, (bounds.height - photo.frame.height) / 2), left: max(0, (bounds.width - photo.frame.width) / 2), bottom: 0, right: 0) }
}

/// Private-chat styling only. Group and saved-message screens keep their own UI.
enum ReferencePrivateChatStyle {
    static let input = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.16, green: 0.20, blue: 0.18, alpha: 1) : UIColor(red: 0.956, green: 0.973, blue: 0.961, alpha: 1) })
    static let outgoing = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.16, green: 0.29, blue: 0.21, alpha: 1) : UIColor(red: 0.875, green: 0.949, blue: 0.839, alpha: 1) })
    static let avatarTop = Color(hex: 0xA0E86B)
    static let avatarBottom = Color(hex: 0x45CA59)
}

struct ReferencePrivateChatAvatar: View {
    let title: String
    let avatarURL: String?
    var body: some View {
        ZStack {
            LinearGradient(colors: [ReferencePrivateChatStyle.avatarTop, ReferencePrivateChatStyle.avatarBottom], startPoint: .top, endPoint: .bottom)
            Text(String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1))).font(.system(size: 18)).foregroundStyle(.white)
            if let avatarURL, let url = APIClient.shared.mediaURL(avatarURL) {
                StableAvatarImage(url: url)
            }
        }
        .frame(width: 35, height: 35).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// The reference uses a point and outward voice arcs, rather than waveform bars.
struct ReferencePrivateVoiceIcon: View {
    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width * 0.22, y: size.height * 0.5)
            let ink = Color(uiColor: .secondaryLabel)
            context.fill(Path(ellipseIn: CGRect(x: center.x - 1.6, y: center.y - 1.6, width: 3.2, height: 3.2)), with: .color(ink))
            for fraction in [CGFloat(0.22), CGFloat(0.38), CGFloat(0.54)] {
                var arc = Path()
                arc.addArc(center: center, radius: size.height * fraction, startAngle: .degrees(-52), endAngle: .degrees(52), clockwise: false)
                context.stroke(arc, with: .color(ink), style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
            }
        }.frame(width: 27, height: 27).accessibilityHidden(true)
    }
}

/// Inline below the composer in both private chats and groups.
struct ReferencePrivateAttachmentPanel: View {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let onPhotos: () -> Void
    let disabled: Bool
    let onCamera: () -> Void
    let onFile: () -> Void
    let onVideo: () -> Void
    let onFavorite: () -> Void
    let onShake: (() -> Void)?
    let onContactCard: () -> Void
    let showsFileAttachments: Bool
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 4)

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                button("photo", "照片", onPhotos)
                button("camera.fill", "拍摄", onCamera)
                if showsFileAttachments {
                    button("doc.text", "文件", onFile)
                    button("video.fill", "视频文件", onVideo)
                }
                if let onShake { button("bolt.horizontal", "窗口抖动", onShake) }
                button("person.crop.rectangle", "名片", onContactCard)
                button("star", "收藏", onFavorite)
            }.padding(.horizontal, 12).padding(.vertical, 16)
        }
        .scrollIndicators(.hidden).frame(height: verticalSizeClass == .compact || !showsFileAttachments ? 126 : 220)
        .background(PulsePalette.background).overlay(alignment: .top) { Divider() }
        .disabled(disabled).opacity(disabled ? 0.45 : 1)
    }

    private func button(_ icon: String, _ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { item(icon, title) }.buttonStyle(.plain)
    }
    private func item(_ icon: String, _ title: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 27, weight: .regular)).frame(width: 60, height: 60)
                .background(PulsePalette.surface, in: RoundedRectangle(cornerRadius: 15))
            Text(title).font(.system(size: 12)).lineLimit(1)
        }.foregroundStyle(PulsePalette.ink).frame(maxWidth: .infinity).frame(height: 86)
    }
}

struct ReferencePrivateEmojiPanel: View {
    let onSelect: (String) -> Void
    let onDelete: () -> Void
    private let emoji = ["😀", "😄", "😊", "🥰", "😂", "😉", "😎", "🤔", "😮", "😴", "😭", "🥺", "😅", "😇", "🤗", "👍", "👏", "🙏", "💪", "👌", "❤️", "🎉", "🌹", "☀️"]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 8)
    var body: some View {
        VStack(spacing: 6) {
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(emoji, id: \.self) { value in
                    Button { onSelect(value) } label: { Text(value).font(.system(size: 28)).frame(maxWidth: .infinity).frame(height: 42) }.buttonStyle(.plain).accessibilityLabel("插入\(value)")
                }
            }
            HStack { Spacer(); Button(action: onDelete) { Image(systemName: "delete.left").font(.system(size: 20)).frame(width: 44, height: 34) }.buttonStyle(.plain).accessibilityLabel("删除最后一个字符") }
        }
        .foregroundStyle(PulsePalette.ink).padding(.horizontal, 12).padding(.vertical, 12).frame(height: 208)
        .background(PulsePalette.surface).overlay(alignment: .top) { Divider() }
    }
}

enum ReferencePrivateInputPanel { case none, attachments, emoji }

@MainActor struct IOSContactCardPicker: View {
    let client: APIClient
    let actorID: Int
    let current: () -> Bool
    let cancel: () -> Void
    let send: (Contact) -> Void
    @State private var contacts: [Contact] = []
    @State private var query = ""
    @State private var page = 0
    @State private var hasMore = true
    @State private var loading = false
    @State private var active = false
    @State private var submitted = false
    @State private var generation = UUID()
    @State private var failure = ""
    @State private var selected: Contact?
    private var matches: [Contact] { contacts.filter { $0.matchesContactCardQuery(query) } }
    var body: some View {
        NavigationStack {
            List {
                Section("选择要发送的联系人名片") {
                    ForEach(matches) { contact in
                        Button { if current(), !submitted { selected = contact } } label: {
                            HStack(spacing: 12) {
                                PulseAvatar(title: contact.nickname, size: 42, avatarURL: contact.avatarURL)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(contact.contactCardDisplayName).foregroundStyle(PulsePalette.ink).lineLimit(1)
                                    Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(PulsePalette.muted).lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: "person.crop.rectangle").foregroundStyle(PulsePalette.accent)
                            }
                        }.disabled(submitted)
                    }
                    if matches.isEmpty, !loading, failure.isEmpty { Text(query.isEmpty ? "暂无联系人" : "未找到匹配联系人").foregroundStyle(PulsePalette.muted) }
                    if loading { ProgressView("正在加载联系人…") }
                    if !failure.isEmpty { Text("联系人加载失败，请重试").foregroundStyle(PulsePalette.danger); Button("重试加载联系人") { Task { await load() } } }
                    if hasMore, !loading, failure.isEmpty { Button("加载更多联系人") { Task { await load() } } }
                }
            }
            .searchable(text: $query, prompt: "搜索昵称 / 用户名 / ID")
            .navigationTitle("发送名片").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消", action: cancel) } }
        }
        .task { active = true; generation = UUID(); await load() }
        .pulseOnChange(of: query) { value in if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, hasMore, failure.isEmpty { Task { await load() } } }
        .onDisappear { active = false; generation = UUID(); selected = nil }
        .confirmationDialog("发送名片", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }), titleVisibility: .visible) {
            if let contact = selected { Button("发送\(contact.nickname)的名片") { if active, current(), !submitted { submitted = true; selected = nil; send(contact) } } }
            Button("取消", role: .cancel) { selected = nil }
        } message: { Text("发送到当前聊天") }
    }
    private func load() async {
        guard active, current(), !loading, hasMore, !submitted else { return }
        let request = generation; loading = true; failure = ""
        defer { if generation == request { loading = false } }
        do {
            repeat {
                guard active, current(), generation == request, !Task.isCancelled else { return }
                let next = page + 1
                let result = try await client.contactCardContacts(page: next)
                guard active, current(), generation == request, !Task.isCancelled else { return }
                guard result.isValid(expectedPage: next) else { throw APIClientError.invalidResponse }
                var ids = Set(contacts.map(\.userId))
                for contact in result.items where contact.userId > 0 && contact.userId != actorID {
                    if ids.insert(contact.userId).inserted { contacts.append(contact) }
                }
                page = next; hasMore = result.hasMore
            } while hasMore && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } catch { if active, current(), generation == request, !Task.isCancelled { failure = error.localizedDescription } }
    }
}

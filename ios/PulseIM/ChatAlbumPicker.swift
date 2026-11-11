import SwiftUI
import Photos
import PhotosUI
import UIKit

enum IOSChatPhotoSource {
    case asset(PHAsset)
    case provider(NSItemProvider)
}

@MainActor private final class IOSChatAlbumLibrary: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    struct Album: Identifiable { let id: String; let title: String; let collection: PHAssetCollection }
    @Published var photos: [PHAsset] = []
    @Published var albums: [Album] = []
    @Published var selected: [String] = []
    @Published var albumID: String?
    @Published var access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published var feedback = ""
    override init() { super.init(); PHPhotoLibrary.shared().register(self) }
    deinit { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) { Task { @MainActor [weak self] in self?.reload() } }
    func authorize() async {
        if access == .notDetermined { access = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
        reload()
    }
    func reload() {
        access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard access == .authorized || access == .limited else { photos = []; albums = []; return }
        let options = PHFetchOptions(); options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]; options.fetchLimit = 5000
        var found: [Album] = []
        for type in [PHAssetCollectionType.smartAlbum, .album] {
            PHAssetCollection.fetchAssetCollections(with: type, subtype: .any, options: nil).enumerateObjects { collection, _, _ in
                let images = PHFetchOptions(); images.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue); images.fetchLimit = 1
                if PHAsset.fetchAssets(in: collection, options: images).count > 0 {
                    found.append(Album(id: collection.localIdentifier, title: collection.localizedTitle ?? "相册", collection: collection))
                }
            }
        }
        albums = found
        if albumID != nil && !found.contains(where: { $0.id == albumID }) { albumID = nil }
        let result: PHFetchResult<PHAsset>
        if let collection = found.first(where: { $0.id == albumID })?.collection {
            options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
            result = PHAsset.fetchAssets(in: collection, options: options)
        } else { result = PHAsset.fetchAssets(with: .image, options: options) }
        var entries: [PHAsset] = []; result.enumerateObjects { asset, _, _ in entries.append(asset) }; photos = entries
        var valid = Set<String>()
        PHAsset.fetchAssets(withLocalIdentifiers: selected, options: nil).enumerateObjects { asset, _, _ in valid.insert(asset.localIdentifier) }
        selected = selected.filter { valid.contains($0) }
    }
    func toggle(_ asset: PHAsset) {
        if selected.contains(asset.localIdentifier) { selected.removeAll { $0 == asset.localIdentifier } }
        else if selected.count < IOSPhotoSelection.limit { selected.append(asset.localIdentifier) }
        else { feedback = "一次最多选择 \(IOSPhotoSelection.limit) 张照片" }
    }
    func sources() -> [IOSChatPhotoSource] {
        var byID: [String: PHAsset] = [:]
        PHAsset.fetchAssets(withLocalIdentifiers: selected, options: nil).enumerateObjects { asset, _, _ in byID[asset.localIdentifier] = asset }
        return selected.compactMap { byID[$0].map(IOSChatPhotoSource.asset) }
    }
    func manageLimitedAccess() {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              var controller = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
        while let next = controller.presentedViewController { controller = next }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller)
    }
}

/// Checkbox selects. Tapping the photo opens a local, zoomable preview.
/// Send returns immediately; preparation/upload happens in the chat queue.
@MainActor struct IOSChatPhotoPicker: View {
    let onSelection: ([IOSChatPhotoSource]) -> Void
    let onVideoSelection: ((NSItemProvider) -> Void)?
    init(onVideoSelection: ((NSItemProvider) -> Void)? = nil, onSelection: @escaping ([IOSChatPhotoSource]) -> Void) {
        self.onVideoSelection = onVideoSelection; self.onSelection = onSelection
    }
    @StateObject private var library = IOSChatAlbumLibrary()
    private struct Focus: Identifiable { let asset: PHAsset; var id: String { asset.localIdentifier } }
    @State private var focus: Focus?
    @State private var systemPicker = false
    @State private var systemVideoPicker = false
    @State private var pendingVideo: NSItemProvider?
    @State private var pendingSelection: [IOSChatPhotoSource]?
    @State private var submitted = false
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)
    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                if onVideoSelection != nil {
                    HStack(spacing: 28) {
                        Text("照片").font(.headline).foregroundStyle(Color.blue)
                        Button("视频") {
                            guard library.selected.isEmpty else { library.feedback = "视频需要单独发送，请先取消已选照片"; return }
                            systemVideoPicker = true
                        }.accessibilityLabel("从手机相册选择视频")
                    }.frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                if library.access == .limited {
                    HStack { Text("仅显示已授权照片").font(.caption).foregroundStyle(.secondary); Spacer(); Button("更改", action: library.manageLimitedAccess) }.padding(.horizontal)
                }
                if library.access == .authorized || library.access == .limited {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 8) {
                            ForEach(library.photos, id: \.localIdentifier) { asset in
                                ZStack(alignment: .topTrailing) {
                                    Button { focus = Focus(asset: asset) } label: {
                                        IOSChatAlbumImage(asset: asset, preview: false).frame(height: 118).frame(maxWidth: .infinity).clipped().contentShape(Rectangle())
                                    }.buttonStyle(.plain).accessibilityLabel("预览照片")
                                    selectionButton(asset).padding(4)
                                }.clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                        }.padding(12)
                        if library.photos.isEmpty { Text("暂无可用照片").foregroundStyle(.secondary).padding(30) }
                    }
                } else {
                    Spacer(); Text("允许访问照片后，可在相册中预览和勾选图片").multilineTextAlignment(.center).padding()
                    Button("授权相册") { Task { await library.authorize() } }
                    Button("选择指定照片") { systemPicker = true }
                    Button("打开系统设置") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                    Spacer()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("取消") { guard !submitted else { return }; submitted = true; onSelection([]) } }
                ToolbarItem(placement: .principal) {
                    Menu {
                        Button("全部照片") { library.albumID = nil; library.reload() }
                        ForEach(library.albums) { album in Button(album.title) { library.albumID = album.id; library.reload() } }
                    } label: { Text(library.albums.first(where: { $0.id == library.albumID })?.title ?? "全部照片").font(.headline).lineLimit(1) }
                }
                ToolbarItem(placement: .topBarTrailing) { sendButton }
            }
        }
        .task { await library.authorize() }
        .fullScreenCover(item: $focus, onDismiss: finishPending) { entry in
            VStack(spacing: 8) {
                HStack {
                    Button("返回") { focus = nil }; Spacer(); sendButton
                }.padding()
                IOSChatAlbumImage(asset: entry.asset, preview: true).frame(maxWidth: .infinity, maxHeight: .infinity)
                HStack { selectionButton(entry.asset); Text("选择此图"); Spacer(); Text("双指缩放或双击查看").font(.caption).foregroundStyle(.secondary) }.padding()
            }.background(Color.black).foregroundStyle(.white)
        }
        .sheet(isPresented: $systemPicker, onDismiss: finishPending) {
            IOSSystemPhotoPicker { providers in
                if !providers.isEmpty { submitted = true; pendingSelection = providers.map(IOSChatPhotoSource.provider) }
                systemPicker = false
            }
        }
        .sheet(isPresented: $systemVideoPicker, onDismiss: finishPending) {
            IOSSystemVideoPicker { provider in
                if let provider { submitted = true; pendingVideo = provider }
                systemVideoPicker = false
            }
        }
        .alert("提示", isPresented: Binding(get: { !library.feedback.isEmpty }, set: { if !$0 { library.feedback = "" } })) {
            Button("知道了", role: .cancel) { library.feedback = "" }
        } message: { Text(library.feedback) }
    }
    private var sendButton: some View {
        Button(library.selected.isEmpty ? "发送" : "发送(\(library.selected.count))") {
            guard !submitted, !library.selected.isEmpty else { return }
            let sources = library.sources()
            guard sources.count == library.selected.count else { library.feedback = "部分照片已移动或权限已变化，请重新选择"; library.reload(); return }
            submitted = true
            if focus != nil { pendingSelection = sources; focus = nil } else { onSelection(sources) }
        }.disabled(library.selected.isEmpty || submitted)
    }
    private func selectionButton(_ asset: PHAsset) -> some View {
        let index = library.selected.firstIndex(of: asset.localIdentifier)
        return Button { library.toggle(asset) } label: {
            ZStack {
                Circle().fill(index == nil ? Color.black.opacity(0.4) : Color.blue).frame(width: 26, height: 26).overlay(Circle().stroke(.white, lineWidth: 1))
                if let index { Text("\(index + 1)").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white) }
            }.frame(width: 40, height: 40).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(index == nil ? "选择照片" : "取消选择照片").disabled(submitted)
    }
    private func finishPending() {
        if let video = pendingVideo { pendingVideo = nil; onVideoSelection?(video); return }
        if let selection = pendingSelection { pendingSelection = nil; onSelection(selection) }
    }
}

@MainActor private struct IOSChatAlbumImage: View {
    let asset: PHAsset
    let preview: Bool
    @State private var image: UIImage?
    @State private var request: PHImageRequestID = PHInvalidImageRequestID
    @State private var generation = UUID()
    @State private var failed = false
    var body: some View {
        ZStack {
            Color.gray.opacity(0.12)
            if let image {
                if preview { IOSZoomablePhoto(image: image) }
                else { Image(uiImage: image).resizable().scaledToFill() }
            } else if failed {
                if preview { Button("图片读取失败，点击重试", action: load) }
                else { Image(systemName: "icloud.and.arrow.down").foregroundStyle(.secondary) }
            } else { ProgressView() }
        }
        .onAppear(perform: load)
        .onDisappear { generation = UUID(); PHImageManager.default().cancelImageRequest(request) }
    }
    private func load() {
        PHImageManager.default().cancelImageRequest(request)
        let ticket = UUID(); generation = ticket; failed = false
        let options = PHImageRequestOptions(); options.isNetworkAccessAllowed = true
        options.deliveryMode = preview ? .highQualityFormat : .opportunistic; options.resizeMode = .fast
        let edge: CGFloat = preview ? 2000 : 360
        request = PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: edge, height: edge), contentMode: preview ? .aspectFit : .aspectFill, options: options) { value, info in
            DispatchQueue.main.async {
                guard generation == ticket else { return }
                if let value { image = value }
                else if (info?[PHImageResultIsDegradedKey] as? Bool) != true { failed = true }
            }
        }
    }
}

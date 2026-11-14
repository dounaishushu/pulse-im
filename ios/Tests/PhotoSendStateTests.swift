import Foundation

@main @MainActor struct PhotoSendStateTests {
    enum Failure: Error { case assertion(String), retry }
    static func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw Failure.assertion(message) }
    }
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pulse-photo-test-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        for mime in ["image/jpeg", "image/png", "image/gif", "image/webp"] {
            try check(IOSPhotoSelection.originalFormat(mime: mime)?.mime == mime, "original MIME is preserved")
        }
        try check(IOSPhotoSelection.originalFormat(mime: "image/heic") == nil, "unsupported originals must not silently transcode")
        let file = directory.appendingPathComponent("original.png")
        let output = try IOSBoundedPhotoFile(url: file, maximumBytes: 4)
        try output.append(Data([1, 2, 3]))
        do { try output.append(Data([4, 5])); throw Failure.assertion("oversized chunk accepted") }
        catch let error as NSError where error.domain == "PulsePhoto" && error.code == 413 {}
        output.close()
        do { try output.append(Data([6])); throw Failure.assertion("late callback wrote after close") }
        catch is CancellationError {}
        let bytes = try Data(contentsOf: file)
        try check(bytes == Data([1, 2, 3]), "bounded copy changed original or wrote beyond limit")
        print("PASS: original formats, exact bytes, overflow and late cancellation")

        let photos = (0..<300).map { index in
            IOSPreparedPhoto(id: UUID(), fileURL: file, width: 1, height: 1, mime: "image/png", original: index % 2 == 0)
        }
        try check(IOSPhotoSelection.limit >= photos.count, "300-photo selection unavailable")
        let queue = IOSPhotoSendQueue<Int>(photos: photos)
        var uploads: [UUID: Int] = [:], active = 0, peak = 0, receipts: [Int] = []
        var failOnce = true
        func run() async throws {
            try await queue.run(current: { true }, upload: { photo in
                active += 1; peak = max(peak, active)
                defer { active -= 1 }
                uploads[photo.id, default: 0] += 1
                try await Task.sleep(nanoseconds: 100_000)
                let index = photos.firstIndex(where: { $0.id == photo.id })!
                try check(photo.original == (index % 2 == 0) && photo.mime == "image/png", "retry lost original metadata")
                return index
            }, send: { photo, uploaded, index in
                try check(photos[index].id == photo.id && uploaded == index, "photo order changed")
                if index == 150 && failOnce { failOnce = false; throw Failure.retry }
                return index
            }, accepted: { receipt, index in
                try check(receipt == index, "wrong receipt"); receipts.append(receipt)
            }, progress: { _, _ in })
        }
        do { try await run(); throw Failure.assertion("injected failure missing") } catch Failure.retry {}
        try check(queue.nextIndex == 150 && !queue.completed, "failed image was skipped")
        try await run()
        try check(queue.completed && receipts == Array(0..<300), "retry duplicated or omitted photos")
        try check(peak <= 2 && uploads.count == 300 && uploads.values.allSatisfy { $0 == 1 }, "unbounded work or duplicate uploads")
        print("PASS: 300 ordered photos, at most two uploads, retry retains originals and receipts")
    }
}

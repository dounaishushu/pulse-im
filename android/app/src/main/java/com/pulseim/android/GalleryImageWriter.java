package com.pulseim.android;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.function.BooleanSupplier;

/** Publish a gallery item only after the complete, still-authorized image was written. */
final class GalleryImageWriter {
    interface Destination {
        OutputStream open() throws IOException;
        void publish() throws IOException;
        void rollback();
    }
    static void write(InputStream source, Destination destination, long limit, BooleanSupplier current) throws IOException {
        try {
            long total = 0;
            try (OutputStream output = destination.open()) {
                byte[] buffer = new byte[32 * 1024];
                for (int size; (size = source.read(buffer)) != -1;) {
                    if (!current.getAsBoolean()) throw new IOException("已取消");
                    total += size;
                    if (total > limit) throw new IOException("图片超过保存大小限制");
                    output.write(buffer, 0, size);
                }
                if (total == 0) throw new IOException("图片内容为空");
            }
            if (!current.getAsBoolean()) throw new IOException("已取消");
            destination.publish();
        } catch (IOException | RuntimeException | Error failure) {
            try { destination.rollback(); }
            catch (RuntimeException | Error cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }
}

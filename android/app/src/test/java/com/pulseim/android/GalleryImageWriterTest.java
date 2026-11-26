package com.pulseim.android;

import org.junit.Test;
import java.io.*;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.*;

public class GalleryImageWriterTest {
    private static class Target implements GalleryImageWriter.Destination {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean published, rolledBack, closed;
        @Override public OutputStream open() throws IOException {
            return new FilterOutputStream(bytes) { @Override public void close() throws IOException { super.close(); closed = true; } };
        }
        @Override public void publish() throws IOException { assertTrue(closed); published = true; }
        @Override public void rollback() { rolledBack = true; }
    }
    @Test public void originalImageBytesArePreservedAcrossMultipleChunks() throws Exception {
        byte[] original = new byte[100_007];
        for (int i = 0; i < original.length; i++) original[i] = (byte)(i * 31);
        Target target = new Target();
        GalleryImageWriter.write(new ByteArrayInputStream(original), target, original.length, () -> true);
        assertArrayEquals(original, target.bytes.toByteArray()); assertTrue(target.published); assertFalse(target.rolledBack);
    }
    @Test public void emptyImageNeverPublishesAnAlbumItem() {
        Target target = new Target();
        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[0]), target, 10, () -> true));
        assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void exceedingTheLimitRemovesThePartialItem() {
        Target target = new Target();
        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[11]), target, 10, () -> true));
        assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void accountOrPreviewChangeDuringCopyCancelsAndRollsBack() {
        Target target = new Target(); AtomicBoolean current = new AtomicBoolean(true);
        InputStream source = new ByteArrayInputStream(new byte[70_000]) {
            @Override public synchronized int read(byte[] bytes, int offset, int length) {
                int n = super.read(bytes, offset, length); if (pos > 32_768) current.set(false); return n;
            }
        };
        assertThrows(IOException.class, () -> GalleryImageWriter.write(source, target, 100_000, current::get));
        assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void cancellationAfterTheLastByteStillPreventsPublication() {
        AtomicBoolean current = new AtomicBoolean(true); Target target = new Target();
        InputStream source = new ByteArrayInputStream(new byte[]{1, 2}) {
            @Override public synchronized int read(byte[] bytes, int offset, int length) {
                int n = super.read(bytes, offset, length); if (n < 0) current.set(false); return n;
            }
        };
        assertThrows(IOException.class, () -> GalleryImageWriter.write(source, target, 10, current::get));
        assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void outputOpenFailureDoesNotLeaveAPendingAlbumItem() {
        Target target = new Target() { @Override public OutputStream open() throws IOException { throw new IOException("storage"); } };
        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[]{1}), target, 10, () -> true));
        assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void galleryPublicationFailureRollsBackTheWrittenImage() {
        Target target = new Target() { @Override public void publish() throws IOException { throw new IOException("publish"); } };
        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[]{1}), target, 10, () -> true));
        assertTrue(target.closed); assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void brokenInputDoesNotPublishThePartialImage() {
        Target target = new Target();
        InputStream source = new InputStream() { @Override public int read() throws IOException { throw new IOException("read"); } };
        assertThrows(IOException.class, () -> GalleryImageWriter.write(source, target, 10, () -> true));
        assertTrue(target.rolledBack); assertFalse(target.published);
    }
    @Test public void cleanupFailureDoesNotHideTheOriginalWriteError() {
        IOException problem = new IOException("open");
        Target target = new Target() {
            @Override public OutputStream open() throws IOException { throw problem; }
            @Override public void rollback() { throw new IllegalStateException("cleanup"); }
        };
        IOException observed = assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[]{1}), target, 10, () -> true));
        assertSame(problem, observed); assertEquals(1, observed.getSuppressed().length);
    }
}

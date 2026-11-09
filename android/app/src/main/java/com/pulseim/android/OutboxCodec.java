package com.pulseim.android;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.Locale;

/** Length-delimited UTF-8, so large drafts do not hit DataOutput.writeUTF's 64 KiB limit. */
final class OutboxCodec {
    static boolean sameEndpoint(String first, String second) {
        if (first.equals(second)) return true;
        try { return endpoint(first).equals(endpoint(second)); } catch (Exception ignored) { return false; }
    }
    private static String endpoint(String raw) throws Exception {
        URI uri = new URI(raw.trim()); String scheme = uri.getScheme().toLowerCase(Locale.ROOT), host = uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort(); if ((scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80)) port = -1;
        String path = uri.getRawPath(); while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        return scheme + "://" + host + (port < 0 ? "" : ":" + port) + path + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
    }
    static void writeString(DataOutputStream out, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 8 * 1024 * 1024) throw new IOException("Outbox field too large");
        out.writeInt(bytes.length); out.write(bytes);
    }
    static String readString(DataInputStream in) throws IOException {
        int length = in.readInt(); if (length < 0 || length > 8 * 1024 * 1024 || length > in.available()) throw new IOException("Invalid outbox string");
        byte[] bytes = new byte[length]; in.readFully(bytes); return new String(bytes, StandardCharsets.UTF_8);
    }
}

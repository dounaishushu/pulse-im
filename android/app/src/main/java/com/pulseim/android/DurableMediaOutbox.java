package com.pulseim.android;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.HashSet;

/** One ordered media lane per conversation, durable before any upload/message request. */
final class DurableMediaOutbox {
    enum Phase { QUEUED, UPLOADING, COMMITTING, FAILED }
    static final class Entry {
        final String requestId, token, endpoint, kind, mime, displayName, attachmentId;
        final int userId, conversationId, replyToId;
        final long size, durationMs;
        final boolean original;
        Phase phase = Phase.QUEUED;
        long attempt;
        String error = "", uploadJson = "";
        Entry(String requestId, String token, int userId, String endpoint, int cid, String kind, String mime, String name, String attachmentId, long size, int reply, long durationMs, boolean original) {
            this.requestId = requestId; this.token = token; this.userId = userId; this.endpoint = endpoint; conversationId = cid;
            this.kind = kind; this.mime = mime; displayName = name; this.attachmentId = attachmentId; this.size = size; replyToId = reply; this.durationMs = durationMs;
            this.original = original;
        }
    }
    private final String token, endpoint;
    private final int userId;
    private final OutboxPersistence storage;
    private final OutboxAttachments attachments;
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
    private boolean detached;
    DurableMediaOutbox(OutboxPersistence storage, OutboxAttachments attachments, String token, int userId, String endpoint) {
        if (storage == null || attachments == null || token == null || token.isEmpty() || userId <= 0 || endpoint == null || endpoint.isEmpty()) throw new IllegalArgumentException("Invalid media outbox owner");
        this.storage = storage; this.attachments = attachments; this.token = token; this.userId = userId; this.endpoint = endpoint;
        restore(storage.read()); persist(entries);
        HashSet<String> retained = new HashSet<>(); for (Entry entry : entries.values()) retained.add(entry.attachmentId); attachments.retain(retained);
    }
    Entry enqueue(String requestId, int cid, String kind, String mime, String name, File source, int replyToId, long durationMs) {
        return enqueue(requestId, cid, kind, mime, name, source, replyToId, durationMs, false);
    }
    Entry enqueue(String requestId, int cid, String kind, String mime, String name, File source, int replyToId, long durationMs, boolean original) {
        if (original && !"image".equals(kind)) throw new IllegalArgumentException("Original requires image");
        if (requestId == null || requestId.isEmpty() || requestId.length() > 200 || cid <= 0 || !(kind.equals("image") || kind.equals("video") || kind.equals("file") || kind.equals("voice")) || mime == null || name == null || replyToId < 0 || durationMs < 0 || (kind.equals("voice") && durationMs <= 0)) throw new IllegalArgumentException("Invalid media submission");
        synchronized (this) { requireAttached(); if (entries.containsKey(requestId)) throw new IllegalArgumentException("Duplicate media submission"); }
        // Large file IO never holds the queue monitor used by UI pending()/claim().
        long size = source.length(); String attachmentId = attachments.save(source);
        Entry entry = new Entry(requestId, token, userId, endpoint, cid, kind, mime, name, attachmentId, size, replyToId, durationMs, original);
        try {
            synchronized (this) {
                requireAttached(); if (entries.containsKey(requestId)) throw new IllegalArgumentException("Duplicate media submission");
                LinkedHashMap<String, Entry> next = new LinkedHashMap<>(entries); next.put(requestId, entry);
                persist(next); entries.put(requestId, entry); return entry;
            }
        } catch (RuntimeException error) { attachments.delete(attachmentId); throw error; }
    }
    synchronized List<Entry> pending(int cid) {
        List<Entry> result = new ArrayList<>(); if (detached) return result;
        for (Entry entry : entries.values()) if (cid <= 0 || entry.conversationId == cid) result.add(entry); return result;
    }
    synchronized Entry claim(int cid) {
        if (detached) return null;
        for (Entry entry : entries.values()) if (entry.conversationId == cid) {
            if (entry.phase != Phase.QUEUED) return null;
            entry.attempt++;
            try { transition(entry, Phase.UPLOADING, "", entry.uploadJson); } catch (RuntimeException error) { entry.attempt--; throw error; }
            return entry;
        }
        return null;
    }
    synchronized boolean retry(Entry entry) {
        if (!owns(entry) || entry.phase != Phase.FAILED) return false;
        transition(entry, Phase.QUEUED, "", entry.uploadJson); return true;
    }
    synchronized boolean uploaded(Entry entry, String uploadJson) {
        if (!owns(entry) || entry.phase != Phase.UPLOADING) return false;
        if (uploadJson == null || uploadJson.isEmpty()) throw new IllegalArgumentException("Missing uploaded media");
        transition(entry, entry.phase, entry.error, uploadJson); return true;
    }
    synchronized boolean uploaded(Entry entry, String uploadJson, long attempt) { return entry.attempt == attempt && uploaded(entry, uploadJson); }
    synchronized boolean committing(Entry entry) {
        if (!owns(entry) || entry.phase != Phase.UPLOADING || entry.uploadJson.isEmpty()) return false;
        transition(entry, Phase.COMMITTING, "", entry.uploadJson); return true;
    }
    synchronized boolean committing(Entry entry, long attempt) { return entry.attempt == attempt && committing(entry); }
    synchronized boolean fail(Entry entry, String error) {
        if (!owns(entry)) return false;
        entry.phase = Phase.FAILED; entry.error = error == null ? "发送未确认，请确认后重试" : error;
        // Preserve the visible retry path if disk is full. The last durable phase
        // also restores paused, and retry/claim still require a successful commit.
        try { persist(entries); } catch (RuntimeException failure) { entry.error += "；本地状态暂未保存，请释放存储空间后重试"; }
        return true;
    }
    synchronized boolean fail(Entry entry, String error, long attempt) { return entry.attempt == attempt && fail(entry, error); }
    synchronized Entry acknowledge(String requestId, int cid) {
        Entry entry = entries.get(requestId); if (!owns(entry) || entry.conversationId != cid) return null;
        remove(entry); return entry;
    }
    synchronized boolean discard(Entry entry) {
        if (!owns(entry) || (entry.phase != Phase.FAILED && entry.phase != Phase.QUEUED)) return false;
        remove(entry); return true;
    }
    OutboxAttachments.DecryptedFile openFile(Entry entry) {
        final String id, extension; final long attempt;
        synchronized (this) {
            if (!owns(entry) || entry.phase != Phase.UPLOADING) throw new IllegalStateException("待发附件已停止或账号已切换");
            id = entry.attachmentId; attempt = entry.attempt;
            String suffix = entry.kind.equals("voice") ? "m4a" : entry.displayName.substring(entry.displayName.lastIndexOf('.') + 1);
            if (entry.kind.equals("image")) {
                if (entry.mime.equals("image/jpeg")) suffix = "jpg";
                else if (entry.mime.equals("image/png")) suffix = "png";
                else if (entry.mime.equals("image/gif")) suffix = "gif";
                else if (entry.mime.equals("image/webp")) suffix = "webp";
            }
            extension = suffix;
        }
        OutboxAttachments.DecryptedFile file = attachments.open(id, extension);
        synchronized (this) {
            if (!owns(entry) || entry.phase != Phase.UPLOADING || entry.attempt != attempt) { file.close(); throw new IllegalStateException("待发附件已停止或账号已切换"); }
        }
        return file;
    }
    synchronized void detach() { detached = true; entries.clear(); }
    private void requireAttached() { if (detached) throw new IllegalStateException("待发队列账号已切换"); }
    private boolean owns(Entry entry) { return !detached && entry != null && entries.get(entry.requestId) == entry; }
    private void remove(Entry entry) {
        LinkedHashMap<String, Entry> next = new LinkedHashMap<>(entries); next.remove(entry.requestId); persist(next);
        entries.remove(entry.requestId); attachments.delete(entry.attachmentId);
    }
    private void transition(Entry entry, Phase phase, String error, String uploadJson) {
        Phase oldPhase = entry.phase; String oldError = entry.error, oldUpload = entry.uploadJson;
        entry.phase = phase; entry.error = error; entry.uploadJson = uploadJson;
        try { persist(entries); } catch (RuntimeException failure) { entry.phase = oldPhase; entry.error = oldError; entry.uploadJson = oldUpload; throw failure; }
    }
    private void persist(LinkedHashMap<String, Entry> value) {
        requireAttached();
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
            out.writeInt(2); out.writeInt(value.size());
            for (Entry entry : value.values()) {
                out.writeUTF(entry.requestId); out.writeUTF(entry.endpoint); out.writeInt(entry.userId); out.writeInt(entry.conversationId);
                out.writeUTF(entry.kind); out.writeUTF(entry.mime); OutboxCodec.writeString(out, entry.displayName); out.writeUTF(entry.attachmentId);
                out.writeLong(entry.size); out.writeInt(entry.replyToId); out.writeLong(entry.durationMs); out.writeUTF(entry.phase.name());
                OutboxCodec.writeString(out, entry.error); OutboxCodec.writeString(out, entry.uploadJson);
                out.writeBoolean(entry.original);
            }
            out.flush(); storage.write(bytes.toByteArray());
        } catch (IOException error) { throw new IllegalStateException("无法保存待发媒体", error); }
    }
    private void restore(byte[] snapshot) {
        if (snapshot == null) return;
        try {
            DataInputStream in = new DataInputStream(new ByteArrayInputStream(snapshot));
            int version = in.readInt();
            if (version != 1 && version != 2) throw new IOException("Unsupported media outbox version");
            int count = in.readInt(); if (count < 0 || count > 10000) throw new IOException("Invalid media outbox size");
            for (int i = 0; i < count; i++) {
                String id = in.readUTF(), savedEndpoint = in.readUTF(); int savedUser = in.readInt(), cid = in.readInt();
                String kind = in.readUTF(), mime = in.readUTF(), name = OutboxCodec.readString(in), attachmentId = in.readUTF();
                long size = in.readLong(); int reply = in.readInt(); long duration = in.readLong(); Phase phase = Phase.valueOf(in.readUTF());
                String error = OutboxCodec.readString(in), upload = OutboxCodec.readString(in);
                boolean original = version >= 2 && in.readBoolean();
                if (original && !"image".equals(kind)) throw new IOException("Invalid original media kind");
                if (id.isEmpty() || !OutboxCodec.sameEndpoint(savedEndpoint, endpoint) || savedUser != userId || cid <= 0 || size <= 0 || reply < 0 || duration < 0 || !(kind.equals("image") || kind.equals("video") || kind.equals("file") || kind.equals("voice"))) throw new IOException("Invalid media owner/message");
                Entry entry = new Entry(id, token, userId, endpoint, cid, kind, mime, name, attachmentId, size, reply, duration, original);
                entry.phase = Phase.FAILED; entry.uploadJson = upload;
                entry.error = phase == Phase.FAILED && !error.isEmpty() ? error : "已恢复待发媒体，请确认后重试";
                if (!attachments.exists(attachmentId)) entry.error = "本地附件不可用，请移除后重新选择";
                if (entries.put(id, entry) != null) throw new IOException("Duplicate media request");
            }
            if (in.available() != 0) throw new IOException("Trailing media outbox data");
        } catch (IOException | IllegalArgumentException error) { throw new IllegalStateException("无法读取待发媒体，请保留本地数据后重试", error); }
    }
}

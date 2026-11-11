package com.pulseim.android;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/** Text submissions are distinct actions, even when their text is identical. */
final class TextSendQueue {
    enum Phase { QUEUED, SENDING, FAILED }
    static final class Entry {
        final String requestId, token, endpoint, text;
        final int userId, conversationId, replyToId;
        private final int[] mentionUserIds;
        Phase phase = Phase.QUEUED;
        long attempt;
        String error = "";
        Entry(String token, int userId, String endpoint, int conversationId, String text, int replyToId, int[] mentionUserIds) {
            this("android-text-" + UUID.randomUUID(), token, userId, endpoint, conversationId, text, replyToId, mentionUserIds);
        }
        Entry(String requestId, String token, int userId, String endpoint, int conversationId, String text, int replyToId, int[] mentionUserIds) {
            this.requestId = requestId; this.token = token;
            this.userId = userId; this.endpoint = endpoint; this.conversationId = conversationId;
            this.text = text; this.replyToId = replyToId;
            this.mentionUserIds = mentionUserIds.clone();
        }
        int[] mentionUserIds() { return mentionUserIds.clone(); }
        boolean account(String token, int userId, String endpoint) {
            return this.token.equals(token) && this.userId == userId && this.endpoint.equals(endpoint);
        }
    }
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
    private OutboxPersistence storage;
    private boolean storageRequired;
    private String boundToken, boundEndpoint;
    private int boundUserId;

    /** Rebinding restores captured actions, never credentials or automatic network work. */
    synchronized void bindStorage(OutboxPersistence storage, String token, int userId, String endpoint) {
        if (storage == null || token == null || token.isEmpty() || userId <= 0 || endpoint == null || endpoint.isEmpty()) throw new IllegalArgumentException("Invalid outbox account");
        LinkedHashMap<String, Entry> restored = decode(storage.read(), token, userId, endpoint);
        // Persist recovery before publishing it, so interrupted/uncertain work stays paused.
        storage.write(encode(restored));
        entries.clear(); entries.putAll(restored); this.storage = storage; storageRequired = true;
        boundToken = token; boundUserId = userId; boundEndpoint = endpoint;
    }
    private void requireAccount(String token, int userId, String endpoint) {
        if (storageRequired && (storage == null || !token.equals(boundToken) || userId != boundUserId || !endpoint.equals(boundEndpoint))) throw new IllegalStateException("待发队列账号已切换，请重新打开会话");
    }
    private void persist(LinkedHashMap<String, Entry> value) {
        if (storage != null) storage.write(encode(value));
        else if (storageRequired) throw new IllegalStateException("待发队列尚未加载");
    }
    synchronized Entry enqueue(String token, int userId, String endpoint, int conversationId, String text, int replyToId) {
        return enqueue(token, userId, endpoint, conversationId, text, replyToId, new int[0]);
    }
    synchronized Entry enqueue(String token, int userId, String endpoint, int conversationId, String text, int replyToId, int[] mentionUserIds) {
        if (token == null || token.isEmpty() || userId <= 0 || conversationId <= 0 || text.trim().isEmpty()) throw new IllegalArgumentException("Invalid text submission");
        if (mentionUserIds == null || mentionUserIds.length > 100) throw new IllegalArgumentException("Invalid mention targets");
        for (int target : mentionUserIds) if (target <= 0 || target == userId) throw new IllegalArgumentException("Invalid mention target");
        requireAccount(token, userId, endpoint);
        Entry entry = new Entry(token, userId, endpoint, conversationId, text, replyToId, mentionUserIds);
        LinkedHashMap<String, Entry> next = new LinkedHashMap<>(entries); next.put(entry.requestId, entry);
        persist(next); entries.put(entry.requestId, entry); return entry;
    }
    synchronized List<Entry> pending(String token, int userId, String endpoint, int conversationId) {
        List<Entry> result = new ArrayList<>();
        for (Entry entry : entries.values()) if (entry.account(token, userId, endpoint) && entry.conversationId == conversationId) result.add(entry);
        return result;
    }
    synchronized List<Entry> claim(String token, int userId, String endpoint) {
        List<Entry> result = new ArrayList<>(); Set<Integer> seen = new HashSet<>();
        for (Entry entry : entries.values()) {
            if (!entry.account(token, userId, endpoint) || !seen.add(entry.conversationId)) continue;
            if (entry.phase == Phase.QUEUED) { entry.phase = Phase.SENDING; entry.attempt++; result.add(entry); }
        }
        if (!result.isEmpty()) {
            try { persist(entries); } catch (RuntimeException error) { for (Entry entry : result) { entry.phase = Phase.QUEUED; entry.attempt--; } throw error; }
        }
        return result;
    }
    synchronized boolean fail(Entry entry, String error) {
        if (entries.get(entry.requestId) != entry || entry.phase != Phase.SENDING) return false;
        entry.phase = Phase.FAILED; entry.error = error == null ? "发送未确认，请确认后重试" : error;
        // The captured payload is already durable. Pausing memory is safe even when
        // disk still says SENDING: recovery pauses it too, and retry must commit first.
        try { persist(entries); } catch (RuntimeException failure) { entry.error += "；本地状态暂未保存，请释放存储空间后重试"; }
        return true;
    }
    synchronized boolean fail(Entry entry, String error, long attempt) {
        return entry.attempt == attempt && fail(entry, error);
    }
    synchronized boolean retry(Entry entry, String token, int userId, String endpoint) {
        if (entries.get(entry.requestId) != entry || entry.phase != Phase.FAILED || !entry.account(token, userId, endpoint)) return false;
        String previous = entry.error; entry.phase = Phase.QUEUED; entry.error = "";
        try { persist(entries); } catch (RuntimeException failure) { entry.phase = Phase.FAILED; entry.error = previous; throw failure; } return true;
    }
    synchronized Entry acknowledge(String requestId, String token, int userId, String endpoint, int conversationId) {
        Entry entry = entries.get(requestId);
        if (entry == null || !entry.account(token, userId, endpoint) || entry.conversationId != conversationId) return null;
        LinkedHashMap<String, Entry> next = new LinkedHashMap<>(entries); next.remove(requestId); persist(next);
        entries.remove(requestId); return entry;
    }
    synchronized boolean discard(Entry entry, String token, int userId, String endpoint) {
        if (entries.get(entry.requestId) != entry || entry.phase != Phase.FAILED || !entry.account(token, userId, endpoint)) return false;
        LinkedHashMap<String, Entry> next = new LinkedHashMap<>(entries); next.remove(entry.requestId); persist(next);
        entries.remove(entry.requestId); return true;
    }
    /** Account navigation detaches memory; explicit discard/ack or account removal deletes disk data. */
    synchronized void clear() { entries.clear(); storage = null; boundToken = null; boundEndpoint = null; boundUserId = 0; }

    private static byte[] encode(LinkedHashMap<String, Entry> value) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
            out.writeInt(1); out.writeInt(value.size());
            for (Entry entry : value.values()) {
                out.writeUTF(entry.requestId); out.writeUTF(entry.endpoint); out.writeInt(entry.userId); out.writeInt(entry.conversationId);
                OutboxCodec.writeString(out, entry.text); out.writeInt(entry.replyToId); out.writeInt(entry.mentionUserIds.length);
                for (int mention : entry.mentionUserIds) out.writeInt(mention);
                out.writeUTF(entry.phase.name()); OutboxCodec.writeString(out, entry.error);
            }
            out.flush(); return bytes.toByteArray();
        } catch (IOException failure) { throw new IllegalStateException("无法保存待发文字", failure); }
    }
    private static LinkedHashMap<String, Entry> decode(byte[] snapshot, String token, int userId, String endpoint) {
        LinkedHashMap<String, Entry> result = new LinkedHashMap<>(); if (snapshot == null) return result;
        try {
            DataInputStream in = new DataInputStream(new ByteArrayInputStream(snapshot));
            if (in.readInt() != 1) throw new IOException("Unsupported outbox version");
            int count = in.readInt(); if (count < 0 || count > 10000) throw new IOException("Invalid outbox count");
            for (int i = 0; i < count; i++) {
                String id = in.readUTF(), savedEndpoint = in.readUTF(); int savedUser = in.readInt(), cid = in.readInt();
                String text = OutboxCodec.readString(in); int reply = in.readInt(), mentionCount = in.readInt();
                if (!OutboxCodec.sameEndpoint(savedEndpoint, endpoint) || savedUser != userId || id.isEmpty() || cid <= 0 || text.trim().isEmpty() || mentionCount < 0 || mentionCount > 100) throw new IOException("Invalid outbox owner/message");
                int[] mentions = new int[mentionCount]; for (int n = 0; n < mentionCount; n++) { mentions[n] = in.readInt(); if (mentions[n] <= 0 || mentions[n] == userId) throw new IOException("Invalid mention"); }
                Phase previous = Phase.valueOf(in.readUTF()); String error = OutboxCodec.readString(in);
                Entry entry = new Entry(id, token, userId, endpoint, cid, text, reply, mentions);
                entry.phase = Phase.FAILED; entry.error = previous == Phase.FAILED && !error.isEmpty() ? error : "已恢复待发文字，请确认后重试";
                if (result.put(id, entry) != null) throw new IOException("Duplicate outbox request");
            }
            if (in.available() != 0) throw new IOException("Trailing outbox data"); return result;
        } catch (IOException | IllegalArgumentException failure) { throw new IllegalStateException("无法读取待发文字，请保留本地数据后重试", failure); }
    }
}

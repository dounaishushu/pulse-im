package com.pulseim.android;

import java.util.Map;
import java.util.regex.Pattern;

/** Converts trusted transport fields to local UI handles without changing wire identities. */
final class PushMessagePolicy {
    private static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    interface Identifiers {
        String user(int localUser);
        int conversation(String wireId);
    }
    static final class Message {
        final int userId, conversationId, messageId, senderId;
        final String type, body;
        final boolean muted;
        Message(int userId, int conversationId, int messageId, int senderId, String type, String body, boolean muted) {
            this.userId = userId; this.conversationId = conversationId; this.messageId = messageId;
            this.senderId = senderId; this.type = type; this.body = body; this.muted = muted;
        }
    }
    static Message decode(Map<String, String> data, boolean goBackend, int activeUser, Identifiers ids) {
        if (data == null || activeUser <= 0) return null;
        String type = data.get("conversation_type");
        if (type == null || type.isEmpty()) type = "direct";
        if (!type.equals("direct") && !type.equals("group") && !type.equals("channel")) return null;
        int conversation, message, sender;
        if (goBackend) {
            String owner = data.get("user_id"), wireConversation = data.get("conversation_id"), wireMessage = data.get("message_id");
            message = positive(data.get("seq"));
            if (!uuid(owner) || !uuid(wireConversation) || !uuid(wireMessage) || message <= 0) return null;
            if (!owner.equals(ids.user(activeUser))) return null;
            conversation = ids.conversation(wireConversation);
            if (conversation <= 0) return null;
            // MessageAlerts and WebSocket delivery share the per-conversation sequence key.
            // The push has no message version, so it must not create authoritative message rows.
            sender = 0;
        } else {
            if (positive(data.get("user_id")) != activeUser) return null;
            conversation = positive(data.get("conversation_id"));
            if (conversation <= 0) return null;
            message = positive(data.get("message_id")); sender = positive(data.get("sender_id"));
        }
        String body = data.get("body");
        if (body == null || body.trim().isEmpty()) body = "收到一条新消息";
        if (body.length() > 512) body = body.substring(0, 512);
        return new Message(activeUser, conversation, message, sender, type, body, "true".equals(data.get("notifications_muted")));
    }
    private static boolean uuid(String value) { return value != null && UUID.matcher(value).matches(); }
    private static int positive(String value) {
        if (value == null || value.length() > 10 || !value.matches("[1-9][0-9]*")) return 0;
        try { return Integer.parseInt(value); } catch (NumberFormatException error) { return 0; }
    }
    private PushMessagePolicy() {}
}

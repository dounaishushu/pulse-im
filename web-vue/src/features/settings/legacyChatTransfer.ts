import "../../../../pc/web/chat-transfer.js";
import type { Client } from "../../api/client";
import type { TextPayload } from "../chat/useOutbox";
import type { ComposerDraftText } from "../chat/ComposerEditor.vue";

declare global {
  interface Window {
    PulseChatTransfer: { open(text: string, passphrase: string): Promise<unknown> };
  }
}

const maxFileSize = 12 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function isTextRequestId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("text-") && uuid.test(value.slice(5));
}
const invalid = "聊天备份中有无法恢复的记录。";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(invalid);
  return value as Record<string, unknown>;
}

function wireId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw Error(invalid);
  return value.toLowerCase();
}

function messageText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw Error(invalid);
  return value;
}

function cursor(value: unknown, text: string) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(0, Math.min(text.length, value)) : text.length;
}

export const recoveredDraftKey = (user: number, conversation: number) => `pulse_vue_draft:${user}:${conversation}`;

export async function readChatTransfer(file: File, passphrase: string, client: Client, user: string, current: () => boolean) {
  if (file.size === 0 || file.size > maxFileSize) throw Error("请选择 12 MB 以内的聊天备份。");
  const backup = record(await window.PulseChatTransfer.open(await file.text(), passphrase));
  if (!current()) throw Error("账号或窗口状态已变化，请重新选择备份。");
  if (backup.base !== client.base || backup.user !== user) throw Error("此备份属于其他账号或服务器。");
  if (!Array.isArray(backup.pending) || backup.pending.length > 1000 || !Array.isArray(backup.drafts) || backup.drafts.length > 100) {
    throw Error(invalid);
  }
  const pending = backup.pending.map((value): TextPayload => {
    const item = record(value);
    if (!isTextRequestId(item.requestId) ||
      !Array.isArray(item.mentions) || item.mentions.length > 500 || typeof item.mentionAll !== "boolean") throw Error(invalid);
    const text = messageText(item.text, 20000);
    const conversation = wireId(item.conversation);
    const mentions = item.mentions.map(wireId);
    const reply = item.reply;
    if (reply !== undefined && (typeof reply !== "number" || !Number.isSafeInteger(reply) || reply <= 0)) throw Error(invalid);
    return {
      conversation_id: client.local("conversation", conversation),
      type: "text",
      request_id: item.requestId,
      body: { text, reply_to_id: reply as number | undefined, mention_user_ids: mentions.map(id => client.local("user", id)), mention_all: item.mentionAll },
    };
  });
  const drafts = backup.drafts.map((value): [number, ComposerDraftText] => {
    const item = record(value);
    if (typeof item.text !== "string" || !item.text.length || item.text.length > 100_000) throw Error(invalid);
    const text = item.text;
    const start = cursor(item.start, text);
    const end = Math.max(start, cursor(item.end, text));
    const direction = item.direction === "forward" || item.direction === "backward" ? item.direction : "none";
    return [client.local("conversation", wireId(item.conversation)), { text, start, end, direction }];
  });
  return { pending, drafts };
}

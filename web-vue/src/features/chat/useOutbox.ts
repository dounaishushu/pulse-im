import { onScopeDispose, shallowRef, watch } from "vue";
import "../../../../client-shared/text-outbox.js";
import "../../../../web/pending-text-store.js";
import type { Chat } from "../../composables/useChat";
import type { Message, MessageBody } from "../../api/types";
import { client } from "../../api/client";
interface Account {
  token: string;
  userId: number;
}
interface Payload {
  conversation_id: number;
  type: "text";
  body: MessageBody;
  request_id: string;
}
export interface PendingText {
  id: string;
  payload: Payload;
  status: string;
  error: string;
  account: Account;
}
interface Outbox {
  enqueue(account: Account, payload: Payload): PendingText;
  pending(account: Account, conversationId?: number): PendingText[];
  restore(account: Account): Promise<void>;
  retry(id: string, account: Account): void;
  discard(id: string, account: Account): void;
  resume(account: Account): void;
  dispose(): Promise<void>;
  confirm(account: Account, message: Message): boolean;
}
declare global {
  interface Window {
    PulsePendingTextStore: { create(options: { base: string }): unknown };
    PulseTextOutbox: {
      create(options: {
        send(item: PendingText, signal: AbortSignal): Promise<Message>;
        allowed(account: Account): boolean;
        changed(): void;
        accepted(item: PendingText, message: Message): void;
        store: unknown;
        storageError(error: unknown): void;
        concurrency: number;
      }): Outbox;
    };
  }
}
export function useOutbox(chat: Chat) {
  const pending = shallowRef<PendingText[]>([]);
  const account = () => ({
    token: client.token,
    userId: chat.me.value?.id || 0,
  });
  const update = () => {
    if (chat.me.value)
      pending.value = outbox.pending(account(), chat.active.value?.id);
  };
  const outbox = window.PulseTextOutbox.create({
    store: window.PulsePendingTextStore.create({ base: client.base }),
    concurrency: 2,
    send: (item, signal) =>
      chat.api<Message>("/messages", {
        method: "POST",
        body: item.payload,
        signal,
      }),
    allowed: (who) =>
      client.token === who.token &&
      chat.me.value?.id === who.userId &&
      !chat.locked.value,
    changed: update,
    accepted(item, message) {
      if (chat.active.value?.id === item.payload.conversation_id)
        chat.mergeMessages([message]);
      void chat.summary([item.payload.conversation_id]);
    },
    storageError: chat.error,
  });
  watch(
    [chat.me, chat.active],
    () => {
      if (chat.me.value) {
        void outbox.restore(account()).then(update);
        update();
      }
    },
    { immediate: true },
  );
  watch(chat.messages, (rows) => {
    if (chat.me.value) for (const row of rows) outbox.confirm(account(), row);
  });
  onScopeDispose(() => {
    void outbox.dispose();
  });
  return {
    pending,
    send: (payload: Payload) => outbox.enqueue(account(), payload),
    retry: (id: string) => outbox.retry(id, account()),
    discard: (id: string) => outbox.discard(id, account()),
    resume: () => outbox.resume(account()),
  };
}

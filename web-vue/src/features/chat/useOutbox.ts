import { onScopeDispose, shallowRef, watch, type InjectionKey, type ShallowRef } from "vue";
import platform from "virtual:pulse-platform";
import type { ChatOutboxRequest, ChatOutboxSnapshot } from "../../platform/contracts";
import "../../../../client-shared/text-outbox.js";
import "../../../../web/pending-text-store.js";
import type { Chat } from "../../composables/useChat";
import type { Message, MessageBody } from "../../api/types";

interface Account {
  token: string;
  userId: number;
}
export interface TextPayload {
  conversation_id: number;
  type: "text";
  body: MessageBody;
  request_id: string;
}
export interface PendingText {
  id: string;
  payload: TextPayload;
  status: string;
  error: string;
  account: Account;
}
interface Outbox {
  enqueue(account: Account, payload: TextPayload): PendingText;
  pending(account: Account, conversationId?: number): PendingText[];
  restore(account: Account): Promise<void>;
  retry(id: string, account: Account): void;
  discard(id: string, account: Account): void;
  resume(account: Account): void;
  pause(account: Account): void;
  importForReview(account: Account, payloads: TextPayload[]): Promise<number>;
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
type VisiblePending = Pick<PendingText, "id" | "status" | "error"> & {
  payload: Pick<TextPayload, "conversation_id" | "body">;
};
export interface TextOutbox {
  pending: ShallowRef<VisiblePending[]>;
  send(payload: TextPayload): void | Promise<void>;
  retry(id: string): void;
  discard(id: string): void;
  resume(): void;
  importForReview?(payloads: TextPayload[]): Promise<number>;
}

export function useOutbox(chat: Chat): TextOutbox {
  const client = chat.client;
  const pending = shallowRef<VisiblePending[]>([]);
  const windows = platform.chatWindows;
  const watching = new Map<number, string>();
  const acceptedRequests = new Set<string>();
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let publishQueued = false;
  let version = 0;
  const account = () => ({
    token: client.token,
    userId: chat.me.value?.id || 0,
  });
  const update = () => {
    if (chat.me.value)
      pending.value = outbox.pending(account(), chat.active.value?.id);
    if (!windows || !watching.size || publishQueued) return;
    publishQueued = true;
    queueMicrotask(() => {
      publishQueued = false;
      if (disposed) return;
      for (const [id, conversation] of watching) {
        void windows.publishOutbox(client.token, conversation, snapshot(id)).then((open) => {
          if (!open && watching.get(id) === conversation) watching.delete(id);
        }).catch(() => {});
      }
    });
  };
  const outbox = window.PulseTextOutbox.create({
    store: window.PulsePendingTextStore.create({ base: client.base }),
    concurrency: 2,
    send: (item, signal) =>
      chat.api<Message>("/messages", {
        method: "POST",
        body: item.payload,
        // The durable queue controls retry timing and releases the slot during backoff.
        retryWrites: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      }),
    allowed: (who) =>
      client.token === who.token &&
      chat.me.value?.id === who.userId &&
      !chat.locked.value && !chat.updateSuspended.value,
    changed: update,
    accepted(item, message) {
      if (chat.active.value?.id === item.payload.conversation_id)
        chat.mergeMessages([message]);
      void chat.summary([item.payload.conversation_id]);
    },
    storageError: chat.error,
  });
  function snapshot(conversationId: number): ChatOutboxSnapshot {
    return {
      version: ++version,
      items: outbox.pending(account(), conversationId).map(({ id, status, error, payload }) => ({
        id, status, error, text: (payload.body.text || "").slice(0, 160),
      })),
    };
  }
  function receive({ request, user, conversation, action }: ChatOutboxRequest) {
    const owner = account();
    if (!windows || disposed || !owner.token || !owner.userId || client.wire("user", owner.userId) !== user) return;
    if (chat.locked.value) {
      void windows.replyOutbox(owner.token, request, undefined, "当前账号已锁定。").catch(() => {});
      return;
    }
    try {
      const id = client.local("conversation", conversation);
      watching.set(id, conversation);
      if (action.type === "send" && !acceptedRequests.has(action.requestId)) {
        outbox.enqueue(owner, { conversation_id: id, type: "text", body: action.body, request_id: action.requestId });
        acceptedRequests.add(action.requestId);
        if (acceptedRequests.size > 2048) acceptedRequests.delete(acceptedRequests.values().next().value!);
      }
      if (action.type === "retry" || action.type === "discard") {
        if (outbox.pending(owner, id).some((item) => item.id === action.id)) outbox[action.type](action.id, owner);
      }
      void windows.replyOutbox(owner.token, request, snapshot(id)).catch(() => {});
    } catch (cause) {
      void windows.replyOutbox(owner.token, request, undefined, cause instanceof Error ? cause.message : "消息无法加入队列。").catch(() => {});
    }
  }
  if (windows) void windows.onOutboxRequest(receive).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch(() => {});
  watch(chat.me, (profile, previous) => {
    if (profile && profile.id !== previous?.id) void outbox.restore(account()).then(update);
  }, { immediate: true });
  watch(() => chat.active.value?.id, update);
  watch([chat.locked, chat.updateSuspended], ([locked, updating], [wasLocked, wasUpdating]) => {
    if (!chat.me.value || (locked || updating) === (wasLocked || wasUpdating)) return;
    if (locked || updating) outbox.pause(account());
    else outbox.resume(account());
  }, { flush: "sync" });
  watch(chat.messages, (rows) => {
    if (chat.me.value) for (const row of rows) outbox.confirm(account(), row);
  });
  onScopeDispose(() => {
    disposed = true;
    unlisten?.();
    void outbox.dispose();
  });
  return {
    pending,
    send: (payload) => { outbox.enqueue(account(), payload); },
    retry: (id: string) => outbox.retry(id, account()),
    discard: (id: string) => outbox.discard(id, account()),
    resume: () => outbox.resume(account()),
    importForReview: (payloads) => outbox.importForReview(account(), payloads),
  };
}

export const outboxKey: InjectionKey<TextOutbox> = Symbol("account-outbox");

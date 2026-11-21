import { onScopeDispose, shallowRef } from "vue";
import type { DesktopChatWindows, ChatOutboxAction, ChatOutboxSnapshot } from "../../platform/contracts";
import type { Chat } from "../../composables/useChat";
import type { TextOutbox, TextPayload } from "../chat/useOutbox";

export function useConversationOutbox(chat: Chat, windows: DesktopChatWindows, conversationId: number): TextOutbox {
  const pending: TextOutbox["pending"] = shallowRef([]);
  let version = 0;
  let disposed = false;
  let stop: (() => void) | undefined;
  let uncertain: { key: string; id: string } | undefined;
  function apply(snapshot: ChatOutboxSnapshot) {
    if (disposed || snapshot.version <= version) return;
    version = snapshot.version;
    pending.value = snapshot.items.map(({id, status, error, text}) => ({
      id, status, error, payload: { conversation_id: conversationId, body: { text } },
    }));
  }
  const action = (request: ChatOutboxAction) => windows.outbox(request).then(apply);
  const failure = (cause: unknown) => {
    if (!disposed) chat.error(typeof cause === "string" ? Error(cause) : cause);
  };
  const listening = windows.onOutboxStatus(apply).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  });
  void listening.then(() => disposed ? undefined : action({ type: "list" })).catch(failure);

  async function send(payload: TextPayload) {
    const key = JSON.stringify(payload.body);
    const id = uncertain?.key === key ? uncertain.id : payload.request_id;
    uncertain = { key, id };
    try {
      await action({ type: "send", requestId: id, body: payload.body });
      if (uncertain?.id === id) uncertain = undefined;
    } catch (cause) {
      throw typeof cause === "string" ? Error(cause) : cause;
    }
  }
  onScopeDispose(() => {
    disposed = true;
    stop?.();
  });
  return {
    pending, send,
    retry: (id) => { void action({ type: "retry", id }).catch(failure); },
    discard: (id) => { void action({ type: "discard", id }).catch(failure); },
    resume: () => { void action({ type: "list" }).catch(failure); },
  };
}

import platform from "virtual:pulse-platform";
import { computed, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { usePreferences } from "./usePreferences";
import type { Conversation, Profile, Message } from "../api/types";
export function useNotifications(
  conversations: Ref<Conversation[]>,
  me: Ref<Profile | null>,
  locked: Ref<boolean>,
  choose: (id: number, reply?: boolean) => void,
  foreground: Ref<boolean>,
  preview: (message: Message) => string,
  enable = true,
) {
  const preferences = usePreferences(),
    notificationUnread = shallowRef(0);
  const totalUnread = computed(() =>
    conversations.value.reduce((sum, row) => {
      if (row.is_hidden || row.notifications_muted) return sum;
      return (
        sum +
        (preferences.setting("unread_message_count")
          ? row.unread_count || 0
          : Number((row.unread_count || 0) > 0))
      );
    }, 0),
  );
  if (!enable) return { totalUnread, notificationUnread };
  const previous = new Map<number, number>(),
    delivered = new Set<string>(),
    displayed = new Set<Notification>();
  const native = platform.notifications;
  let scope = native ? crypto.randomUUID() : "";
  let live = true;
  let stopListening: (() => void) | undefined;
  let seeded = false;
  if (native) {
    void native.subscribe((event) => {
      if (live && !locked.value && event.scope === scope) choose(event.conversationId, event.reply);
    }).then((unlisten) => {
      if (live) stopListening = unlisten;
      else unlisten();
    }).catch(() => {});
    watch(locked, (value) => {
      if (!value) return;
      const previousScope = scope;
      scope = crypto.randomUUID();
      void native.clear(previousScope).catch(() => {});
    }, { flush: "sync" });
  }
  watch(conversations, (rows) => {
    for (const row of rows) {
      const latest = row.last_message,
        old = previous.get(row.id) || 0;
      previous.set(row.id, Math.max(old, latest?.id || 0));
      if (
        !seeded ||
        !latest ||
        latest.id <= old ||
        latest.sender_id === me.value?.id ||
        latest.status === "recalled" ||
        !row.unread_count ||
        row.notifications_muted ||
        locked.value ||
        ((!document.hidden && (!native || document.hasFocus())) && foreground.value) ||
        !preferences.setting("notify_enabled")
      )
        continue;
      const key = row.id + ":" + latest.id;
      if (delivered.has(key)) continue;
      delivered.add(key);
      if (delivered.size > 1000)
        delivered.delete(delivered.values().next().value!);
      const title = preferences.setting("notify_sender")
        ? latest.sender_name || row.name
        : "小猿答疑";
      const body = preferences.setting("notify_preview")
        ? preview(latest)
        : "你收到一条新消息";
      const silent = !preferences.setting("notify_sound");
      const count = Number(localStorage.getItem("pulse_notification_count"));
      const limit = Number.isInteger(count) && count >= 1 && count <= 5 ? count : 3;
      if (native) {
        void native.show({ scope, title, body, silent, limit, conversationId: row.id }).catch(() => {});
        continue;
      }
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const notification = new Notification(title, {
            body, tag: "pulse-account-" + me.value?.id + "-chat-" + row.id, silent,
          });
          displayed.add(notification);
          notification.onclose = () => displayed.delete(notification);
          while (displayed.size > limit) {
            const first = displayed.values().next().value!;
            displayed.delete(first);
            first.close();
          }
          notification.onclick = () => {
            window.focus();
            notification.close();
            void choose(row.id);
          };
        } catch {
          /* Browser notification restrictions must not interrupt synchronization. */
        }
      }
    }
    seeded = true;
  });
  onScopeDispose(() => {
    live = false;
    stopListening?.();
    if (native) void native.clear(scope).catch(() => {});
    for (const notification of displayed) notification.close();
  });
  return { totalUnread, notificationUnread };
}

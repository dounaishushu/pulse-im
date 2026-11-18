import { computed, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { usePreferences } from "./usePreferences";
import type { Conversation, Profile } from "../api/types";
import { textOf } from "../api/types";
export function useNotifications(
  conversations: Ref<Conversation[]>,
  me: Ref<Profile | null>,
  locked: Ref<boolean>,
  choose: (id: number) => Promise<void>,
) {
  const preferences = usePreferences(),
    notificationUnread = shallowRef(0);
  const totalUnread = computed(() =>
    conversations.value.reduce((sum, row) => {
      if (
        row.is_hidden ||
        (row.notifications_muted &&
          !preferences.setting("unread_include_muted"))
      )
        return sum;
      return (
        sum +
        (preferences.setting("unread_message_count")
          ? row.unread_count || 0
          : Number((row.unread_count || 0) > 0))
      );
    }, 0),
  );
  const previous = new Map<number, number>(),
    delivered = new Set<string>(),
    displayed = new Set<Notification>();
  let seeded = false;
  watch(
    totalUnread,
    (count) => {
      document.title = (count ? "(" + count + ") " : "") + "小猿答疑";
    },
    { immediate: true },
  );
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
        !document.hidden ||
        !preferences.setting("notify_enabled")
      )
        continue;
      const key = row.id + ":" + latest.id;
      if (delivered.has(key)) continue;
      delivered.add(key);
      if (delivered.size > 1000)
        delivered.delete(delivered.values().next().value!);
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const notification = new Notification(
            preferences.setting("notify_sender")
              ? latest.sender_name || row.name
              : "小猿答疑",
            {
              body: preferences.setting("notify_preview")
                ? textOf(latest)
                : "你收到一条新消息",
              tag: "pulse-chat-" + row.id,
              silent: !preferences.setting("notify_sound"),
            },
          );
          displayed.add(notification);
          notification.onclose = () => displayed.delete(notification);
          const limit = Math.max(
            1,
            Math.min(
              5,
              Number(localStorage.getItem("pulse_notification_count") || 3),
            ),
          );
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
    for (const notification of displayed) notification.close();
    document.title = "小猿答疑";
  });
  return { totalUnread, notificationUnread };
}

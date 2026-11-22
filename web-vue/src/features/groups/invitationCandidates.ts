import type { Conversation, Profile } from "../../api/types";

// Keep the server's sub-millisecond order. Reading a conversation or editing its
// metadata must never move it ahead of a more recent private message.
function activity(time?: string): bigint {
  if (!time) return 0n;
  const milliseconds = Date.parse(time);
  if (!Number.isFinite(milliseconds)) return 0n;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i.exec(time)?.[1] || "";
  return BigInt(Math.floor(milliseconds / 1000)) * 1_000_000_000n +
    BigInt(fraction.slice(0, 9).padEnd(9, "0"));
}

export function invitationSections(people: Profile[], conversations: Conversation[], self?: number) {
  const direct = new Map<number, { pinned: boolean; time: bigint }>();
  for (const row of conversations) {
    if (row.type !== "direct" || !row.peer_user_id) continue;
    const previous = direct.get(row.peer_user_id);
    const time = activity(row.last_message?.created_at);
    direct.set(row.peer_user_id, {
      pinned: row.is_pinned === true || previous?.pinned === true,
      time: previous && previous.time > time ? previous.time : time,
    });
  }
  const unique = new Map(people.filter(row => row.id !== self).map(row => [row.id, row]));
  const ordered = [...unique.values()].map(person => ({
    person,
    // Fresh candidate metadata is authoritative, including an explicit unpin.
    // Older servers fall back to the user's private-conversation directory.
    pinned: typeof person.is_pinned === "boolean" ? person.is_pinned : direct.get(person.id)?.pinned === true,
    time: person.last_activity !== undefined ? activity(person.last_activity) : direct.get(person.id)?.time ?? 0n,
  })).sort((a, b) => a.time === b.time ? a.person.id - b.person.id : a.time > b.time ? -1 : 1);
  return [
    { kind: "pinned" as const, name: "置顶用户列表", items: ordered.filter(row => row.pinned).map(row => row.person) },
    { kind: "recent" as const, name: "最新消息用户列表", items: ordered.filter(row => !row.pinned).map(row => row.person) },
  ];
}

export function filterInvitees(people: Profile[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  return people.filter(row => [row.nickname, row.remark, row.username, row.public_id]
    .join(" ").toLocaleLowerCase().includes(term));
}

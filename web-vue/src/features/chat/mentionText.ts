import { textOf, type Message, type MessageBody, type Reply } from "../../api/types";

// Render from immutable target IDs and the current account's name resolver.
// Never replace unrelated @ text or write private display names back to a message.
export function mentionText(
  body: MessageBody | Reply,
  name: (id: number, fallback: string) => string,
): string {
  const text = body.text || "";
  if (!text || !body.mention_users?.length || !body.mention_user_ids?.length)
    return text;
  const targets = new Set(body.mention_user_ids);
  const labels = new Map<string, Map<number, string>>();
  for (const user of body.mention_users) {
    if (!targets.has(user.user_id)) continue;
    const display = name(user.user_id, user.nickname || "会话成员");
    for (const label of user.labels) {
      if (!label) continue;
      if (!labels.has(label)) labels.set(label, new Map());
      labels.get(label)!.set(user.user_id, display);
    }
  }
  if (!labels.size) return text;
  const choices = [...labels.keys()]
    .sort((a, b) => b.length - a.length)
    .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(
    new RegExp("(^|\\s)@(" + choices.join("|") + ")(?=\\s|$)", "gu"),
    (_match, space: string, label: string) =>
      space + [...labels.get(label)!.values()].map(value => "@" + value).join(" "),
  );
}

// One preview path for notifications, search and message summaries. Keep media
// placeholders and recall handling consistent with the normal message renderer.
export function mentionPreview(
  message: Message | null | undefined,
  name: (id: number, fallback: string) => string,
): string {
  return !message || message.status === "recalled" || !message.body.text
    ? textOf(message) : mentionText(message.body, name);
}

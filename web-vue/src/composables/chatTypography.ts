import platform from "virtual:pulse-platform";
import type { ChatTypography, TypographyState } from "../platform/contracts";

export const defaultChatTypography: ChatTypography = { size: 14, family: "yahei", bold: false };

export const chatFonts = {
  yahei: { label: "微软雅黑", css: '"Microsoft YaHei", "Microsoft YaHei UI", "Segoe UI", sans-serif' },
  song: { label: "宋体", css: 'SimSun, "Songti SC", serif' },
  hei: { label: "黑体", css: 'SimHei, "Heiti SC", sans-serif' },
  kai: { label: "楷体", css: 'KaiTi, STKaiti, serif' },
  system: { label: "系统默认", css: 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif' },
} as const;

export function chatTypographyStyle(value: ChatTypography) {
  return {
    fontFamily: chatFonts[value.family].css,
    fontSize: `${value.size}px`,
    fontWeight: value.bold ? 700 : 400,
    lineHeight: `${Math.round(value.size * 22 / 14)}px`,
  };
}

export function applyChatTypography(value: ChatTypography) {
  const { fontSize, fontFamily, fontWeight, lineHeight } = chatTypographyStyle(value);
  const root = document.documentElement.style;
  root.setProperty("--chat-font-size", fontSize);
  root.setProperty("--chat-font-family", fontFamily);
  root.setProperty("--chat-font-weight", String(fontWeight));
  root.setProperty("--chat-line-height", lineHeight);
}

export async function bindDesktopChatTypography() {
  const native = platform.chatTypography;
  if (!native) return;
  let revision = -1;
  const apply = (snapshot: TypographyState) => {
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    applyChatTypography(snapshot.value);
  };
  try {
    // Subscribe before reading so creating a window and editing another cannot leave a stale style.
    await native.subscribe(apply);
    apply(await native.read());
  } catch {
    // Chat stays available with its default type settings.
  }
}

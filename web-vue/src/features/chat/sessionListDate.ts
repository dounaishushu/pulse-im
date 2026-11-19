// Adapted from Linyu's formatSessionListDate (Apache-2.0); see web-vue/THIRD_PARTY_NOTICES.md.
const days = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
];
const pad = (value: number) => String(value).padStart(2, "0");
const utcDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());

export function sessionListDate(value?: string, now = new Date()) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1970) return "";
  const elapsed = (utcDay(now) - utcDay(date)) / 86400000;
  if (elapsed === 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (elapsed > 0 && elapsed <= 6) return days[date.getDay()];
  const short = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? short
    : `${date.getFullYear()}/${short}`;
}

import type { LegacyDownloadPreferences } from "../../platform/contracts";

const MAX_BACKUP_SIZE = 4 * 1024 * 1024;
const THEMES = new Set(["classic", "day", "color", "night"]);
const LIGHT_THEMES = new Set(["classic", "day", "color"]);
const SCALES = new Set(["1", "1.25", "1.5", "2", "2.5", "3"]);
const COUNTS = new Set(["1", "2", "3", "4", "5"]);
const LANGUAGES = new Set(["zh-CN", "zh-TW", "en", "ko", "id", "th", "fr", "de"]);
const SWITCHES = new Set(["0", "1"]);
const MEDIA_LIMITS = new Set(["1", "5", "10", "50", "100", "200", "500"]);
export const MEDIA_SCOPES = ["private", "group", "channel"] as const;
export const MEDIA_CATEGORIES = ["photos", "videos", "files"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the `settings` object emitted by the old desktop export. */
export async function readLegacyPreferences(file: File, supportedSwitches: string[]) {
  if (!file.size || file.size > MAX_BACKUP_SIZE) throw Error("请选择 4 MB 以内的设置备份。");
  let backup: unknown;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    throw Error("无法读取此文件，请选择旧版导出的 JSON 设置备份。");
  }
  if (!isRecord(backup) || !isRecord(backup.settings)) throw Error("此文件没有设置备份数据。");

  const settings = backup.settings;
  const result = new Map<string, string>();
  function copy(key: string, choices: ReadonlySet<string>) {
    const value = settings[key];
    if (Object.hasOwn(settings, key) && typeof value === "string" && choices.has(value)) {
      result.set(key, value);
    }
  }
  copy("pulse_chat_theme", THEMES);
  copy("pulse_chat_light_theme", LIGHT_THEMES);
  copy("pulse_interface_scale", SCALES);
  copy("pulse_notification_count", COUNTS);
  copy("pulse_language", LANGUAGES);
  copy("pulse_auto_translate", SWITCHES);
  function copyInteger(key: string, min: number, max: number) {
    const value = settings[key];
    if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return;
    const number = Number(value);
    if (number >= min && number <= max) result.set(key, String(number));
  }
  copyInteger("pulse_sidebar_width", 170, 500);
  copyInteger("pulse_input_volume", 0, 100);
  copyInteger("pulse_output_volume", 0, 100);
  for (const scope of MEDIA_SCOPES) {
    copy(`pulse_media_download_${scope}_max_mb`, MEDIA_LIMITS);
    const fallback = settings[`pulse_setting_auto_download_${scope}`];
    for (const category of MEDIA_CATEGORIES) {
      const key = `pulse_setting_media_download_${scope}_${category}`;
      copy(key, SWITCHES);
      if (!result.has(key) && typeof fallback === "string" && SWITCHES.has(fallback)) {
        result.set(key, fallback);
      }
    }
  }
  if (!result.has("pulse_chat_theme") && settings.pulse_night_mode === "1") {
    result.set("pulse_chat_theme", "night");
  }
  for (const key of supportedSwitches) {
    const target = "pulse_setting_" + key;
    copy(target, SWITCHES);
    if (/^notify_(enabled|sender|preview|sound)$/.test(key) && !result.has(target)) {
      const legacy = key.replace(/^notify_/, "pulse_setting_notification_");
      copy(legacy, SWITCHES);
      const value = result.get(legacy);
      if (value !== undefined) {
        result.delete(legacy);
        result.set(target, value);
      }
    }
  }
  const download: LegacyDownloadPreferences = {};
  const directory = settings.pulse_download_directory;
  if (typeof directory === "string" && directory.length <= 1024 && /^[a-z]:[\\/].+/i.test(directory) && !/[\u0000-\u001f]/.test(directory)) {
    download.directory = directory;
  }
  const ask = settings.pulse_setting_download_ask;
  if (ask === "0" || ask === "1") download.askBeforeDownload = ask === "1";
  return { values: result, download: Object.keys(download).length ? download : undefined };
}

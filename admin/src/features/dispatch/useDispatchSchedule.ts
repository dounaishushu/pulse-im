import { shallowRef, watch, type Ref } from "vue";
import { post } from "../../api/client";
import type { RecordData } from "../../domain/types";

export function dispatchCronError(value: unknown): string {
  const expression = String(value ?? "").trim();
  if (!expression) return "请填写 Cron 表达式";
  return [5, 6].includes(expression.split(/\s+/).length)
    ? ""
    : "请填写 6 字段 Cron（秒 分 时 日 月 周），也兼容 5 字段";
}

export function formatBeijingTime(value: string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "待设置";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => parts.find((part) => part.type === key)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function useDispatchSchedule(
  draft: Ref<RecordData>,
  open: () => boolean,
  readonly: () => boolean,
) {
  const times = shallowRef<string[]>([]),
    error = shallowRef(""),
    loading = shallowRef(false);
  watch(
    () => ({
      open: open(),
      type: draft.value.trigger_type,
      at: draft.value.execute_at,
      cron: draft.value.cron_expression,
      next: readonly() ? draft.value.next_run : null,
      delays: (draft.value.steps || []).map(
        (step: RecordData) => step.delay_seconds,
      ),
    }),
    (value, _old, cleanup) => {
      times.value = [];
      error.value = "";
      loading.value = false;
      if (!value.open || !value.delays.length) return;
      if (
        value.delays.some(
          (delay: number) =>
            !Number.isInteger(delay) || delay < 0 || delay > 86400,
        )
      ) {
        error.value = "请检查步骤延迟，须为 0—86400 的整数秒";
        return;
      }
      if (value.type === "once" || value.next) {
        let due = Date.parse(value.next || value.at + "+08:00");
        if (!Number.isFinite(due)) {
          error.value = "请选择执行日期和时间";
          return;
        }
        times.value = value.delays.map((delay: number) =>
          formatBeijingTime((due += delay * 1000)),
        );
        return;
      }
      const cronError = dispatchCronError(value.cron);
      if (cronError) {
        error.value = cronError;
        return;
      }
      const controller = new AbortController();
      let active = true;
      loading.value = true;
      const timer = setTimeout(async () => {
        try {
          const result = await post(
            "/admin/dispatch-tasks/preview",
            { cron: value.cron.trim(), delays_seconds: value.delays },
            controller.signal,
          );
          if (active) times.value = result.steps.map(formatBeijingTime);
        } catch (e: any) {
          if (active && e.name !== "AbortError") error.value = e.message;
        } finally {
          if (active) loading.value = false;
        }
      }, 250);
      cleanup(() => {
        active = false;
        clearTimeout(timer);
        controller.abort();
      });
    },
    { immediate: true },
  );
  return { times, error, loading };
}

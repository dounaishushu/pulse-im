export type ContactMetadata = { remark: string; group_name: string };
export type ContactSaveState = {
  phase: "idle" | "waiting" | "saving" | "saved" | "error";
  draft: ContactMetadata;
  dirty: boolean;
  error?: unknown;
};

// Each editor owns one contact/account. Never replace a newer draft with an
// older acknowledgement, or overwrite the other metadata field unintentionally.
export function createContactAutosave(options: {
  initial: ContactMetadata;
  write(patch: Partial<ContactMetadata>): Promise<ContactMetadata>;
  changed(state: ContactSaveState): void;
  saved?(metadata: ContactMetadata, pending: boolean): void;
  delay?: number;
}) {
  let acknowledged = { ...options.initial }, draft = { ...options.initial };
  let phase: ContactSaveState["phase"] = "idle", error: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<boolean> | undefined;
  let stopped = false;
  const fields = ["remark", "group_name"] as const;
  const dirty = () => fields.some(key => draft[key] !== acknowledged[key]);
  const state = (): ContactSaveState => ({ phase, draft: { ...draft }, dirty: dirty(), error });
  const changed = () => { if (!stopped) options.changed(state()); };
  const pause = () => { clearTimeout(timer); timer = undefined; };
  function edit(value: ContactMetadata) {
    if (stopped) return;
    pause(); draft = { ...value }; error = undefined;
    phase = flight ? "saving" : dirty() ? "waiting" : "idle";
    changed();
    if (dirty()) timer = setTimeout(() => { void flush(); }, options.delay ?? 650);
  }
  async function flush(): Promise<boolean> {
    pause();
    if (stopped) return false;
    if (flight) return (await flight) ? flush() : false;
    if (!dirty()) return true;
    const snapshot = { ...draft };
    const patch = Object.fromEntries(fields.filter(key => snapshot[key] !== acknowledged[key])
      .map(key => [key, snapshot[key]]));
    phase = "saving"; error = undefined; changed();
    const request = Promise.resolve().then(() => options.write(patch)).then(result => {
      if (stopped) return false;
      for (const key of fields) if (draft[key] === snapshot[key]) draft[key] = result[key];
      acknowledged = { ...result };
      const pending = dirty();
      phase = pending ? "waiting" : "saved";
      changed(); options.saved?.({ ...result }, pending);
      return true;
    }).catch(cause => {
      if (!stopped) { error = cause; phase = "error"; changed(); }
      return false;
    }).finally(() => { if (flight === request) flight = undefined; });
    flight = request;
    return (await request) ? flush() : false;
  }
  return { edit, flush, pause, state, stop() { pause(); stopped = true; } };
}

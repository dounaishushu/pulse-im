import { onScopeDispose, watch, type Ref } from "vue";
import platform from "virtual:pulse-platform";
import type { TrayAccount, TrayAccountAction } from "../../platform/contracts";

export function useDesktopTrayAccounts(
  rows: () => TrayAccount[],
  locked: Readonly<Ref<boolean>>,
  onAction: (action: TrayAccountAction) => void,
) {
  const tray = platform.trayAccounts;
  if (!tray) return;
  let active = true;
  let unsubscribe: (() => void) | undefined;
  let previous = "";
  let writing = Promise.resolve();
  const listening = tray.subscribe((event) => {
    if (active) onAction(event);
  }).then((stop) => {
    if (active) unsubscribe = stop;
    else stop();
  });
  watch([rows, locked], ([next, isLocked]) => {
    const json = JSON.stringify([next, isLocked]);
    if (json === previous) return;
    previous = json;
    writing = writing.then(async () => {
      await listening;
      if (active && previous === json) await tray.sync(next, isLocked);
    }).catch(() => {
      if (previous === json) previous = "";
    });
  }, { immediate: true });
  onScopeDispose(() => {
    active = false;
    unsubscribe?.();
  });
}

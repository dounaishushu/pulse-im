import { shallowRef } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useSession } from "../stores/session";

export function useAction() {
  const busy = shallowRef(false);
  const error = shallowRef("");
  const session = useSession();
  async function run<T>(
    action: (assertCurrent: () => void) => Promise<T>,
    success = "",
  ): Promise<T | undefined> {
    if (busy.value) return;
    const generation = session.generation.value;
    const assertCurrent = () => {
      if (generation !== session.generation.value)
        throw new DOMException("管理会话已改变，已取消后续操作", "AbortError");
    };
    busy.value = true;
    error.value = "";
    try {
      const result = await action(assertCurrent);
      assertCurrent();
      if (session.generation.value === generation && success)
        ElMessage.success(success);
      return result;
    } catch (e: any) {
      if (session.generation.value === generation && e.name !== "AbortError") {
        error.value = e.message;
        ElMessage.error(e.message);
      }
      return undefined;
    } finally {
      busy.value = false;
    }
  }
  return { busy, error, run };
}
export async function confirmAction(message: string, title = "确认操作") {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      type: "warning",
      closeOnClickModal: false,
    });
    return true;
  } catch {
    return false;
  }
}

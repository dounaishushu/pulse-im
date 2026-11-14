import { shallowRef, onBeforeUnmount } from "vue";
import { get, query } from "../api/client";
import type { RecordData, PageResult } from "../domain/types";

export function usePageData(endpoint: string, size = 20) {
  const data = shallowRef<PageResult>({ items: [], total: 0, page: 1, size });
  const loading = shallowRef(false);
  const error = shallowRef("");
  const page = shallowRef(1);
  const pageSize = shallowRef(size);
  let controller: AbortController | undefined;
  let sequence = 0;
  let filters: RecordData = {};
  async function load(next?: RecordData, reset = false) {
    if (next) filters = { ...next };
    if (reset) page.value = 1;
    controller?.abort();
    controller = new AbortController();
    const current = ++sequence;
    loading.value = true;
    error.value = "";
    try {
      const result = await get<PageResult>(
        query(endpoint, { ...filters, page: page.value, size: pageSize.value }),
        controller.signal,
      );
      if (current === sequence) data.value = result;
    } catch (e: any) {
      if (current === sequence && e.name !== "AbortError")
        error.value = e.message;
    } finally {
      if (current === sequence) loading.value = false;
    }
  }
  onBeforeUnmount(() => {
    sequence++;
    controller?.abort();
  });
  return { data, loading, error, page, pageSize, load };
}

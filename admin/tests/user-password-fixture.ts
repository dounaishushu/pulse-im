// Browser-only fixture: production component + transport, isolated HTTP test responses.
import { createApp, h, nextTick, ref } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "../src/styles/theme.css";
import UserEditor from "../src/features/users/UserEditor.vue";
import { useSession } from "../src/stores/session";
import { get } from "../src/api/client";

sessionStorage.setItem("pulse.go.admin.entry", "1".repeat(64));
const session = useSession();
await session.login("fixtureadmin", "AdminFixture888");
const rows = await get("/admin/users");
const selected = ref(rows.items[0]);
const open = ref(false);
(window as any).passwordFixture = { session, selected, open, rows: rows.items };
createApp({
  render: () =>
    h(UserEditor, {
      modelValue: open.value,
      "onUpdate:modelValue": (value: boolean) => {
        open.value = value;
      },
      user: selected.value,
    }),
})
  .use(ElementPlus)
  .mount("#app");
await nextTick();
open.value = true;

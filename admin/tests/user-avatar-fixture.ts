import { createApp, h } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "../src/styles/theme.css";
import UsersView from "../src/views/UsersView.vue";
import PreviewImage from "../src/components/PreviewImage.vue";
import { clearSession, useSession } from "../src/stores/session";

sessionStorage.setItem("pulse.go.admin.entry", "a".repeat(64));
const session = useSession();
await session.login("avatar_fixture", "AvatarFixture888");
createApp({ render: () => h("main", { style: "padding:20px;height:100vh;overflow:auto;box-sizing:border-box" }, [
  h("button", { id: "fixture-logout", onClick: () => clearSession() }, "清理测试会话"),
  h(UsersView),
  h("div", { style: "height:1800px" }),
  h("div", { id: "fixture-offscreen" }, [h(PreviewImage, { src: `${location.origin}/api/v2/admin/media/00000099-2222-4222-8222-222222222222/content`, alt: "屏幕外测试图", style: "width:35px;height:35px" })]),
]) }).use(ElementPlus).mount("#app");

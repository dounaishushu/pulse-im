import { createRouter, createWebHashHistory } from "vue-router";
import { pages } from "../domain/catalog";
import { can, useSession } from "../stores/session";

const views = {
  dashboard: () => import("../views/DashboardView.vue"),
  users: () => import("../views/UsersView.vue"),
  devices: () => import("../views/DevicesView.vue"),
  groups: () => import("../views/GroupsView.vue"),
  messages: () => import("../views/MessagesView.vue"),
  moderation: () => import("../views/MessagesView.vue"),
  "sensitive-words": () => import("../views/SensitiveWordsView.vue"),
  announcement: () => import("../views/AnnouncementView.vue"),
  "login-logs": () => import("../views/LogsView.vue"),
  "dispatch-tasks": () => import("../views/DispatchView.vue"),
  "task-config": () => import("../views/TasksView.vue"),
  "question-bank": () => import("../views/QuestionsView.vue"),
  "task-records": () => import("../views/RecordsView.vue"),
  "client-config": () => import("../views/ClientConfigView.vue"),
  routes: () => import("../views/RoutesView.vue"),
  maintenance: () => import("../views/MaintenanceView.vue"),
  "admin-accounts": () => import("../views/AccountsView.vue"),
};
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    ...pages.map((page) => ({
      path: "/" + page.key,
      name: page.key,
      component: views[page.key],
      meta: { ...page },
    })),
    { path: "/explore", redirect: "/client-config" },
    { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
  ],
});
router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.ready.value) await session.refresh();
  if (!session.account.value) return true;
  if (!can(String(to.name))) {
    const first = pages.find((page) => can(page.key));
    return first ? { name: first.key } : true;
  }
  document.title = `${String(to.meta.title || "管理后台")} · 脉冲`;
  return true;
});

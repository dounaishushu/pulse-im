import { computed, onScopeDispose, shallowRef } from "vue";
export function usePreferences() {
  const revision = shallowRef(0);
  const changed = () => revision.value++;
  window.addEventListener("pulse:preferences", changed);
  window.addEventListener("storage", changed);
  const setting = (key: string, fallback = true) => {
    void revision.value;
    const value = localStorage.getItem("pulse_setting_" + key);
    return value === null ? fallback : value === "1";
  };
  const background = computed(() => {
    void revision.value;
    const source = localStorage.getItem("pulse_vue_background") || "";
    return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
      source,
    )
      ? {
          backgroundImage: `url("${source}")`,
          backgroundSize: setting("background_tile", false) ? "auto" : "cover",
          backgroundRepeat: setting("background_tile", false)
            ? "repeat"
            : "no-repeat",
        }
      : {};
  });
  onScopeDispose(() => {
    window.removeEventListener("pulse:preferences", changed);
    window.removeEventListener("storage", changed);
  });
  return { revision, setting, background };
}

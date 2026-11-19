export function applyChatTheme(theme: string) {
  document.body.dataset.theme = theme;
  document.body.classList.toggle("desktop-night-mode", theme === "night");
  if (theme === "night") document.body.setAttribute("theme-mode", "dark");
  else document.body.removeAttribute("theme-mode");
  document.documentElement.style.colorScheme =
    theme === "night" ? "dark" : "light";
}

export function applyInterfaceScale(value: string | number | null) {
  const scale = Number(value);
  const valid = [1, 1.25, 1.5, 2, 2.5, 3].includes(scale) ? scale : 1;
  document.documentElement.style.setProperty("--pulse-interface-scale", String(valid));
  document.documentElement.style.zoom = String(valid);
}

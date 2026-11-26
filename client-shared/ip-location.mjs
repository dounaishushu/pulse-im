function part(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}

// IPPure calls the second field region; the existing API stores it as province.
export function countryRegionCity(detail) {
  if (!detail || typeof detail !== "object") return "";
  return [part(detail.country), part(detail.region) || part(detail.province), part(detail.city)]
    .filter(Boolean).join("-");
}

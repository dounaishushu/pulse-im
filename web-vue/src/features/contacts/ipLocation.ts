import type { IPLocationDetail } from "../../api/types";

export function ipLocationText(ip?: string, fallback?: string, status?: string, detail?: IPLocationDetail | null) {
  if (!ip) return "暂无记录";
  if (detail) {
    const parts: string[] = [];
    const country = detail.country?.trim() || "";
    const local = [detail.province, detail.city, detail.district].map(value => value?.trim() || "");
    if (country && (!local.some(Boolean) || !["中国", "中华人民共和国", "china", "cn"].includes(country.toLocaleLowerCase()))) parts.push(country);
    for (const part of local) if (part && !parts.includes(part)) parts.push(part);
    if (parts.length) return parts.join("-") + (detail.district?.trim() ? "" : local[0] || local[1] ? "（区县未提供）" : "（省市区未提供）");
  }
  if (fallback) return fallback;
  if (status === "failed") return "归属地查询失败";
  if (status === "unconfigured") return "归属地暂不可用";
  return "暂未查到归属地";
}

export function ipLocationSource(detail?: IPLocationDetail | null) {
  if (detail?.source === "ippure") return "IPPure · 此用户设备查询并上报，IP 与服务器连接记录一致";
  return detail?.source === "cache" ? "服务器归属地缓存" : "归属地来源未提供";
}

import type { IPLocationDetail } from "../../api/types";
import { countryRegionCity } from "../../../../client-shared/ip-location.mjs";

export function ipLocationText(ip?: string, fallback?: string, status?: string, detail?: IPLocationDetail | null) {
  if (!ip) return "暂无记录";
  const text = countryRegionCity(detail);
  if (text) return text;
  if (fallback) return fallback;
  if (status === "failed") return "归属地查询失败";
  if (status === "unconfigured") return "归属地暂不可用";
  return "暂未查到归属地";
}

export function ipLocationSource(detail?: IPLocationDetail | null) {
  if (detail?.source === "ippure") return "IPPure · 此用户设备查询并上报，IP 与服务器连接记录一致";
  if (detail?.source === "offline") return `离线 IP 库 · ${detail.database_version || "ip2region"} · IPPure 无记录时补全，不代表设备精确位置`;
  return detail?.source === "cache" ? "服务器归属地缓存" : "归属地来源未提供";
}

import { countryRegionCity } from "../../../../client-shared/ip-location.mjs";
import type { RecordData } from "../../domain/types";

export function userIPLocation(row: RecordData, kind: "register" | "login", cache: RecordData = {}) {
  const ip = row[`${kind}_ip`];
  if (!ip) return "暂无记录";
  // Per-user details must take precedence over the shared authoritative IP cache.
  const detail = row[`${kind}_ip_location_detail`];
  const text = countryRegionCity(detail);
  if (text) return text;
  if (row[`${kind}_ip_location`]) return row[`${kind}_ip_location`];
  const cached = cache[ip];
  if (cached?.status === "ready" || cached?.status === "resolved") {
    return countryRegionCity(cached) || cached.location || "暂未识别";
  }
  return "暂未识别";
}

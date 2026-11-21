import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "docs/PC-TAURI-BASELINE.json");
const matrixPath = resolve(root, "docs/PC-TAURI-PARITY.csv");
const release = process.argv.includes("--release");
const validStates = new Set(["待核实旧包", "待迁移", "已实现待验收", "已验收"]);

function parseCsv(text) {
  const records = [];
  let fields = [];
  let field = "";
  let quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[offset + 1] === '"') {
        field += '"';
        offset++;
      } else quoted = false;
    } else if (char === '"' && !field) {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n") {
      fields.push(field.replace(/\r$/, ""));
      records.push(fields);
      fields = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw Error("验收清单中有未闭合的字段引号。");
  if (field || fields.length) records.push([...fields, field]);
  const [header, ...rows] = records;
  if (!header?.includes("state")) throw Error("验收清单缺少状态列。");
  return rows.filter((row) => row.some(Boolean)).map((row) => {
    if (row.length !== header.length) throw Error("验收清单中存在列数不一致的条目。");
    return Object.fromEntries(header.map((key, index) => [key, row[index]]));
  });
}

function isInsideWorkspace(path) {
  const fromRoot = relative(root, path);
  return !!fromRoot && !isAbsolute(fromRoot) && !/^\.\.(?:[\\/]|$)/.test(fromRoot);
}

const [baselineData, matrixData] = await Promise.all([
  readFile(baselinePath, "utf8"),
  readFile(matrixPath, "utf8"),
]);
const baseline = JSON.parse(baselineData);
const matrix = parseCsv(matrixData.replace(/^\uFEFF/, ""));
const ids = new Set(matrix.map((row) => row.id));
if (ids.size !== matrix.length || matrix.length !== baseline.capabilityCount) {
  throw Error("验收清单的编号重复，或与源码基线的条目数不一致。");
}
for (const item of [...baseline.files, ...baseline.ipcChannels, ...baseline.assetGroups]) {
  if (!item.capabilityIds.length || item.capabilityIds.some((id) => !ids.has(id))) {
    throw Error(`存在未归属的源码、资源或桌面接口 ${item.path || item.channel || item.prefix}`);
  }
}

const pending = [];
for (const row of matrix) {
  if (!row.id || !row.legacy_evidence || !row.acceptance || !validStates.has(row.state)) {
    throw Error(`验收清单存在信息不完整的条目 ${row.id}`);
  }
  if (row.state !== "已验收") {
    pending.push(row.id);
    continue;
  }
  if (!row.new_evidence || !/^[a-f0-9]{40}$/i.test(row.review_commit) || !row.windows_evidence) {
    throw Error(`已验收条目缺少新代码、审查提交或 Windows 证据 ${row.id}`);
  }
  for (const item of row.windows_evidence.split(" + ")) {
    const path = resolve(root, item.trim());
    if (!isInsideWorkspace(path) || !await stat(path).then((file) => file.isFile(), () => false)) {
      throw Error(`验收证据找不到 ${row.id} ${item}`);
    }
  }
}
console.log(`Windows 迁移共 ${matrix.length} 项，已验收 ${matrix.length - pending.length} 项，待验收 ${pending.length} 项。`);
if (release && pending.length) {
  console.error(`正式发布等候验收 ${pending.join(", ")}`);
  process.exitCode = 1;
}

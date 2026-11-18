import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyWebAssets(directory) {
  const root = path.resolve(directory);
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  const files = [
    ...new Set(
      refs
        .filter((ref) => !/^(?:https?:|data:|#)/.test(ref))
        .map((ref) =>
          decodeURIComponent(ref.split(/[?#]/)[0])
            .replace(/^\.\//, "")
            .replace(/^\//, ""),
        ),
    ),
  ];
  const manifestPath = path.join(root, ".vite/manifest.json");
  if ((await stat(manifestPath).catch(() => null))?.isFile()) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const value of Object.values(manifest)) {
      files.push(value.file, ...(value.css || []), ...(value.assets || []));
      for (const key of [
        ...(value.imports || []),
        ...(value.dynamicImports || []),
      ]) {
        if (!manifest[key]) throw new Error(`Missing build chunk: ${key}`);
      }
    }
  }
  for (const name of files) {
    const file = path.resolve(root, name);
    if (
      !file.startsWith(root + path.sep) ||
      !(await stat(file).catch(() => null))?.isFile()
    )
      throw new Error(`Missing Web dependency: ${name}`);
  }
  return { root, checked: new Set(files).size };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(JSON.stringify(await verifyWebAssets(process.argv[2] || "web")));
}

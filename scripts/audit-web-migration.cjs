// Capture code evidence for every old Web source, independently of runtime tests.
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  ts = require(
    require.resolve("typescript", {
      paths: [path.join(root, "web-vue"), path.join(root, "admin")],
    }),
  );
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const strict = process.argv.includes("--strict");
const mapPath = path.join(root, "docs/web-migration-map.json");
const mapping = JSON.parse(fs.readFileSync(mapPath, "utf8"));
const sources = cp
  .execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", mapping.baseline, "web"],
    { cwd: root },
  )
  .toString()
  .split("\n")
  .filter((name) => /\.(?:js|css|html)$/.test(name));
const audit = [];
for (const file of sources) {
  const source = cp
    .execFileSync("git", ["show", `${mapping.baseline}:${file}`], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
    .toString();
  const record = mapping.files[file];
  if (!record) throw Error("Unmapped old Web source: " + file);
  for (const target of record.targets) {
    if (
      !fs.statSync(path.join(root, target), { throwIfNoEntry: false })?.isFile()
    )
      throw Error("Missing migration target " + target);
  }
  if (
    strict &&
    (record.review !== "complete" ||
      record.gaps.length ||
      !record.checks.length)
  )
    throw Error("Unreviewed migration behavior: " + file);
  const sourceHash = digest(source);
  if (strict && record.source_sha256 !== sourceHash)
    throw Error("Baseline source changed: " + file);
  if (record.source) {
    const reused = fs.readFileSync(path.join(root, record.source), "utf8");
    let expected = source.replaceAll("\r\n", "\n");
    if (record.reuse_patch === "reentrant-realtime-close-v1") {
      if (file !== "web/go-realtime.js")
        throw Error("Unexpected reviewed shared patch: " + file);
      expected = expected
        .replace(
          "const emit=packet=>{deliver(packet);channel?.postMessage(packet);};",
          "const emit=packet=>{deliver(packet);if(!closed)channel?.postMessage(packet);};",
        )
        .replace(
          "socket?.close();channel?.close();release?.();",
          "socket?.close();if(channel){channel.onmessage=null;channel.close();}release?.();",
        )
        .replace(
          "channel.onmessage=e=>{if(e.data?.type",
          "channel.onmessage=e=>{if(closed)return;if(e.data?.type",
        );
    }
    if (reused.replaceAll("\r\n", "\n") !== expected)
      throw Error("Shared source diverged from its reviewed body: " + file);
  }
  if (record.disposition === "styling") {
    const styles = fs.readFileSync(
      path.join(root, "web-vue/src/styles.css"),
      "utf8",
    );
    if (
      fs
        .readFileSync(path.join(root, file), "utf8")
        .replaceAll("\r\n", "\n") !== source.replaceAll("\r\n", "\n")
    )
      throw Error("Old stylesheet contents changed: " + file);
    if (!styles.includes("../../" + file))
      throw Error("Old stylesheet no longer imported: " + file);
  }
  for (const target of record.targets) {
    if (
      strict &&
      record.target_sha256?.[target] !==
        digest(fs.readFileSync(path.join(root, target)))
    )
      throw Error("Migration target changed since review: " + target);
  }
  const functions = [];
  if (file.endsWith(".js")) {
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name)
        functions.push({
          name: node.name.text,
          line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      if (ts.isMethodDeclaration(node) && node.name)
        functions.push({
          name: node.name.getText(ast),
          line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const routes = [
    ...new Set(
      [...source.matchAll(/(?:api|request)\((?:`|'|")([^'"`\n]+)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  const eventBindings = [
    ...new Set(
      [...source.matchAll(/addEventListener\(['"]([^'"]+)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  const selectors = [
    ...new Set(
      [
        ...source.matchAll(
          /(?:querySelector(?:All)?|getElementById)\(['"]([^'"]+)/g,
        ),
      ].map((match) => match[1]),
    ),
  ];
  audit.push({
    file,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    lines: source.split("\n").length,
    functions: functions.map((item) => ({
      ...item,
      targets:
        record.function_owners?.find(
          (owner) => item.line >= owner.from && item.line <= owner.to,
        )?.targets || record.targets,
    })),
    routes,
    eventBindings,
    selectors,
    ...record,
  });
}
const native = fs
  .readdirSync(path.join(root, "web-vue/src"), { recursive: true })
  .filter((file) => /\.(?:ts|vue)$/.test(file))
  .map((file) => fs.readFileSync(path.join(root, "web-vue/src", file), "utf8"))
  .join("\n");
if (
  /mountRetainedChat|virtual:pulse-retained-chat|legacyLifecycle/.test(native)
)
  throw Error("Legacy UI wrapper remains in native Vue entry");
// Static resources are compared against the original Git blob IDs, then the
// exact emitted files. This covers emoji and icons beyond the entry manifest.
const tree = cp
  .execFileSync("git", ["ls-tree", "-r", "-z", mapping.baseline, "web"], {
    cwd: root,
  })
  .toString()
  .split("\0")
  .filter(Boolean);
const staticResources = [];
for (const line of tree) {
  const [meta, file] = line.split("\t");
  if (/\.(?:js|css|html)$/.test(file)) continue;
  const bytes = fs.readFileSync(path.join(root, file)),
    expected = meta.split(" ")[2];
  const blob = crypto
    .createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
  if (blob !== expected)
    throw Error("Original static resource changed: " + file);
  const dist = path.join(root, "web-vue/dist", file.slice(4));
  if (fs.existsSync(dist) && !bytes.equals(fs.readFileSync(dist)))
    throw Error("Emitted static resource changed: " + file);
  if (
    (file.startsWith("web/emoji/") || file === "web/app-icon.png") &&
    !fs.existsSync(dist)
  )
    throw Error("Static resource missing from build: " + file);
  staticResources.push({ file, sha256: digest(bytes) });
}
const resourceHash = digest(JSON.stringify(staticResources));
if (strict && mapping.static_resources_sha256 !== resourceHash)
  throw Error("Static resource inventory changed");
const nativeFiles = [
  "web-vue/index.html",
  "web-vue/package.json",
  "web-vue/package-lock.json",
  "web-vue/tsconfig.json",
  "web-vue/vite.config.ts",
  ...["src", "build"].flatMap((dir) =>
    fs
      .readdirSync(path.join(root, "web-vue", dir), { recursive: true })
      .filter((file) => /\.(?:ts|vue|css|webp)$/.test(file))
      .map((file) => "web-vue/" + dir + "/" + file.replaceAll("\\", "/")),
  ),
]
  .sort()
  .map((file) => ({
    file,
    sha256: digest(fs.readFileSync(path.join(root, file))),
  }));
const nativeTreeHash = digest(JSON.stringify(nativeFiles));
if (strict && mapping.native_tree_sha256 !== nativeTreeHash)
  throw Error("Native source tree changed since review");
const result = {
  baseline: mapping.baseline,
  source_files: sources.length,
  native_files: nativeFiles,
  native_tree_sha256: nativeTreeHash,
  static_resource_files: staticResources.length,
  static_resources_sha256: resourceHash,
  functions: audit.reduce((n, row) => n + row.functions.length, 0),
  files: audit,
};
const destination =
  process.argv.slice(2).find((value) => !value.startsWith("--")) ||
  path.join(
    root,
    ".local/client-network-release-20261118/web-code-parity.json",
  );
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    sources: result.source_files,
    functions: result.functions,
    output: destination,
    pending: audit
      .filter((row) => row.review !== "complete")
      .map((row) => row.file),
  }),
);

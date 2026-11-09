// Explicit installer for this computer's local services. Production keeps its
// independent HTTPS/WSS gate; this build never accepts a remote endpoint.
const fs = require('node:fs');
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const { localPreviewConfig, validateLocalPreviewConfig } = require('./runtime-config.cjs');
async function main() {
  const runtimePath = path.join(__dirname, 'runtime-config.json');
  const previous = fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath) : null;
  try {
    fs.writeFileSync(runtimePath, JSON.stringify(localPreviewConfig(), null, 2) + '\n');
    await build({
      projectDir: __dirname,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      publish: 'never',
      config: {
        directories: { output: 'dist-local' },
        electronDist: path.join(__dirname, 'node_modules/electron/dist'),
        electronVersion: require('electron/package.json').version,
        extraMetadata: { pulseBuildProfile: 'local-preview' },
        win: { artifactName: '小猿口算-${version}-本地测试-${arch}.${ext}' },
        nsis: { runAfterFinish: false },
        beforePack: async () => {
          validateLocalPreviewConfig(JSON.parse(fs.readFileSync(runtimePath, 'utf8')));
          for (const filename of ['web/auth.js', 'web/auth.css']) if (!fs.statSync(path.join(__dirname, filename)).isFile()) throw new Error('Missing registration view: ' + filename);
        },
      },
    });
    const asar = require('@electron/asar');
    const archive = path.join(__dirname, 'dist-local/win-unpacked/resources/app.asar');
    for (const filename of ['main.js', 'window-manager.cjs', 'global-proxy.cjs', 'session-fetch.cjs', 'preload.js', 'web/index.html', 'web/app.js', 'web/message-actions.js', 'web/message-actions.css', 'web/auth.js', 'web/auth.css', 'web/classic-pc.css', 'web/night-mode.css', 'web/themes.css', 'assets/app-icon.png', 'assets/app-icon.ico']) {
      if (!asar.extractFile(archive, filename).equals(fs.readFileSync(path.join(__dirname, filename)))) throw new Error('打包内容与源码不一致：' + filename);
    }
    const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
    if (packagedMetadata.version !== require('./package.json').version || packagedMetadata.pulseBuildProfile !== 'local-preview') throw new Error('打包版本或配置标识不一致');
    validateLocalPreviewConfig(JSON.parse(asar.extractFile(archive, 'runtime-config.json').toString()));
    console.log('已核对安装包内置注册页与当前源码逐字节一致。');
    console.log('本地测试安装包已生成到 pc/dist-local；只连接本机服务，不用于服务器正式发布。');
  } finally {
    if (previous === null) { if (fs.existsSync(runtimePath)) fs.unlinkSync(runtimePath); }
    else fs.writeFileSync(runtimePath, previous);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

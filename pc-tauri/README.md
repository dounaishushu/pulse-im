# Pulse IM Windows · Tauri

`pc-tauri/` 是新版 PC 客户端。它使用 `web-vue/` 中的 Vue 界面和 `client-shared/` 中的 Go 协议适配代码。旧版 Electron 位于 `pc/`。新版安装版、便携版和旧版使用各自的应用标识和数据目录，可以在同一台电脑运行。

## Windows x64 构建

使用 Node.js 22.12 或更新版本、Rust MSVC 和 Visual Studio C++ Build Tools。在仓库根目录安装锁定的依赖。

```powershell
npm.cmd --prefix pc-tauri ci
npm.cmd --prefix web-vue ci
Set-Location pc-tauri
```

构建安装版并保存 `src-tauri/target/release/bundle/nsis/` 中的 `*-setup.exe`。

```powershell
npm.cmd run tauri -- build --ci --config src-tauri/tauri.release.conf.json --bundles nsis -- --locked
```

构建便携版，将 `src-tauri/target/release/pulse-im-desktop.exe` 复制为单独的便携 EXE。两项命令共用 `target/release`，按顺序构建。

```powershell
npm.cmd run tauri -- build --ci --config src-tauri/tauri.portable.conf.json --features portable --no-bundle -- --locked
```

两个成品都是 Windows GUI 程序。安装版在缺少 Microsoft Edge WebView2 Runtime 时通过安装器下载运行时。便携版使用系统上已装的 WebView2 Runtime。把它放在可写目录里，首次启动会在旁边创建 `PulseIM-Data/`，保存会话、设置、缓存和日志。移动时可以把该目录与 EXE 一起带走。Windows 保护的已保存密码仍绑定原 Windows 用户。便携版省略开机启动和系统「发送到」菜单集成。

旧版升级和功能覆盖的证据见 [验收记录](../docs/PC-TAURI-ACCEPTANCE-2026-11-21.md) 和 [功能对照表](../docs/PC-TAURI-PARITY.csv)。

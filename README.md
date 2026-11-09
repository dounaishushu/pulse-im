# Pulse IM 独立部署源码包

本包从 2026-11-09 的工作目录源码提取，包含后端、管理后台、Web、PC、Android、iOS，以及数据库结构和部署模板。

**首次安装请阅读 [DEPLOYMENT.md](DEPLOYMENT.md)。** 所有服务域名为示例，正式运行前须配置自己的域名、数据库、密钥及客户端签名。

完整功能说明见 **[功能清单](docs/FEATURES.md)**，包含即时通讯、各端差异、管理后台、任务与分发、已移除功能和验收范围。

## 内容与数据边界

- `backend/`：PHP/ThinkPHP 后端、WebSocket、任务和推送进程。
- `admin/`、`web/`：管理后台及浏览器端源码和必要静态资源。
- `pc/`：Electron 桌面端源码、图标、依赖清单与锁文件。
- `android/`、`ios/`：原生客户端工程与必要资源。
- `database/schema.sql`：新安装数据库结构，仅带系统默认配置；没有用户、管理员账号、消息、联系人、群聊、作业记录或业务数据。
- `database/migrations/`：历史升级维护脚本，新安装不批量执行。
- `deploy/`、`tools/`：Nginx、Supervisor、备份模板和必要部署工具。
- `mobile-contracts/route-trust.json`：待配置的新环境线路信任模板。

不包含原环境 `.env`、数据库导出、上传文件、登录状态、聊天缓存、日志、截图、录屏、测试数据、私钥、签名证书、机器路径配置、旧发布包或历史备份。`backend/runtime` 和 `backend/public/storage` 仅留空目录标记。

源码中的图标、表情、界面背景、公开 CA 证书和第三方许可证属于程序资源，保留在包内。依赖目录 `backend/vendor` 和 `pc/node_modules` 未打包，按锁文件重新安装；Android Gradle wrapper JAR 是构建入口，已保留。

本包未预置管理员密码。部署工具在新环境生成独立密钥，管理员由部署方创建。示例域名与缺失公钥会阻止直接制作正式客户端；请按部署文档完成配置。iOS 未配置的公钥为空，不继承旧环境的信任关系。

## 校验

解压后在本目录执行：

```bash
sha256sum -c SOURCE-MANIFEST.sha256
```

Windows 可用 `Get-FileHash` 对 ZIP 计算 SHA-256，与压缩包旁的 `.sha256` 文件比较。文件清单覆盖包内全部内容（清单自身除外）。

这是源码交付包，未在目标服务器实际部署；测试范围和构建限制见 `PACKAGE-VERIFICATION.json`。

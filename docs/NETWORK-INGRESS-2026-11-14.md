# 公网端口收敛（2026-11-14）

北京时间 16:24 现场确认：本机防火墙对新的公网 TCP 连接只保留 **22、80、443**。IPv4、IPv6 的 UFW 放行规则一致，额外的 nftables 规则拒绝其他新入站 TCP/UDP。既有连接保留，不主动中断聊天、上传或运维会话。

| TCP 端口 | 用途 | 最终公网状态 |
| --- | --- | --- |
| 22 | SSH 与受认证的管理隧道 | 放行，继续使用 Fail2ban |
| 80 | HTTPS 跳转与 ACME 证书续期入口 | 放行 |
| 443 | Web、管理后台、Go API、媒体上传下载、WSS | 放行，按域名与路径分流 |

收敛前实际从外网能连接 22/80/443/21868。UFW 另有 20/21/888/8888/21868/39000–40000/TCP、6379/TCP+UDP、8282/TCP+UDP 放行；其中部分已被上一轮独立防火墙阻止。本次精确删除这十条多余 UFW 规则及其 IPv6 对应项，没有 `ufw reset`，没有清空 Docker、面板或 Fail2ban 的表。

## 443 路由

| 入口 | 代理方式 |
| --- | --- |
| `api.imapi.shop:443` | Web 静态资源；`/api/v2/` 进入 `127.0.0.1:18080`；实时路径支持 WebSocket 升级 |
| `admin.imapi.shop:443` | 独立管理后台及 Go 后台 API |
| `wss.imapi.shop:443` | `/api/v2/realtime` 进入同一个 Go 实时服务 |

当前只有 HTTP/HTTPS/WSS 业务，既有 Nginx 已完成 443 分流；本轮没有加入 HAProxy、迁移 TLS、改应用地址或重启 Go。若将来增加不能用 HTTP 反向代理的 TCP 协议，再评估 TLS SNI 分流及真实客户端 IP 传递；当前部署没有这类额外协议。

## 面板与内部服务

宝塔的 **21868 公网入口已关闭**，面板程序、TLS 配置与原安全入口路径保留，通过 SSH 隧道访问。可在本机开启仅本机可用的 SOCKS5 隧道：

```powershell
ssh -N -D 127.0.0.1:11080 -o ExitOnForwardFailure=yes root@38.246.255.15
```

在专用浏览器配置中使用 SOCKS5 `127.0.0.1:11080` 后，仍使用原面板完整 HTTPS 地址与安全入口路径。这样浏览器验证的还是原服务器地址的证书，避免把原 IP 证书直接用在 localhost 上。隧道需要现有 SSH 凭据；关闭 SSH 进程即可关闭临时代理。不要将本机隧道监听绑定到 `0.0.0.0`。

MySQL、PostgreSQL、Redis、Go 内部端口和旧服务不公开。不能把“防火墙阻止外部连接”误写成“进程完全不监听该地址”：MySQL、宝塔及旧 phpMyAdmin 的进程/配置仍保留，外部新连接由白名单阻断。

## 规则与持久化

[pulse-security.nft](../server/deploy/security/pulse-security.nft) 对应服务器 `/etc/pulse/security.nft`，由已启用的 `pulse-firewall.service` 启动和重载。规则只管理 `inet pulse_protection` 表：

- 回环、已有/相关连接优先保留；无效连接丢弃。
- 新 TCP 入口只放 22/80/443，其余 TCP/UDP 丢弃。
- 保留实际私网网卡 `eno1` 的 DHCPv4、IPv6 链路本地 DHCPv6；ICMP/邻居发现继续受 UFW 处理。这些基础网络例外不等于开放公网 UDP 业务端口。
- `wan` 是现场公网网卡；对公网进入、经 DNAT 转发的连接额外阻断，防止将来 Docker 发布端口绕过 INPUT。当前唯一应用容器使用 host 网络，此规则未改变其流量。

接口名取自现场核对，不能把此部署文件未经调整套用到其他主机。IPv6 策略已启用，但本机只有链路本地 IPv6，没有可用于外网探测的全局 IPv6 地址；本轮不声称做过公网 IPv6 端口验收。

## 验证与回滚

- 在修改前备份 UFW、nftables 与 Nginx 配置，并设置八分钟自动恢复。只有新的 SSH 会话、面板隧道及外网检查通过后才确认并取消自动恢复。
- 外网验证 18 个 TCP 端口：只连接到 22/80/443；其余 20/21/888/8888/21868/3306/5432/6379/8282/18080/39000/39500/40000/2375/2376 均不可连接。这是明确端口采样，其他端口的默认拒绝依据为现场白名单，不表述为全端口扫描。
- Web、后台、配置、健康返回 200，未登录个人接口返回 401。API/WSS 两个域名的非法实时票据均返回后端 401；这是路由和认证边界检查，本轮没有再做用户登录后的实时消息验收。
- 新 SSH 登录、`direct-tcpip` 转发、面板 HTTPS 经隧道读取通过；面板 `/` 按原安全入口策略返回 404，证书按原服务器 IP 校验通过。这不代替面板账户登录验收。
- Nginx/nftables 语法、UFW 保存规则、开机服务、Fail2ban、文件巡检均复核通过。应用镜像和环境变量不变，Go healthy、没有重启，3,068 个发布文件校验一致；数据库、旧数据和媒体未修改。
- 曾尝试将旧 phpMyAdmin 的 888 监听改为回环，Nginx 在线重绑出现地址占用；已精确恢复原 Nginx 文件并成功重载。最终不更改 Nginx 配置，888 通过防火墙关闭公网，没有为此中断已有服务。

现场备份和原始证据：服务器 `/root/pulse-im-migration/ports-20261114`、本机忽略目录 `.local/ports-20261114` 与 `.local/release-security-20261114/ports-*.private.json`。公开摘要见 [端口收敛证据](evidence/network-ingress-2026-11-14.json)。本轮没有新增手机打包、数据库迁移或应用功能修改。

需要撤销本次端口收敛时，在 SSH 中执行：

```bash
cd /root/pulse-im-migration/ports-20261114
mv confirmed confirmed.before-rollback
python3 rollback.py
```

该脚本只恢复此轮备份的配置，然后重载 UFW、独立 nft 表及 Nginx；会重新开放本轮关闭的旧面板等入口，应只在明确需要时使用。不要直接停止 `pulse-firewall.service` 或清空整个 nft ruleset 作为常规解封方式。

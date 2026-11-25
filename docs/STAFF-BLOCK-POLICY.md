# 内部员工的拉黑保护

普通前台账号不能新增拉黑；正式员工、群主或群管理员身份不等于内部员工身份。服务端在每次写入事务中读取当前权限，旧客户端和旧令牌同样受限。

后台调整 `internal_staff` 时，在同一个事务内解除由此形成的“普通用户 → 内部员工”拉黑。相反方向和员工之间的拉黑保留。解除拉黑不修改好友关系、私人备注、消息或其他聊天限制；双方原有私聊及联系人列表会收到刷新通知。

历史数据可由服务器运维命令补全，执行前备份匹配的 `pulse.blocks` 行：

```sh
docker exec pulse-im-go /pulse-im release-staff-blocks
```

命令使用当前容器的数据库配置，不提供对外 HTTP 入口；重复执行不会重复解除或重复发通知，不需要修改数据库结构。角色变更与补全使用事务锁串行处理，普通消息收发没有新增扫描。

验证命令（仅使用本机隔离测试数据库）：

```powershell
python scripts/backend_local_env.py test --run 'TestStaffBlocks|TestContactManagement|TestOrdinaryContact'
```

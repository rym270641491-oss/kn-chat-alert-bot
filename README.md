# KN Chat 告警分析机器人原型

这个版本持续接收两个告警群的消息并写入本地 JSON。每日报告固定统计上海时区“前一天 19:00:00 之后至当天 19:00:00（含）”发生的事件；自动报告默认在 19:02 发送，给 long polling 两分钟把边界消息写入 JSON：

1. 基础设施告警群：解析 `cn`、`ident`、`interface`、`src` 等标签；统计分组优先取 `job`，没有 `job` 时回退到 `src`。
2. 应用组件告警群：解析 `group`、`instance`、`job` 等标签，按 `job` 分组。
3. 识别消息中的“告警触发”和“告警恢复”，用同一组标签匹配恢复状态。
4. 每个 `job` 按小时统计告警次数、未恢复次数、峰值时段和告警内容状态；日报默认展开每个群告警次数最多的 Top 3 个 `job`。
5. 报告发送成功后只记录该截止点已发送，不清理本日报原始事件；事件默认保留 7 天，便于手动按日期重算。

## 运行要求

- Node.js 18 或更高版本（使用内置 `fetch`，无第三方依赖）。
- 机器人已经加入三个群：两个来源群和数据平台部汇报群。
- 如果要读取来源群里的普通消息，在 BotFather 中将 `Group Privacy` 设为 `Disable`；否则通常只能收到命令、@、回复和服务消息。
- 同一个 Token 只运行一个 `getUpdates` 消费者。

## 配置

服务只读取进程环境变量；`.env.example` 仅作为配置模板。

```bash
export BOT_API_BASE='https://bot.kn.chat'
export BOT_TOKEN='<你的机器人 Token>'
export INFRASTRUCTURE_CHAT_ID='<基础设施告警群 chat_id>'
export APPLICATION_CHAT_ID='<应用组件告警群 chat_id>'
export REPORT_CHAT_ID='<数据平台部群 chat_id>'
export REPORT_TIMEZONE='Asia/Shanghai'
```

可选配置：

```bash
export REPORT_HOUR='19'
export REPORT_MINUTE='0'
export REPORT_GRACE_MINUTES='2'
export REPORT_RETENTION_DAYS='7'
export REPORT_CHECK_INTERVAL_MS='15000'
export OFFSET_FILE='./data/offset.json'
export ALERT_STATE_FILE='./data/alert-state.json'
```

群 ID 应从 `getUpdates` 返回的 `message.chat.id` 获取。三个群的 ID 必须分别配置，机器人只会解析两个来源群，不会把汇报群中的消息当作告警事件。

## 启动

```bash
npm start
```

## macOS 登录自动启动

项目提供了 LaunchAgent 模板：

- [start-alert-bot.sh](service/start-alert-bot.sh)：读取外部环境文件并启动 Node 服务；
- [com.iris.kn-chat-alert-bot.plist.example](service/com.iris.kn-chat-alert-bot.plist.example)：登录自动启动和异常自动拉起配置；
- [kn-chat-alert-bot.env.example](service/kn-chat-alert-bot.env.example)：Token 和群 ID 配置模板。

先把配置文件放到项目目录之外，并限制权限：

```bash
mkdir -p /Users/iris.y.ran/.config
cp '/Users/iris.y.ran/告警机器人/service/kn-chat-alert-bot.env.example' \
  /Users/iris.y.ran/.config/kn-chat-alert-bot.env
chmod 600 /Users/iris.y.ran/.config/kn-chat-alert-bot.env
```

编辑外部配置文件，填入真实 Token 和三个群 ID。然后安装 LaunchAgent：

```bash
mkdir -p /Users/iris.y.ran/Library/LaunchAgents
cp '/Users/iris.y.ran/告警机器人/service/com.iris.kn-chat-alert-bot.plist.example' \
  /Users/iris.y.ran/Library/LaunchAgents/com.iris.kn-chat-alert-bot.plist

launchctl bootstrap gui/$(id -u) \
  /Users/iris.y.ran/Library/LaunchAgents/com.iris.kn-chat-alert-bot.plist
launchctl kickstart -k gui/$(id -u)/com.iris.kn-chat-alert-bot
```

查看运行状态和日志：

```bash
launchctl print gui/$(id -u)/com.iris.kn-chat-alert-bot
tail -f '/Users/iris.y.ran/告警机器人/data/launchd.stdout.log'
tail -f '/Users/iris.y.ran/告警机器人/data/launchd.stderr.log'
```

停止自动启动：

```bash
launchctl bootout gui/$(id -u)/com.iris.kn-chat-alert-bot
```

启动时先调用 `getMe` 校验 Token，然后使用 KN Chat 的 long polling 接口接收消息：

```text
GET  https://bot.kn.chat/bot{BOT_TOKEN}/getUpdates
POST https://bot.kn.chat/bot{BOT_TOKEN}/sendMessage
```

每日汇报的发送目标是 `REPORT_CHAT_ID`，发送内容使用 `reply_to_message_id` 的部分只用于 `/start` 回复；日报本身不回复某条告警消息。

## 统计口径

- “本时段事件”：固定窗口内的全部事件数，并分别列出触发、恢复和未解析数量。
- “触发次数”：固定窗口内的“告警触发”事件数；恢复事件不重复计为触发。
- “未恢复”：截至本次报告截止时间，仍未匹配到恢复事件的触发数。
- 恢复匹配键：来源群 + 告警名称 + 全部标签。这样同一 `job` 下不同实例或节点不会互相错误抵消。
- “峰值时段”：按告警文本中的触发时间/恢复时间所在的小时统计，取触发次数最多的小时；并列时取较早时段。
- “告警内容”：同一 `job` 下，按告警名称统计触发、匹配恢复和未恢复次数。
- “Top 3”：每个来源群按 `job` 的触发总数降序展开 3 个分组；其余分组只显示汇总，不展开小时和告警内容。
- 时间窗口固定为 `(前一天 19:00:00, 当天 19:00:00]`。优先使用告警正文中的“触发时间”或“恢复时间”归属窗口；正文缺少可解析时间时才回退到机器人接收时间。因此，18:59 发生但 19:03 才被拉取的消息，仍会进入当天 19:00 截止的日报。
- 基础设施示例没有 `job` 标签，因此会用 `src`（例如 `starrocks`）作为分组名。

报告大致如下：

```text
【告警分析汇报】
读取时段：2026-08-20 19:00 至 2026-08-21 19:00

一、基础设施告警
📊 本时段总数：7次告警，未恢复2次

1. job：starrocks
   📊 总数：7次告警，未恢复2次
   🔍 统计分析：
   • 峰值时段：17:00-18:00（5次）
   • 小时分布：17:00-18:00 (5次)、18:00-19:00 (2次)
   • 告警内容：带宽过高（触发5次、恢复3次、未恢复2次）、磁盘使用率过高（触发2次、恢复2次、未恢复0次）

二、应用组件告警
📊 本时段总数：110次告警，未恢复20次

1. job：cn-starrocks-new
   📊 总数：110次告警，未恢复20次
   🔍 统计分析：
   • 峰值时段：17:00-18:00（88次）
   • 小时分布：17:00-18:00 (88次)、18:00-19:00 (22次)
   • 告警内容：sr查询超时队列告警（触发110次、恢复90次、未恢复20次）
```

如果某个来源群本时段没有新告警，仍会在日报中输出该块并显示“暂无新增告警”。

## 验证

不配置 Chat ID、也不连接 KN Chat 时，可以先用内置样例查看日报文本结构：

```bash
cd '/Users/iris.y.ran/告警机器人'
npm run demo
```

这个命令只在终端打印模拟报告，不读取 Token、不接收真实群消息，也不会发送消息。

如果要模拟多个分组、多次触发/恢复和部分未恢复的复杂场景：

```bash
npm run demo:complex
```

使用已经保存到本地状态文件的事件，手动生成最近一个完整的 19:00–19:00 日报：

```bash
npm run report:local
```

指定报告截止日期可重算任意保留期内日报：

```bash
npm run report -- --date 2026-08-25
```

该命令固定读取 `2026-08-24 19:00:00` 至 `2026-08-25 19:00:00` 的事件。它只读取状态 JSON、输出到终端并保存为 `data/local-report-2026-08-25.txt`，不会读取 Token、不会调用 `sendMessage`、不会修改事件或日报发送记录。

在 CentOS 跳板机上，状态文件不在仓库目录时可显式指定文件路径；以下命令同样不需要 Token：

```bash
cd /root/kn-chat-alert-bot
ALERT_STATE_FILE=/var/lib/kn-chat-alert-bot/alert-state.json \
REPORT_TIMEZONE=Asia/Shanghai \
/usr/local/bin/npm run report -- --date 2026-08-25
```

机器人必须先运行并成功接收告警，状态文件中才会有可统计的事件；KN Chat 不提供群历史消息回放。

工作流需要手动补发到汇报群时，使用一次性发送脚本。它默认拒绝重复发送同一截止日期；`--force` 仅用于人工确认要补发时：

```bash
cd /root/kn-chat-alert-bot
/usr/local/bin/node scripts/send-report.js \
  --env-file /etc/kn-chat-alert-bot.env \
  --date 2026-08-25 \
  --force
```

该命令只会读取跳板机本地的环境文件，不会在工作流字段或日志中打印 Token、群 ID。为避免与常驻机器人同时写 JSON，工作流应在执行前停止服务，并在命令结束后重新启动服务。

19:00 后想立即查看刚入库的告警时，可发送“当前统计日快报”。它展示从当天 19:00 到次日 19:00 的统计周期，但只统计截至命令执行时的数据，并明确标注数据截至时间；它不会标记正式日报已发送，也不会清理 JSON。因此，下一次 19:00 的完整自动日报不受影响：

```bash
cd /root/kn-chat-alert-bot
/usr/local/bin/node scripts/send-report.js \
  --env-file /etc/kn-chat-alert-bot.env \
  --current
```

还没有群 ID 时，可以先只验证 Token 和 KN Chat API：

```bash
cd '/Users/iris.y.ran/告警机器人'
npm run preflight
```

预检命令会自动读取 `/Users/iris.y.ran/.config/kn-chat-alert-bot.env`。成功时会调用 `getMe` 并输出机器人用户名，但不会启动 `getUpdates`，也不会发送群消息。`getMe` 通过后，说明 Token 和 API 地址正常；拿到三个群 ID 后，再启动完整服务验证收消息和日报发送。

```bash
npm test
npm run check
```

目前测试覆盖：

- `/start` 和 `/start@机器人用户名` 识别；
- 来源群白名单和群类型过滤；
- `sendMessage` 回复原消息；
- 告警触发/恢复解析、标签提取和 `job`/`src` 分组；
- 小时统计、重复告警和未恢复匹配；
- 报告时间窗口和 `getUpdates` 长轮询参数。

## 原型边界

- 事件和报告状态暂存本地 `data/alert-state.json`，适合单实例原型；生产环境建议换成数据库或可靠 KV 存储。
- 当前按标签精确匹配触发/恢复；如果告警平台后续增加动态标签，需要再定义哪些标签属于稳定匹配键。
- 当前只做统计分析，不自动推断真正业务根因，也不包含责任人映射。
- 自动日报仅在当天达到 `REPORT_HOUR:REPORT_MINUTE + REPORT_GRACE_MINUTES` 后发送一次；发送失败不会标记已发送，下一次检查会重试同一固定窗口。
- 发送成功后记录该 19:00 截止点，避免自动重复推送；状态 JSON 保留 `REPORT_RETENTION_DAYS` 天事件，手动报告可重复生成且不发送消息。
- 如果需要“每晚从 Git 拉取最新代码”，由 n8n 的定时工作流在 19:00 执行现有的拉取、测试和 `systemctl restart` 节点。默认两分钟缓冲使重启后的服务仍会生成 19:00 截止的日报；若拉取或测试耗时更长，应把 `REPORT_GRACE_MINUTES` 增大到 5。

## 参考文档

- [KN Chat AI 文档索引](https://kn.chat/docs/bot/llms.txt)
- [KN Chat 完整文档包](https://kn.chat/docs/bot/llms-full.txt)
- [快速开始](https://kn.chat/docs/bot/guide/quick-start)
- [接收消息](https://kn.chat/docs/bot/guide/receive-updates)
- [发送消息](https://kn.chat/docs/bot/guide/send-messages)
- [命令与交互](https://kn.chat/docs/bot/guide/commands)

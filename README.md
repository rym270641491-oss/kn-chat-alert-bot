# Nightingale 告警日报机器人

日报不再从 KN Chat 群消息收集告警，而是在生成报告时直接查询 Nightingale 的**历史告警**接口。分类依据是告警平台中的业务组：只查询“基础设施”“应用组件”和“安全生产-实时任务”三个已配置的业务组 ID，不拉取其他业务组告警，也不依赖机器人是否能收到 Bot-to-Bot 消息。

```text
Nightingale 历史告警（按 bgid 服务端过滤）
          │
          ├─ 基础设施业务组
          ├─ 应用组件业务组
          └─ 安全生产-实时任务业务组
          │
          ▼
  生成 19:00–19:00 日报 / 当前统计日快报
          │
          ▼
   KN Chat 汇报群 sendMessage
```

## 运行方式

- **定时日报**：n8n 的 Schedule Trigger 在每天 19:05 触发。它拉取 Git 最新代码、运行测试，然后查询前一天 19:00 至当天 19:00 的三个业务组历史告警并发送一次正式日报。
- **手动快报**：n8n 的 Manual Trigger 随时可执行。19:00 后，它查询当天 19:00 到当前执行时刻的数据；报告会标明“当前统计日快报”，可重复发送，不会占用当晚正式日报的发送记录。
- **人工补发**：使用 `--date YYYY-MM-DD --force`，重新生成对应截止日期的完整日报。

正式日报按截止时间做幂等控制；发送成功后只保存“该截止点已发送”，不保存或删除告警明细。历史数据始终由 Nightingale 提供。

## 配置

从 `service/kn-chat-alert-bot.env.example` 复制到跳板机的 `/etc/kn-chat-alert-bot.env`，权限应为 `600`。真实 Token 只存在该文件中，**不要**填入 Git、n8n 命令字段或日志。

```bash
sudo install -m 600 /dev/null /etc/kn-chat-alert-bot.env
sudo vi /etc/kn-chat-alert-bot.env
```

必须填写：

```dotenv
BOT_TOKEN=<KN Chat 机器人 Token>
REPORT_CHAT_ID=<日报汇报群 ID>

N9E_API_BASE=https://bigdata-alert.kuainiu.io
N9E_TOKEN=<Nightingale 只读 API Token>
N9E_INFRASTRUCTURE_GROUP_ID=<基础设施业务组 ID>
N9E_APPLICATION_GROUP_ID=<应用组件业务组 ID>
N9E_REALTIME_TASK_GROUP_ID=<安全生产-实时任务业务组 ID>
```

`N9E_TOKEN` 应使用只读权限的账号或 Token。脚本只调用 `GET /api/n9e/alert-his-events/list`，每次调用都带 `bgid`，即在服务端限制为一个指定业务组。三个业务组都必须配置有效的数字 ID，否则程序会在发送前失败，避免静默漏掉实时任务告警。

## 手工验证

先验证代码，不需要 Token：

```bash
cd /root/kn-chat-alert-bot
/usr/local/bin/npm test
```

验证当前统计日快报（会发送到汇报群）：

```bash
cd /root/kn-chat-alert-bot
/usr/local/bin/node scripts/send-n9e-report.js \
  --env-file /etc/kn-chat-alert-bot.env \
  --current
```

重新发送某个已结束窗口的日报：

```bash
cd /root/kn-chat-alert-bot
/usr/local/bin/node scripts/send-n9e-report.js \
  --env-file /etc/kn-chat-alert-bot.env \
  --date 2026-08-26 \
  --force
```

## 统计口径

- 窗口为上海时区 `(前一天 19:00, 当天 19:00]`；手动快报从最近一个 19:00 截止点统计到执行时刻。
- Nightingale 的一条历史事件会按其 `first_trigger_time` 计为一次触发；若已恢复且 `recover_time` 在窗口内，则再计为一次恢复。
- “未恢复”表示该窗口内触发、截至报告数据截止点尚未恢复的事件。
- 事件以 Nightingale 的事件 ID（无 ID 时使用 hash）去重，避免列表重复行导致重复统计。
- 报告按告警内容全部展开；`job` 只作为每条告警内容的辅助维度展示，不再按 Top 3 job 截断。
- 三个报告来源的分类以 Nightingale 历史事件所属业务组为准，不根据规则名或标签猜测来源。

## 迁移说明

旧版常驻 `getUpdates` 服务依赖群消息接收，会受到 Bot Privacy 和 Bot-to-Bot 限制；新日报流程不需要它。确认新的手动快报已在汇报群正确发送后，再停用旧服务，避免 19:00 出现两份日报：

```bash
sudo systemctl disable --now kn-chat-alert-bot.service
```

这一步会停止旧的群消息轮询程序；新的定时日报由 n8n 的 Schedule Trigger 执行，无需常驻 Node.js 服务。

## 开发验证

```bash
npm test
npm run check
```

测试覆盖历史告警接口参数、业务组服务端过滤、分页、平台事件去重、正式日报和手动快报的窗口语义；不会连接真实 Nightingale 或 KN Chat，也不会读取 Token。

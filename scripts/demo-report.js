'use strict'

const {
  buildDailyReport,
  parseAlertMessage,
  parseLocalTimestamp
} = require('../alert-report')

const timeZone = 'Asia/Shanghai'
const from = parseLocalTimestamp('2026-08-20 19:00:00', timeZone)
const to = parseLocalTimestamp('2026-08-21 19:00:00', timeZone)

const infrastructureMessages = [
  [
    '### 💔 告警触发：带宽过高',
    '',
    '告警级别: 3级',
    '触发时间: 2026-08-21 17:10:00',
    '标签:',
    '  cn: `ina`',
    '  ident: `ina-bigdata-sr-be-01-0005`',
    '  interface: `eth0`',
    '  src: `starrocks`'
  ].join('\n'),
  [
    '### 💚 告警恢复：带宽过高',
    '',
    '告警级别: 3级',
    '恢复时间: 2026-08-21 17:11:00',
    '标签:',
    '  cn: `ina`',
    '  ident: `ina-bigdata-sr-be-01-0005`',
    '  interface: `eth0`',
    '  src: `starrocks`'
  ].join('\n'),
  [
    '### 💔 告警触发：带宽过高',
    '',
    '告警级别: 3级',
    '触发时间: 2026-08-21 17:25:00',
    '标签:',
    '  cn: `ina`',
    '  ident: `ina-bigdata-sr-be-01-0005`',
    '  interface: `eth0`',
    '  src: `starrocks`'
  ].join('\n'),
  [
    '### 💔 告警触发：磁盘使用率过高',
    '',
    '告警级别: 2级',
    '触发时间: 2026-08-21 18:05:00',
    '标签:',
    '  cn: `mx`',
    '  ident: `mx-bigdata-sr-fe-01`',
    '  interface: `disk0`',
    '  src: `starrocks`'
  ].join('\n')
]

const applicationMessages = [
  ['2026-08-21 17:05:00', 'cn-starrocks-new', 'sr查询超时队列告警', 'trigger'],
  ['2026-08-21 17:06:00', 'cn-starrocks-new', 'sr查询超时队列告警', 'recovery'],
  ['2026-08-21 17:15:00', 'cn-starrocks-new', 'sr查询超时队列告警', 'trigger'],
  ['2026-08-21 17:16:00', 'cn-starrocks-new', 'sr查询超时队列告警', 'recovery'],
  ['2026-08-21 17:25:00', 'cn-starrocks-new', 'sr查询超时队列告警', 'trigger'],
  ['2026-08-21 17:35:00', 'cn-starrocks-new', 'sr查询超时队列告警', 'trigger'],
  ['2026-08-21 18:10:00', 'cn-starrocks-new', '内存使用超限', 'trigger'],
  ['2026-08-21 18:20:00', 'cn-starrocks-backup', 'sr查询超时队列告警', 'trigger']
].map(([time, job, alertName, status]) => [
  [
    `### ${status === 'trigger' ? '💔 告警触发' : '💚 告警恢复'}：${alertName}`,
    '',
    '告警级别: 2级',
    `${status === 'trigger' ? '触发时间' : '恢复时间'}: ${time}`,
    '标签:',
    '  group: `fe`',
    '  instance: `10.20.48.11:8030`',
    `  job: \`${job}\``
  ].join('\n'),
  time,
  job
])

const events = []
for (const [index, text] of infrastructureMessages.entries()) {
  events.push(
    ...parseAlertMessage(text, {
      source: 'infrastructure',
      sourceChatId: '-demo-infrastructure',
      messageId: index + 1,
      receivedAt: `2026-08-21T${String(9 + Math.floor(index / 2)).padStart(2, '0')}:${String(index * 5).padStart(2, '0')}:00.000Z`,
      timeZone
    })
  )
}

for (const [index, [text, time]] of applicationMessages.entries()) {
  events.push(
    ...parseAlertMessage(text, {
      source: 'application',
      sourceChatId: '-demo-application',
      messageId: index + 1,
      receivedAt: parseLocalTimestamp(time, timeZone).toISOString(),
      timeZone
    })
  )
}

console.log(buildDailyReport({ events, from, to, timeZone }))

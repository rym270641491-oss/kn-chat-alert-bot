'use strict'

const {
  buildDailyReport,
  parseAlertMessage,
  parseLocalTimestamp
} = require('../alert-report')

const timeZone = 'Asia/Shanghai'
const from = parseLocalTimestamp('2026-08-20 19:00:00', timeZone)
const to = parseLocalTimestamp('2026-08-21 19:00:00', timeZone)
let nextMessageId = 1
const events = []

function alertText({ status, name, time, level = '2级', labels }) {
  const lines = [
    `### ${status === 'trigger' ? '💔 告警触发' : '💚 告警恢复'}：${name}`,
    '',
    `告警级别: ${level}`,
    `${status === 'trigger' ? '触发时间' : '恢复时间'}: ${time}`,
    '标签:'
  ]

  for (const [key, value] of Object.entries(labels)) {
    lines.push(`  ${key}: \`${value}\``)
  }
  return lines.join('\n')
}

function addEvent({ source, chatId, status, name, time, level, labels }) {
  events.push(
    ...parseAlertMessage(
      alertText({ status, name, time, level, labels }),
      {
        source,
        sourceChatId: chatId,
        messageId: nextMessageId++,
        receivedAt: parseLocalTimestamp(time, timeZone).toISOString(),
        timeZone
      }
    )
  )
}

function addPair({ source, chatId, name, trigger, recovery, level, labels }) {
  addEvent({ source, chatId, status: 'trigger', name, time: trigger, level, labels })
  if (recovery) {
    addEvent({ source, chatId, status: 'recovery', name, time: recovery, level, labels })
  }
}

const infrastructureChatId = '-demo-infrastructure'
const applicationChatId = '-demo-application'

// 基础设施群：没有 job 标签时，代码使用 src 作为分组名。
const inaLabels = {
  cn: 'ina',
  ident: 'ina-bigdata-sr-be-01-0005',
  interface: 'eth0',
  src: 'starrocks-ina'
}
addPair({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  name: '带宽过高',
  trigger: '2026-08-21 17:05:00',
  recovery: '2026-08-21 17:06:00',
  level: '3级',
  labels: inaLabels
})
addPair({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  name: '带宽过高',
  trigger: '2026-08-21 17:10:00',
  recovery: '2026-08-21 17:11:00',
  level: '3级',
  labels: inaLabels
})
addEvent({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  status: 'trigger',
  name: '磁盘使用率过高',
  time: '2026-08-21 18:15:00',
  labels: { ...inaLabels, interface: 'disk0' }
})
addEvent({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  status: 'trigger',
  name: '内存使用率过高',
  time: '2026-08-21 16:30:00',
  labels: { ...inaLabels, interface: 'memory' }
})

const mxLabels = {
  cn: 'mx',
  ident: 'mx-bigdata-sr-fe-01',
  interface: 'eth0',
  src: 'starrocks-mx'
}
addPair({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  name: 'CPU使用率过高',
  trigger: '2026-08-21 11:20:00',
  recovery: '2026-08-21 11:25:00',
  labels: mxLabels
})
addEvent({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  status: 'trigger',
  name: '网络丢包',
  time: '2026-08-21 14:10:00',
  labels: mxLabels
})
addPair({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  name: '网络丢包',
  trigger: '2026-08-21 14:20:00',
  recovery: '2026-08-21 14:25:00',
  labels: mxLabels
})

const kafkaLabels = {
  cn: 'cn',
  ident: 'kafka-broker-01',
  interface: 'broker',
  src: 'kafka'
}
addPair({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  name: '消费延迟过高',
  trigger: '2026-08-21 09:05:00',
  recovery: '2026-08-21 09:08:00',
  labels: kafkaLabels
})
addEvent({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  status: 'trigger',
  name: '消费延迟过高',
  time: '2026-08-21 09:20:00',
  labels: kafkaLabels
})
addEvent({
  source: 'infrastructure',
  chatId: infrastructureChatId,
  status: 'trigger',
  name: '消费延迟过高',
  time: '2026-08-21 13:10:00',
  labels: kafkaLabels
})

function addApplicationAlert({ status = 'trigger', name, time, job, instance = '10.20.48.11:8030' }) {
  addEvent({
    source: 'application',
    chatId: applicationChatId,
    status,
    name,
    time,
    labels: {
      group: 'fe',
      instance,
      job
    }
  })
}

// 应用组件群：cn-starrocks-new 是告警最多的 job，同时包含已恢复和未恢复告警。
const mainJob = 'cn-starrocks-new'
addApplicationAlert({ name: 'sr查询超时队列告警', time: '2026-08-21 17:00:00', job: mainJob })
addApplicationAlert({ status: 'recovery', name: 'sr查询超时队列告警', time: '2026-08-21 17:03:00', job: mainJob })
addApplicationAlert({ name: 'sr查询超时队列告警', time: '2026-08-21 17:05:00', job: mainJob })
addApplicationAlert({ status: 'recovery', name: 'sr查询超时队列告警', time: '2026-08-21 17:07:00', job: mainJob })
addApplicationAlert({ name: 'sr查询超时队列告警', time: '2026-08-21 17:15:00', job: mainJob })
addApplicationAlert({ name: '内存使用超限', time: '2026-08-21 17:20:00', job: mainJob })
addApplicationAlert({ status: 'recovery', name: '内存使用超限', time: '2026-08-21 17:25:00', job: mainJob })
addApplicationAlert({ name: '内存使用超限', time: '2026-08-21 17:30:00', job: mainJob })
addApplicationAlert({ name: '查询失败率过高', time: '2026-08-21 18:10:00', job: mainJob })

const backupJob = 'cn-starrocks-backup'
addApplicationAlert({ name: 'sr查询超时队列告警', time: '2026-08-21 10:05:00', job: backupJob })
addApplicationAlert({ status: 'recovery', name: 'sr查询超时队列告警', time: '2026-08-21 10:07:00', job: backupJob })
addApplicationAlert({ name: 'sr查询超时队列告警', time: '2026-08-21 10:15:00', job: backupJob })
addApplicationAlert({ status: 'recovery', name: 'sr查询超时队列告警', time: '2026-08-21 10:17:00', job: backupJob })
addApplicationAlert({ name: '磁盘使用率过高', time: '2026-08-21 10:25:00', job: backupJob })
addApplicationAlert({ status: 'recovery', name: '磁盘使用率过高', time: '2026-08-21 10:30:00', job: backupJob })

const mxJob = 'mx-starrocks-new'
addApplicationAlert({ name: '内存使用超限', time: '2026-08-21 14:00:00', job: mxJob })
addApplicationAlert({ name: '内存使用超限', time: '2026-08-21 14:10:00', job: mxJob })
addApplicationAlert({ name: '磁盘使用率过高', time: '2026-08-21 15:05:00', job: mxJob })
addApplicationAlert({ status: 'recovery', name: '磁盘使用率过高', time: '2026-08-21 15:06:00', job: mxJob })

console.log('【复杂场景离线模拟】')
console.log('基础设施告警群：3 个分组，10 次触发，包含多次恢复和未恢复告警')
console.log('应用组件告警群：3 个 job，12 次触发，包含多次恢复和未恢复告警')
console.log('')
console.log(buildDailyReport({ events, from, to, timeZone }))

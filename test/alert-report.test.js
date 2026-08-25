'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  AlertStateStore,
  aggregateSource,
  buildDailyReport,
  getCurrentReportWindowIfDue,
  getCurrentReportingWindow,
  getLatestReportCutoff,
  getLatestCompletedReportWindow,
  getReportWindowForDate,
  parseAlertMessage
} = require('../alert-report')

const infraText = [
  '### 💔 告警触发：带宽过高',
  '',
  '告警级别: 3级',
  '触发时间: 2026-08-21 17:15:00',
  '标签:',
  '  cn: `ina`',
  '  ident: `ina-bigdata-sr-be-01-0005`',
  '  interface: `eth0`',
  '  src: `starrocks`',
  '',
  '### 💚 告警恢复：带宽过高',
  '',
  '告警级别: 3级',
  '恢复时间: 2026-08-21 17:16:00',
  '标签:',
  '  cn: `ina`',
  '  ident: `ina-bigdata-sr-be-01-0005`',
  '  interface: `eth0`',
  '  src: `starrocks`'
].join('\n')

function applicationText(time, job = 'cn-starrocks-new') {
  return [
    '### 💔 告警触发：sr查询超时队列告警',
    '',
    '告警级别: 2级',
    `触发时间: ${time}`,
    '标签:',
    '  group: `fe`',
    '  instance: `10.20.48.11:8030`',
    `  job: \`${job}\``
  ].join('\n')
}

function applicationRecoveryText(time, job = 'cn-starrocks-new') {
  return [
    '### 💚 告警恢复：sr查询超时队列告警',
    '',
    '告警级别: 2级',
    `恢复时间: ${time}`,
    '标签:',
    '  group: `fe`',
    '  instance: `10.20.48.11:8030`',
    `  job: \`${job}\``
  ].join('\n')
}

const realInfrastructureText = [
  'alertbot, [Aug 21, 2026 at 17:12:07]:',
  '',
  '### 💔 告警触发：磁盘存储利用率80%',
  '',
  '告警级别: 2级',
  '持续时长: 0s',
  '触发时间: 2026-08-21 17:12:06',
  '当前数值: 80.53339',
  '告警阈值: 80',
  '查询指标: disk\\_used\\_percent{ident',
  '标签:',
  '\u00a0 cn: `mex`',
  '\u00a0 device: `vda1`',
  '\u00a0 fstype: `ext4`',
  '\u00a0 ident: `gateway-4-1.c-dcd118dc4de41971`',
  '\u00a0 mode: `rw`',
  '\u00a0 path: `/`',
  '\u00a0 src: `dolphin`',
  '',
  '### 💚 告警恢复：磁盘存储利用率80%',
  '',
  '告警级别: 2级',
  '持续时长: 5m 0s',
  '恢复时间: 2026-08-21 17:17:06',
  '查询指标: disk\\_used\\_percent{ident',
  '标签:',
  '\u00a0 cn: `mex`',
  '\u00a0 device: `vda1`',
  '\u00a0 fstype: `ext4`',
  '\u00a0 ident: `gateway-4-1.c-dcd118dc4de41971`',
  '\u00a0 mode: `rw`',
  '\u00a0 path: `/`',
  '\u00a0 src: `dolphin`'
].join('\n')

const repeatedApplicationRecoveriesText = [
  applicationRecoveryText('2026-08-21 16:07:41', 'cn-starrocks-new'),
  applicationRecoveryText('2026-08-21 16:07:41', 'cn-starrocks-new'),
  [
    '### 💚 告警恢复：sr查询超时队列告警',
    '',
    '告警级别: 2级',
    '恢复时间: 2026-08-21 16:07:41',
    '查询指标: rate(starrocks\\_fe\\_query\\_queue\\_timeout[1m])',
    '标签:',
    '  cn: `china`',
    '  group: `fe`',
    '  ident: `cn-bigdata-sr-fe02`',
    '  instance: `10.20.48.11:8030`',
    '  job: `cn_sr`',
    '  src: `starrocks`'
  ].join('\n')
].join('\n\n')

test('解析基础设施和应用组件告警格式', () => {
  const infraEvents = parseAlertMessage(infraText, {
    source: 'infrastructure',
    sourceChatId: '-1001',
    messageId: 1,
    receivedAt: '2026-08-21T09:30:00.000Z'
  })
  const appEvents = parseAlertMessage(applicationText('2026-08-21 17:20:00'), {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 2,
    receivedAt: '2026-08-21T09:40:00.000Z'
  })

  assert.equal(infraEvents.length, 2)
  assert.equal(infraEvents[0].status, 'trigger')
  assert.equal(infraEvents[1].status, 'recovery')
  assert.equal(infraEvents[0].job, 'starrocks')
  assert.equal(infraEvents[0].labels.ident, 'ina-bigdata-sr-be-01-0005')
  assert.equal(appEvents[0].job, 'cn-starrocks-new')
  assert.equal(appEvents[0].labels.instance, '10.20.48.11:8030')
})

test('解析真实消息前缀、非标准空格和同消息多个告警区块', () => {
  const infrastructureEvents = parseAlertMessage(realInfrastructureText, {
    source: 'infrastructure',
    sourceChatId: '-1001',
    messageId: 20,
    receivedAt: '2026-08-21T09:20:00.000Z'
  })
  const applicationEvents = parseAlertMessage(repeatedApplicationRecoveriesText, {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 21,
    receivedAt: '2026-08-21T08:20:00.000Z'
  })

  assert.equal(infrastructureEvents.length, 2)
  assert.equal(infrastructureEvents[0].status, 'trigger')
  assert.equal(infrastructureEvents[1].status, 'recovery')
  assert.equal(infrastructureEvents[0].job, 'dolphin')
  assert.equal(infrastructureEvents[0].labels.path, '/')
  assert.equal(applicationEvents.length, 3)
  assert.equal(applicationEvents[0].job, 'cn-starrocks-new')
  assert.equal(applicationEvents[2].job, 'cn_sr')
})

test('按 job、小时和未恢复状态聚合', () => {
  const events = [
    ...parseAlertMessage(infraText, {
      source: 'infrastructure',
      sourceChatId: '-1001',
      messageId: 1,
      receivedAt: '2026-08-21T09:30:00.000Z'
    }),
    ...parseAlertMessage(applicationText('2026-08-21 17:20:00'), {
      source: 'application',
      sourceChatId: '-1002',
      messageId: 2,
      receivedAt: '2026-08-21T09:40:00.000Z'
    }),
    ...parseAlertMessage(applicationText('2026-08-21 17:25:00'), {
      source: 'application',
      sourceChatId: '-1002',
      messageId: 3,
      receivedAt: '2026-08-21T09:50:00.000Z'
    })
  ]

  const aggregate = aggregateSource(
    events.filter((event) => event.source === 'application'),
    new Date('2026-08-21T09:00:00.000Z'),
    new Date('2026-08-21T10:00:00.000Z'),
    'Asia/Shanghai'
  )

  assert.equal(aggregate.total, 2)
  assert.equal(aggregate.unrecovered, 2)
  assert.equal(aggregate.groups.length, 1)
  assert.equal(aggregate.groups[0].job, 'cn-starrocks-new')
  assert.equal(aggregate.groups[0].hours[0][0], '17:00-18:00')
  assert.deepEqual(aggregate.groups[0].alertNames, [['sr查询超时队列告警', 2]])
})

test('多个相同指纹的触发和恢复按队列一一匹配', () => {
  const messageDefinitions = [
    [applicationText('2026-08-21 17:05:00'), 1, '2026-08-21T09:05:00.000Z'],
    [applicationText('2026-08-21 17:06:00'), 2, '2026-08-21T09:06:00.000Z'],
    [applicationRecoveryText('2026-08-21 17:07:00'), 3, '2026-08-21T09:07:00.000Z'],
    [applicationRecoveryText('2026-08-21 17:08:00'), 4, '2026-08-21T09:08:00.000Z'],
    [applicationText('2026-08-21 17:09:00'), 5, '2026-08-21T09:09:00.000Z']
  ]
  const events = messageDefinitions.flatMap(([text, messageId, receivedAt]) =>
    parseAlertMessage(text, {
      source: 'application',
      sourceChatId: '-1002',
      messageId,
      receivedAt
    })
  )

  const aggregate = aggregateSource(
    events,
    new Date('2026-08-20T11:00:00.000Z'),
    new Date('2026-08-21T11:00:00.000Z'),
    'Asia/Shanghai'
  )

  assert.equal(aggregate.total, 3)
  assert.equal(aggregate.unrecovered, 1)
  assert.equal(aggregate.groups[0].job, 'cn-starrocks-new')
  assert.equal(aggregate.groups[0].hours[0][0], '17:00-18:00')
})

test('告警内容输出触发、恢复和未恢复数量', () => {
  const events = [
    ...parseAlertMessage(applicationText('2026-08-21 16:05:00'), {
      source: 'application',
      sourceChatId: '-1002',
      messageId: 11,
      receivedAt: '2026-08-21T08:05:00.000Z'
    }),
    ...parseAlertMessage(applicationRecoveryText('2026-08-21 16:07:00'), {
      source: 'application',
      sourceChatId: '-1002',
      messageId: 12,
      receivedAt: '2026-08-21T08:07:00.000Z'
    }),
    ...parseAlertMessage(applicationText('2026-08-21 17:05:00'), {
      source: 'application',
      sourceChatId: '-1002',
      messageId: 13,
      receivedAt: '2026-08-21T09:05:00.000Z'
    })
  ]
  const report = buildDailyReport({
    events,
    from: new Date('2026-08-20T11:00:00.000Z'),
    to: new Date('2026-08-21T11:00:00.000Z'),
    timeZone: 'Asia/Shanghai'
  })

  assert.match(report, /sr查询超时队列告警（触发2次、恢复1次、未恢复1次）/)
})

test('日报展示恢复和未解析告警，避免只按触发显示为零', () => {
  const recoveryOnly = parseAlertMessage(applicationRecoveryText('2026-08-21 16:07:00'), {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 12,
    receivedAt: '2026-08-21T08:07:00.000Z'
  })
  const unparsed = {
    eventId: '-1002:13:unparsed',
    source: 'application',
    sourceChatId: '-1002',
    messageId: 13,
    status: 'unparsed',
    alertName: '格式变化的告警消息',
    job: '未解析',
    labels: {},
    receivedAt: '2026-08-21T08:08:00.000Z',
    occurredAt: '2026-08-21T08:08:00.000Z'
  }

  const report = buildDailyReport({
    events: [...recoveryOnly, unparsed],
    from: new Date('2026-08-20T11:00:00.000Z'),
    to: new Date('2026-08-21T11:00:00.000Z'),
    timeZone: 'Asia/Shanghai'
  })

  assert.match(report, /本时段事件：2条（触发0次、恢复1次、未解析1次）/)
  assert.match(
    report,
    /二、应用组件告警\n📊 本时段事件：2条（触发0次、恢复1次、未解析1次）/
  )
})

test('日报每个来源只展开告警最多的 Top 3 job', () => {
  const jobs = [
    ['job-a', 4],
    ['job-b', 3],
    ['job-c', 2],
    ['job-d', 1]
  ]
  const events = jobs.flatMap(([job, count], jobIndex) =>
    Array.from({ length: count }, (_, index) =>
      parseAlertMessage(
        applicationText(
          `2026-08-21 ${String(10 + jobIndex).padStart(2, '0')}:${String(index).padStart(2, '0')}:00`,
          job
        ),
        {
          source: 'application',
          sourceChatId: '-1002',
          messageId: 100 + jobIndex * 10 + index,
          receivedAt: `2026-08-21T${String(2 + jobIndex).padStart(2, '0')}:${String(index).padStart(2, '0')}:00.000Z`
        }
      )
    ).flat()
  )
  const report = buildDailyReport({
    events,
    from: new Date('2026-08-20T11:00:00.000Z'),
    to: new Date('2026-08-21T11:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
    topN: 3
  })

  assert.match(report, /1\. job：job-a/)
  assert.match(report, /2\. job：job-b/)
  assert.match(report, /3\. job：job-c/)
  assert.doesNotMatch(report, /job：job-d/)
  assert.match(report, /其余 1 个 job 未展开：job-d；合计1条事件，未恢复1次/)
})

test('日报成功后保留可重算的窗口事件，只清理超出保留期的数据', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kn-chat-alert-state-'))
  const filename = path.join(directory, 'alert-state.json')
  const state = {
    lastReportAt: '2026-08-20T11:00:00.000Z',
    events: [
      { eventId: 'expired', occurredAt: '2026-08-13T10:59:59.000Z' },
      { eventId: 'before', occurredAt: '2026-08-21T10:59:59.000Z' },
      { eventId: 'at-cutoff', occurredAt: '2026-08-21T11:00:00.000Z' },
      { eventId: 'after', occurredAt: '2026-08-21T11:00:01.000Z' }
    ]
  }

  try {
    const store = new AlertStateStore(filename, state)
    await store.initialize()
    const cutoff = new Date('2026-08-21T11:00:00.000Z')
    const removed = await store.finalizeReport(cutoff, 7)
    assert.equal(removed, 1)
    assert.equal(state.lastReportAt, '2026-08-21T11:00:00.000Z')
    assert.equal(store.hasSentReport(cutoff), true)
    assert.deepEqual(state.events.map((event) => event.eventId), [
      'before',
      'at-cutoff',
      'after'
    ])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('固定日报窗口按告警正文发生时间归属，延迟拉取后仍可重算', () => {
  const events = parseAlertMessage(applicationText('2026-08-25 18:39:53'), {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 42,
    // 机器人在 19:05 才拉到这条 18:39 的消息。
    receivedAt: '2026-08-25T11:05:00.000Z'
  })
  const window = getReportWindowForDate('2026-08-25', 19, 0, 'Asia/Shanghai')
  const aggregate = aggregateSource(events, window.from, window.to, 'Asia/Shanghai')

  assert.equal(aggregate.receivedTotal, 1)
  assert.equal(aggregate.total, 1)
  assert.equal(aggregate.groups[0].job, 'cn-starrocks-new')
})

test('日报包含两个来源块和时间范围', () => {
  const report = buildDailyReport({
    events: [],
    from: new Date('2026-08-20T11:00:00.000Z'),
    to: new Date('2026-08-21T11:00:00.000Z'),
    timeZone: 'Asia/Shanghai'
  })

  assert.match(report, /读取时段：2026-08-20 19:00 至 2026-08-21 19:00/)
  assert.match(report, /一、基础设施告警/)
  assert.match(report, /二、应用组件告警/)
  assert.match(report, /暂无接收的告警事件/)
})

test('按 Asia/Shanghai 计算最近一个 19:00 截止点', () => {
  const cutoff = getLatestReportCutoff(
    new Date('2026-08-21T12:00:00.000Z'),
    19,
    0,
    'Asia/Shanghai'
  )
  assert.equal(cutoff.toISOString(), '2026-08-21T11:00:00.000Z')
})

test('手动日报默认最近完整窗口，自动日报在缓冲期后才发送当日窗口', () => {
  const beforeCutoff = getLatestCompletedReportWindow(
    new Date('2026-08-25T10:59:59.000Z'),
    19,
    0,
    'Asia/Shanghai'
  )
  const afterCutoff = getLatestCompletedReportWindow(
    new Date('2026-08-25T11:00:00.000Z'),
    19,
    0,
    'Asia/Shanghai'
  )
  const inGracePeriod = getCurrentReportWindowIfDue(
    new Date('2026-08-25T11:01:59.000Z'),
    19,
    0,
    'Asia/Shanghai',
    2
  )
  const due = getCurrentReportWindowIfDue(
    new Date('2026-08-25T11:02:00.000Z'),
    19,
    0,
    'Asia/Shanghai',
    2
  )

  assert.equal(beforeCutoff.reportDate, '2026-08-24')
  assert.equal(afterCutoff.reportDate, '2026-08-25')
  assert.equal(inGracePeriod, null)
  assert.equal(due.reportDate, '2026-08-25')
  assert.equal(due.from.toISOString(), '2026-08-24T11:00:00.000Z')
  assert.equal(due.to.toISOString(), '2026-08-25T11:00:00.000Z')
})

test('当前统计日快报在 19:00 后展示次日截止点，但只统计截至执行时的数据', () => {
  const window = getCurrentReportingWindow(
    new Date('2026-08-25T12:15:00.000Z'),
    19,
    0,
    'Asia/Shanghai'
  )
  const events = parseAlertMessage(applicationText('2026-08-25 20:11:53'), {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 99,
    receivedAt: '2026-08-25T12:11:53.000Z'
  })
  const report = buildDailyReport({
    events,
    from: window.from,
    to: window.to,
    asOf: new Date('2026-08-25T12:15:00.000Z'),
    timeZone: 'Asia/Shanghai'
  })

  assert.equal(window.from.toISOString(), '2026-08-25T11:00:00.000Z')
  assert.equal(window.to.toISOString(), '2026-08-26T11:00:00.000Z')
  assert.match(report, /读取时段：2026-08-25 19:00 至 2026-08-26 19:00/)
  assert.match(report, /数据截至：2026-08-25 20:15（当前统计日快报，非完整日报）/)
  assert.match(report, /sr查询超时队列告警/)
})

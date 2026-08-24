'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const {
  buildDailyReport,
  formatDate,
  loadAlertState,
  parseLocalTimestamp
} = require('../alert-report')

async function main() {
  const timeZone = String(process.env.REPORT_TIMEZONE || 'Asia/Shanghai')
  const stateFile = String(process.env.ALERT_STATE_FILE || './data/alert-state.json')
  const now = new Date()
  const today = formatDate(now, timeZone)
  const from = parseLocalTimestamp(`${today} 00:00:00`, timeZone)
  const to = now
  const state = await loadAlertState(stateFile)
  const report = buildDailyReport({
    events: state.events,
    from,
    to,
    timeZone
  })

  const outputFile = path.resolve(
    `./data/local-report-${today}-${String(now.getTime())}.txt`
  )
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, `${report}\n`, 'utf8')

  console.log(report)
  console.log('')
  console.log(`本地报告文件：${outputFile}`)
  console.log(`已读取本地告警事件：${state.events.length} 条`)
  console.log('本次仅本地输出，未调用 sendMessage，也未发送到群聊。')
}

main().catch((error) => {
  console.error(`本地报告生成失败：${error.message}`)
  process.exitCode = 1
})

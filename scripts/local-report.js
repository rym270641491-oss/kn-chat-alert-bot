'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const {
  buildDailyReport,
  getLatestCompletedReportWindow,
  getReportWindowForDate,
  loadAlertState
} = require('../alert-report')

function integerSetting(name, fallback, { min, max }) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function readReportDate(args) {
  let reportDate = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--date') {
      reportDate = args[index + 1]
      index += 1
    } else if (argument.startsWith('--date=')) {
      reportDate = argument.slice('--date='.length)
    } else {
      throw new Error(`unknown option: ${argument}; use --date YYYY-MM-DD`)
    }
  }
  return reportDate
}

async function main() {
  const timeZone = String(process.env.REPORT_TIMEZONE || 'Asia/Shanghai')
  const stateFile = String(process.env.ALERT_STATE_FILE || './data/alert-state.json')
  const reportHour = integerSetting('REPORT_HOUR', 19, { min: 0, max: 23 })
  const reportMinute = integerSetting('REPORT_MINUTE', 0, { min: 0, max: 59 })
  const requestedDate = readReportDate(process.argv.slice(2))
  const now = new Date()
  const window = requestedDate
    ? getReportWindowForDate(requestedDate, reportHour, reportMinute, timeZone)
    : getLatestCompletedReportWindow(now, reportHour, reportMinute, timeZone)
  const state = await loadAlertState(stateFile)
  const report = buildDailyReport({
    events: state.events,
    from: window.from,
    to: window.to,
    timeZone
  })

  const outputFile = path.resolve(
    `./data/local-report-${window.reportDate}.txt`
  )
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, `${report}\n`, 'utf8')

  console.log(report)
  console.log('')
  console.log(`本地报告文件：${outputFile}`)
  console.log(`固定统计窗口：${window.reportDate} 截止，前一日 ${String(reportHour).padStart(2, '0')}:${String(reportMinute).padStart(2, '0')} 至当日 ${String(reportHour).padStart(2, '0')}:${String(reportMinute).padStart(2, '0')}`)
  console.log(`已读取本地告警事件：${state.events.length} 条`)
  console.log('本次仅本地输出，未调用 sendMessage，也未发送到群聊。')
}

main().catch((error) => {
  console.error(`本地报告生成失败：${error.message}`)
  process.exitCode = 1
})

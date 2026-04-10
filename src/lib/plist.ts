import { getStateDir } from './paths.ts'

export interface PlistOptions {
  label: string
  program: string
  programArguments?: string[]
  startInterval?: number // seconds
  startCalendarInterval?: { Hour?: number; Minute?: number }
  environmentVariables?: Record<string, string>
  exitTimeOut?: number // seconds; launchd will SIGKILL the process after this
  logDir?: string // default: stateDir
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function generatePlist(options: PlistOptions): string {
  const logDir = options.logDir ?? getStateDir().replace(/\/$/, '')
  const args = options.programArguments ?? [options.program]

  const argsXml = args
    .map(a => `        <string>${escapeXml(a)}</string>`)
    .join('\n')

  let environmentVariablesXml = ''
  if (options.environmentVariables && Object.keys(options.environmentVariables).length > 0) {
    const entries = Object.entries(options.environmentVariables)
      .map(([k, v]) => `        <key>${escapeXml(k)}</key>\n        <string>${escapeXml(v)}</string>`)
      .join('\n')
    environmentVariablesXml = `    <key>EnvironmentVariables</key>
    <dict>
${entries}
    </dict>`
  }

  let intervalXml = ''
  if (options.startCalendarInterval) {
    const entries: string[] = []
    if (options.startCalendarInterval.Hour !== undefined) {
      entries.push(`        <key>Hour</key>\n        <integer>${options.startCalendarInterval.Hour}</integer>`)
    }
    if (options.startCalendarInterval.Minute !== undefined) {
      entries.push(`        <key>Minute</key>\n        <integer>${options.startCalendarInterval.Minute}</integer>`)
    }
    intervalXml = `    <key>StartCalendarInterval</key>
    <dict>
${entries.join('\n')}
    </dict>`
  } else if (options.startInterval !== undefined) {
    intervalXml = `    <key>StartInterval</key>
    <integer>${options.startInterval}</integer>`
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    ${environmentVariablesXml}
    ${intervalXml}
${options.exitTimeOut !== undefined ? `    <key>ExitTimeOut</key>\n    <integer>${options.exitTimeOut}</integer>\n` : ''}    <key>StandardOutPath</key>
    <string>${escapeXml(logDir)}/${escapeXml(options.label)}-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logDir)}/${escapeXml(options.label)}-stderr.log</string>
</dict>
</plist>
`
}

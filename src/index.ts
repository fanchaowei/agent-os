import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const VERSION = '0.1.0'

function hasCommand(cmd: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', ['/q', cmd], { stdio: 'ignore' })
    } else {
      execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'agent-os', cmd], {
        stdio: 'ignore',
      })
    }
    return true
  } catch {
    return false
  }
}

function check(label: string, ok: boolean, hint: string): void {
  console.log(`  ${ok ? '✅' : '⚠️ '} ${label}${ok ? '' : `  → ${hint}`}`)
}

console.log(`\nAgent OS v${VERSION} — 一个人，一队 Agent\n`)
console.log('环境自检：')

const nodeMajor = Number(process.versions.node.split('.')[0])
check(`Node.js ${process.versions.node}`, nodeMajor >= 22, '需要 Node 22+')
check(
  '.env 配置文件',
  existsSync('.env'),
  '复制 .env.example 为 .env 并填入飞书凭证',
)
check(
  'Claude Code CLI',
  hasCommand('claude'),
  '接入 CLI 前需要安装；无 Anthropic 订阅可使用 DeepSeek',
)
check('Codex CLI', hasCommand('codex'), '后续接入 Codex 前再安装')

console.log('\n骨架就绪。下一步：解剖 AI CLI 的两副面孔。\n')

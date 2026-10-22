import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export function killCli(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!child.pid) return void child.kill(signal)
  if (process.platform !== 'win32') return void child.kill(signal)
  // taskkill /T 把 cmd 连同它下面的 claude.exe/codex.exe 整棵进程树一起杀
  spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['ignore', 'pipe', 'pipe'] },
): ChildProcessByStdio<null, Readable, Readable>
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessByStdio<Writable, Readable, Readable>
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions['stdio'] },
): ChildProcessByStdio<any, any, any> {
  /**
   * spawn(command, [args], [options]) 用于异步衍生一个新的外部子进程来执行系统命令
   * command：要执行的命令或可执行文件名称（如 'ls'、'python'、'git'）
   * args：参数数组（字符串列表）
   * options：可选配置对象（如 cwd、env、shell、stdio 等）
   */
  if (process.platform !== 'win32') {
    return spawn(command, args, options)
  }
  return spawn(command, args, {
    ...options,
    shell: true,
    windowsHide: true,
  })
}

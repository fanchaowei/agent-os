/**
 * 离线重放入口的真实消息处理流程，验证控制命令不会继续创建任务卡片或启动 CLI。
 * 只替换配置、持久化、飞书连接和 CLI 执行边界，不读取 .env，也不启动外部进程。
 * 运行：node --experimental-vm-modules --import tsx --test tests/command-routing.test.mjs
 * COMMAND_ROUTING_ENTRY 可指定另一个入口文件，用同一组消息对比课程代码。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import test from 'node:test'
import * as registry from '../src/cli/registry.ts'
import * as commands from '../src/core/command-parser.ts'
import { SessionManager } from '../src/core/session-manager.ts'
import * as taskAbort from '../src/core/task-abort.ts'
import * as taskProgress from '../src/core/task-progress.ts'
import * as workspace from '../src/core/workspace.ts'
import * as cards from '../src/im/card.ts'
import * as messages from '../src/im/message-parser.ts'

/** 待验证的完整入口；默认使用本项目，也可以只读加载课程入口。 */
const entryUrl = process.env.COMMAND_ROUTING_ENTRY
  ? pathToFileURL(path.resolve(process.env.COMMAND_ROUTING_ENTRY))
  : new URL('../src/index.ts', import.meta.url)
/** 入口原文，不修改其中的命令分支和消息回调。 */
const entrySource = await readFile(entryUrl, 'utf8')
/** 从已安装的 tsx 获取其编译器，不新增项目依赖。 */
const requireFromTsx = createRequire(import.meta.resolve('tsx'))
/** tsx 自带的 TypeScript 转译方法，只移除类型并保留 ESM 和顶层 await。 */
const { transformSync } = requireFromTsx('esbuild')
/** 可在虚拟 ESM 模块中执行的完整入口。 */
const entryCode = transformSync(entrySource, {
  loader: 'ts', format: 'esm', target: 'es2022',
}).code

/** 为每个用例创建独立会话和机器人，捕获真实 onMessage，并记录其可观察行为。 */
async function createHarness() {
  /** 文本回复记录；控制命令应该只增加这里的内容。 */
  const replies = []
  /** 新建任务卡片记录；控制命令不应该增加这里的内容。 */
  const taskCards = []
  /** CLI 调用记录；用例通过数量判断是否误执行任务。 */
  const cliRuns = []
  /** 后台任务的错误输出，避免异步链中的异常被测试忽略。 */
  const errors = []
  /** 入口注册的机器人选项，通过其中的回调重放消息。 */
  let botOptions
  /** 真实的内存会话管理器；只替换其磁盘存储。 */
  let manager
  /** 替代磁盘的空存储；会话管理和状态切换仍使用项目实现。 */
  class MemoryStore {
    /** 每个用例都从空会话列表启动。 */
    async load() { return [] }
    /** 离线测试不把内存会话写入磁盘。 */
    async save() {}
  }
  /** 依赖白名单，阻止入口意外加载真实配置或连接飞书。 */
  const dependencies = {
    'dotenv/config': {},
    'node:path': path,
    './cli/registry.js': registry,
    './cli/runner.js': {
      /** 记录本轮执行参数并立即返回结果，避免启动真实的编程 CLI。 */
      async runCli(options) {
        cliRuns.push(options)
        return { answer: '离线任务完成' }
      },
    },
    './core/bot-registry.js': {
      /** 提供没有凭证的测试配置，不读取用户的配置文件。 */
      async loadBotConfigs() {
        return [{ id: 'test', appId: '', appSecret: '', defaultCliId: 'claude', workspaceDir: process.cwd() }]
      },
      /** 路由测试只需保留任务正文，无需拼接机器人的系统提示词。 */
      buildBotPrompt: (_systemPrompt, taskText) => taskText,
    },
    './core/command-parser.js': commands,
    './core/session-manager.js': {
      SessionManager: {
        /** 捕获真实管理器，供用例建立已有会话或正在执行的状态。 */
        async open(options) {
          manager = await SessionManager.open(options)
          return manager
        },
      },
    },
    './core/session-store.js': { JsonSessionStore: MemoryStore },
    './core/task-abort.js': taskAbort,
    './core/task-progress.js': taskProgress,
    './core/workspace.js': workspace,
    './im/card.js': cards,
    './im/lark.js': {
      /** 只捕获回调，不创建飞书客户端或网络连接。 */
      startBot(options) { botOptions = options },
    },
    './im/message-parser.js': messages,
  }
  /** 隔离上下文；日志静默，异常日志单独保留。 */
  const context = createContext({
    process: { env: {} },
    AbortController,
    setInterval,
    clearInterval,
    console: { log() {}, error: (...args) => errors.push(args) },
  })
  /** 以原生 ESM 执行完整入口，通过链接器替换外部边界。 */
  const entryModule = new SourceTextModule(entryCode, { context, identifier: entryUrl.href })
  await entryModule.link((specifier) => {
    assert.ok(Object.hasOwn(dependencies, specifier), `未隔离的依赖：${specifier}`)
    return new SyntheticModule(Object.keys(dependencies[specifier]), function () {
      // name 和 value 是当前依赖导出的名称与值，保持真实模块的调用接口。
      for (const [name, value] of Object.entries(dependencies[specifier])) {
        this.setExport(name, value)
      }
    }, { context })
  })
  await entryModule.evaluate()
  assert.equal(typeof botOptions?.onMessage, 'function')

  /** 模拟飞书回复接口；每张任务卡片都返回 ID，让错误路由能完整走到 CLI 边界。 */
  const bot = {
    /** 记录文本回复，不发送消息。 */
    async reply(_messageId, text) { replies.push(text) },
    /** 记录新建任务卡片，并模拟飞书返回消息 ID。 */
    async replyCard(_messageId, card) { taskCards.push(card); return 'test-card' },
    /** 忽略后续卡片更新，不发送网络请求。 */
    async updateCard() {},
  }
  /** 同一话题的消息地址，便于验证首次命令和已有会话。 */
  const address = { messageId: 'test-message', chatId: 'test-chat', threadId: '', rootId: '' }
  return {
    replies, taskCards, cliRuns, manager,
    /** 通过公开方法预建指定状态的会话，不修改管理器内部数据。 */
    async seed(status) {
      /** 预建后再按合法状态机切换的会话。 */
      const { session } = await manager.resolve(address, 'claude', 'test', process.cwd())
      await manager.transition(session.id, status)
    },
    /** 重放带真实提及占位符的文本，等待任务微任务链收尾，再检查后台错误。 */
    async send(text) {
      await botOptions.onMessage({
        ...address,
        chatType: 'group', messageType: 'text', senderOpenId: 'test-user',
        text: `@_user_1 ${text}`,
        mentions: [{ key: '@_user_1', name: 'agent-os测试智能体', openId: 'test-bot' }],
        rawContent: JSON.stringify({ text }),
      }, bot)
      await setImmediate()
      assert.deepEqual(errors, [], '后台任务不应出现异常')
    },
  }
}

/** 用全新话题和已有空闲会话分别覆盖截图中的 /cd 场景。 */
for (const status of [undefined, 'idle', 'active']) {
  test(`/cd 只回复目录，不创建任务（${status ?? '新话题'}）`, async () => {
    /** 当前场景的独立消息处理器与记录。 */
    const harness = await createHarness()
    if (status) await harness.seed(status)
    await harness.send('/cd')
    assert.deepEqual(harness.replies, [`当前工作目录：${process.cwd()}`])
    assert.equal(harness.taskCards.length, 0, '/cd 不应创建任务卡片')
    assert.equal(harness.cliRuns.length, 0, '/cd 不应调用 CLI')
  })
}

test('执行中 /cd <目录> 只回复一次拒绝提示', async () => {
  /** 预建 active 会话，复现提前退出分支。 */
  const harness = await createHarness()
  await harness.seed('active')
  await harness.send('/cd src')
  assert.deepEqual(harness.replies, ['当前任务仍在执行，结束后再切换工作目录。'])
  assert.equal(harness.taskCards.length, 0)
  assert.equal(harness.cliRuns.length, 0)
})

/** 成功和失败的目录切换都只能处理命令，不应该成为一轮 CLI 任务。 */
for (const [input, reply] of [
  ['/cd src', /^工作目录已切换到：/],
  ['/cd .', /^当前工作目录已经是：/],
  ['/cd src/index.ts', /^无法切换工作目录：/],
  ['/help', /\/cd 查看当前工作目录/],
  ['/status', /^机器人：test/],
  ['/close', /^当前会话已关闭/],
]) {
  test(`${input} 处理完后停止消息路由`, async () => {
    /** 当前命令的独立消息处理器与记录。 */
    const harness = await createHarness()
    await harness.send(input)
    assert.equal(harness.replies.length, 1)
    assert.match(harness.replies[0], reply)
    assert.equal(harness.taskCards.length, 0)
    assert.equal(harness.cliRuns.length, 0)
  })
}

test('普通任务仍然创建卡片并调用 CLI', async () => {
  /** 正常任务作为正向对照，防止把所有消息都提前拦截。 */
  const harness = await createHarness()
  await harness.send('检查项目状态')
  assert.equal(harness.taskCards.length, 1)
  assert.equal(harness.cliRuns.length, 1)
  assert.match(harness.cliRuns[0].prompt, /检查项目状态/)
})

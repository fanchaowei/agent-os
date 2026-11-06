import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CliId } from '../cli/types.js'
import { resolveWorkspacePath } from './workspace.js'

// 校验通过后给业务层用的「成品」结构。
// 注意和 JSON 里的原始结构不同：这里 appId/appSecret 是真实凭证，
// defaultCliId 是从 JSON 的 defaultCli 改名来的，原始字段名不往外暴露。
export interface BotConfig {
  id: string
  appId: string
  appSecret: string
  defaultCliId: CliId
  systemPrompt: string
  workspaceDir: string
}

// 只依赖「能按键名取值」的字典，便于测试时传入假 env，
// 而不必污染 process.env。
type Environment = Record<string, string | undefined>

// 描述单台 bot 在 bots.json 里的原始形态，负责字段和类型的把关。
const BotSchema = z.object({
  // id 是内部稳定标识，限制成小写字母/数字/连字符/下划线，最长 32，
  // 而且不允许以 - 或 _ 开头，避免拼进 sessionKey 时产生歧义。
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'bot id 只能使用小写字母、数字、连字符和下划线',
    ),
  // 这两个字段存的是「环境变量名」而不是凭证值，
  // 所以用环境变量命名规则（大写字母、数字、下划线，不能以数字开头）来校验，
  // 能在启动时尽早发现名字写错。
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  // 限定默认引擎只能是这两种之一，写别的直接报错。
  defaultCli: z.enum(['claude', 'codex']),
  workspace: z.string().trim().min(1).optional(),
  // 可选：不填就当作空字符串，表示这台 bot 没有额外角色说明。
  systemPrompt: z.string().trim().optional().default(''),
  // 可选：默认启用。设为 false 即可在保留配置的前提下临时停用。
  enabled: z.boolean().optional().default(true),
})

// 顶层结构：必须是一个非空的 bots 数组。
const BotConfigFileSchema = z.object({
  bots: z.array(BotSchema).min(1),
})

// 把「原始 JSON + 环境变量」转换成可以直接使用的 BotConfig 列表。
// 这里抛出的错误都是启动期错误，宁可启动失败也不要带着错误配置跑。
export function parseBotConfigs(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(), // 工作路径（绝对路径）
): BotConfig[] {
  // 第一步：结构校验。字段缺失、类型不对、正则不匹配都会在这里抛错。
  const parsed = BotConfigFileSchema.parse(input)

  // 第二步：id 查重。id 会参与 sessionKey 计算，
  // 重复会导致两台 bot 抢同一个会话，必须提前拦住。
  const ids = new Set<string>()
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`)
    ids.add(bot.id)
  }

  // 第三步：过滤掉停用的 bot，再把每项的环境变量名解析成真实凭证。
  // 先 filter 后 map 很关键：停用的 bot 不会去要凭证，
  // 所以停用一台 bot 时不必在 .env 里也把它的变量删掉。
  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      // 从 env 里按名字取凭证；取不到就 trim 成空串，
      // 下面用「是否为空」统一判断，省去分别处理 undefined 和空白字符。
      const appId = env[bot.appIdEnv]?.trim() ?? ''
      const appSecret = env[bot.appSecretEnv]?.trim() ?? ''
      // 报错信息里带上变量名，方便直接去 .env 里补对应那一行。
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`)
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`)
      }
      // 组装成品结构：字段改名、剔除 appIdEnv/appSecretEnv/enabled 这些中间字段。
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        systemPrompt: bot.systemPrompt,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? env.CLI_WORKDIR ?? env.CLAUDE_WORKDIR ?? '.',
          baseDirectory,
        ),
      }
    })

  // 全部被停用时直接报错，避免启动一个「看起来正常但一个 bot 都没连」的空进程。
  if (configs.length === 0) throw new Error('至少需要启用一个 bot')
  return configs
}

// 读取配置文件并解析。默认从 process.env 取凭证，测试时可注入。
export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(), // 工作路径（绝对路径）
): Promise<BotConfig[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    // 文件不存在是新手最常见的错误，单独给一条带操作指引的提示；
    // 其他 IO 错误（权限等）原样抛出，不做掩盖。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      )
    }
    throw error
  }

  try {
    // JSON.parse 的语法错误和 Zod 的校验错误都会落到这里，
    // 统一包一层前缀，方便从日志里区分「配置文件问题」和「代码问题」。
    return parseBotConfigs(JSON.parse(content), env, baseDirectory)
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`)
  }
}

// 把 bot 的角色说明拼到用户任务前面，形成最终交给 CLI 的提示词。
// 用「角色 / 任务」两段式，让模型先知道自己在扮演谁，再处理具体请求。
export function buildBotPrompt(systemPrompt: string, prompt: string): string {
  const role = systemPrompt.trim()
  // 没配角色说明时原样返回，不加多余包装，避免空标题干扰模型。
  if (!role) return prompt
  return `角色：${role}\n\n任务：${prompt}`
}

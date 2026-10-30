/**
 * 任务停止请求的处理模块：从运行中任务表查找任务，核对操作者身份并避免重复停止，
 * 然后通过 AbortController 通知执行层取消任务，返回结果供卡片交互回调生成提示。
 */

/** 一轮运行中任务的控制信息，由调用方按会话 ID 存入 activeRuns。 */
export interface ActiveRun {
  /** 本轮任务的取消控制器；执行层监听其 signal，在收到取消信号后执行终止和清理。 */
  controller: AbortController
  /** 任务发起人的飞书 open_id，用于限制只有发起人可以通过此入口停止任务。 */
  ownerOpenId: string
  /** 取消意图：stop 表示停止本轮任务，close 表示关闭会话；尚未请求取消时可省略。 */
  cancelMode?: 'stop' | 'close'
}

/** 停止请求的处理结果，用于向操作者展示不同提示；不表示底层进程已完成退出。 */
export type AbortTaskOutcome =
  /** 已标记停止意图并触发取消信号。 */
  | 'stopped'
  /** 控制器已处于取消状态，无需再次发送信号。 */
  | 'already_stopping'
  /** 运行中任务表没有对应记录，任务可能已结束或未登记。 */
  | 'not_found'
  /** 操作者与任务发起人的 open_id 不一致，拒绝停止。 */
  | 'forbidden'

/**
 * 请求停止指定会话当前运行的任务。
 * 依次检查任务是否存在、操作者是否为发起人、是否已经请求取消；
 * 检查通过后先将 cancelMode 标记为 stop，再触发 abort，供取消监听逻辑读取停止意图。
 * 此函数仅发出取消信号，不等待 CLI 退出，也不移除任务记录；后续收尾由调用方和执行层负责。
 * @param activeRuns 以会话 ID 为键的运行中任务表，函数会修改对应记录的取消意图及控制器状态。
 * @param sessionId 要停止任务所属的会话 ID。
 * @param operatorOpenId 发起停止操作的用户 open_id，由卡片交互事件提供。
 * @returns 本次请求的处理结果，供调用方生成提示文案。
 */
export function requestTaskAbort(
  activeRuns: Map<string, ActiveRun>,
  sessionId: string,
  operatorOpenId: string,
): AbortTaskOutcome {
  /** 当前会话登记的运行记录；不存在时直接返回，不再检查权限或触发取消。 */
  const active = activeRuns.get(sessionId)
  if (!active) return 'not_found'
  // 先检查身份，再判断取消状态，确保非发起人始终收到无权操作的结果。
  if (operatorOpenId !== active.ownerOpenId) return 'forbidden'
  if (active.controller.signal.aborted) return 'already_stopping'
  // 在发送信号前写入意图，取消监听器被触发时即可读到 stop。
  active.cancelMode = 'stop'
  active.controller.abort()
  return 'stopped'
}

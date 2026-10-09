import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { failureFacts, isTransientFailure } from './failure.js'

/**
 * 纯判断逻辑：要不要续跑、续跑消息怎么写、要不要重新授权 goal。
 * 不依赖 DSH，可以直接单测（判据是最容易写错的部分，所以单独拆出来）。
 */

/** 认为"值得续跑"的非人为回合结束原因。 */
export const RESUMABLE = new Set(['interrupted', 'error', 'max-tokens'])

/** 多久之内算"新鲜"的打断（毫秒）。太老的打断不翻旧账。 */
export const FRESH_MS = 15 * 60 * 1000

/**
 * 读取 reason.kind —— 实测事件流里 reason 有两种形状：
 * 字符串（`reason=interrupted`）或对象（`{kind: 'completed'}`）。
 */
export function reasonKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

function eventTime(event) {
  return event && typeof event.time === 'number' ? event.time : undefined
}

/**
 * 从事件流尾部判断"有没有一件被打断、且之后没人处理过的事"。
 *
 * 判据（每条都对应一个单测用例）：
 *   - 尾部最后一条 turn/end 的 reason 属于 RESUMABLE
 *   - 该 turn/end 之后没有 turn/start
 *   - 该 turn/end 之后没有 source.kind === 'user' 的消息
 *     （插件/系统消息不算"已处理"——否则我们自己的续跑消息会把后续判断堵死）
 *   - 时间上足够新（默认 15 分钟内）
 *
 * @returns {{resume: false} | {resume: true, turnSeq: number, reason: string, lastTool?: string}}
 */
export function inspectTail(events, now, freshMs = FRESH_MS) {
  if (!Array.isArray(events) || events.length === 0) return { resume: false }

  let lastEndIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event && event.type === 'turn/end') {
      lastEndIndex = i
      break
    }
  }
  if (lastEndIndex < 0) return { resume: false }

  const lastEnd = events[lastEndIndex]
  const rawReason = lastEnd.data && lastEnd.data.reason
  const kind = reasonKind(rawReason)
  if (kind === undefined || !RESUMABLE.has(kind)) return { resume: false }

  // `error` 还要再分一层：认证失败 / 余额不足 / 模型不存在这类**重试也没用**的，
  // 续跑等于白烧一轮 token。判定见 lib/failure.js（偏保守：看不清原因就放行）。
  let failure
  if (kind === 'error') {
    const facts = failureFacts(rawReason)
    const verdict = isTransientFailure(facts)
    if (!verdict.retry) {
      return { resume: false, skippedError: { ...facts, why: verdict.why } }
    }
    failure = { ...facts, why: verdict.why }
  }

  const at = eventTime(lastEnd)
  if (at !== undefined && now - at > freshMs) return { resume: false }

  for (let i = lastEndIndex + 1; i < events.length; i += 1) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'turn/start') return { resume: false }
    if (event.type === 'user/message') {
      const source = event.data && event.data.source
      if (source && source.kind === 'user') return { resume: false }
    }
  }

  // 最后一个工具调用：用来告诉 agent「哪一步的结局没被确认」
  let lastTool
  for (let i = lastEndIndex; i >= 0; i -= 1) {
    const event = events[i]
    if (event && event.type === 'tool/call') {
      const name = event.data && (event.data.name || event.data.tool)
      if (typeof name === 'string') lastTool = name
      break
    }
  }

  return {
    resume: true,
    turnSeq: lastEnd.seq,
    reason: kind,
    ...(lastTool ? { lastTool } : {}),
    ...(failure ? { failure } : {}),
  }
}

/**
 * 续跑消息的正文。
 *
 * 不是简单一句"继续"：重启时外部操作可能做到一半（下载、推送……），
 * 所以要求 agent 先核对真实状态，既不假定成功，也不假定失败。
 */
export function renderResumePrompt(info) {
  const toolLine = info.lastTool
    ? `\nПоследний вызов инструмента перед прерыванием — «${info.lastTool}»: он мог выполниться успешно, выполниться наполовину или не запуститься вовсе.`
    : ''

  // dsh-guard: если внешний сторож восстанавливал стенд во время этой сессии,
  // он оставляет notice.md — вставляем его правила ОДИН раз (файл удаляется).
  let guardBlock = ''
  try {
    const noticePath = '/opt/dsh/dsh-guard/notice.md'
    if (existsSync(noticePath)) {
      const text = readFileSync(noticePath, 'utf8').trim()
      unlinkSync(noticePath)
      if (text !== '') guardBlock = `<guard_notice>\n${text}\n</guard_notice>\n\n`
    }
  } catch {
    // нет доступа/файла — обычное резюме без правил
  }

  // Ключевые точки добавляются только если есть что добавить, и не пересказывают контекст:
  // DSH уже записал «исход неизвестен» в историю, видимую модели; здесь только то,
  // что агенту трудно узнать самому.
  const keys = info.keyPoints
  let keyBlock = ''
  if (keys !== undefined && keys !== null) {
    const lines = []
    if (typeof keys.turn === 'number') lines.push(`- Обрыв на ходе №${keys.turn}`)
    if (Array.isArray(keys.unconfirmed) && keys.unconfirmed.length > 0) {
      lines.push(
        `- Вызовы инструментов с **неподтверждённым** исходом (${keys.unconfirmed.length} шт., наиболее вероятное место проблемы): ` +
          keys.unconfirmed.map((n) => `«${n}»`).join(', '),
      )
    }
    if (typeof keys.lastAssistant === 'string' && keys.lastAssistant !== '') {
      lines.push(`- Последнее, что ты сказал до прерывания: ${keys.lastAssistant}`)
    }
    if (lines.length > 0) {
      keyBlock = `\nКлючевые точки из журнала событий (**неполные**, остальное проверь сам):\n${lines.join('\n')}\n`
    }
  }

  return [
    {
      type: 'text',
      text:
        guardBlock +
        '<recovery_resume>\n' +
        'DSH на этой машине только что перезапустился (процесс сервиса заменён), твой предыдущий ход был прерван этим. ' +
        `Причина прерывания: ${info.reason}.${toolLine}\n` +
        keyBlock +
        '\n' +
        'Перед продолжением **обязательно проверь фактическое состояние**:\n' +
        '1. Сначала осмотри рабочую область / процессы / журналы и установи, выполнен ли прерванный шаг на самом деле — ' +
        'не считай его по истории диалога ни успешным, ни провальным.\n' +
        '2. Если исход неясен (загрузка, отправка, запись файла — до какой степени дошло), ' +
        'проверь реальными доказательствами; при необходимости повтори идемпотентно.\n' +
        '3. После проверки фактического состояния продолжай с правильного места, не повторяя уже сделанное.\n' +
        '\n' +
        'В конце приведи проверяемые доказательства (вывод команд, содержимое файлов, коды выхода). ' +
        'Если продолжить невозможно (не хватает предпосылок, внешний сервис недоступен) — честно сообщи и остановись.\n' +
        '</recovery_resume>',
    },
  ]
}

/**
 * 判断要不要重新授权（重新武装）这个 goal。
 *
 * 必须保守：`goals.resume()` 也接受 paused / blocked 的目标，无条件调用会把
 * 用户手动暂停的目标恢复掉。所以只在两个条件同时满足时动手：
 * 目标是 active，且这次中断是机器造成的（interrupted / error / max-tokens）。
 *
 * @returns {{rearm: false, why: string} | {rearm: true, id: string, revision: number}}
 */
export function decideRearm(goal, reason) {
  if (goal === undefined || goal === null) return { rearm: false, why: '没有 goal' }
  if (goal.phase !== 'active') return { rearm: false, why: `phase=${goal.phase}（只处理 active）` }
  if (goal.activation === 'armed') return { rearm: false, why: '已经是 armed（无需重复授权）' }
  if (!RESUMABLE.has(reason)) return { rearm: false, why: `中断原因 ${reason} 不是机器造成的` }
  if (typeof goal.roundsStarted === 'number' && typeof goal.maxGoalRounds === 'number'
      && goal.roundsStarted >= goal.maxGoalRounds) {
    return { rearm: false, why: `轮次已用尽 ${goal.roundsStarted}/${goal.maxGoalRounds}` }
  }
  if (typeof goal.id !== 'string' || typeof goal.revision !== 'number') {
    return { rearm: false, why: 'goal 缺少 id/revision' }
  }
  return { rearm: true, id: goal.id, revision: goal.revision }
}

/**
 * @h1w0rld/dsh-harness-guard v0.1.0
 * Защита на уровне хоста: RED-вызовы инструментов (bash-ред-команды, правка
 * защищённых файлов, создание/правка скиллов) требуют подтверждения
 * пользователя через approval-сервис — независимо от «ума» модели.
 *
 * Waterfall tools/pre-execute:
 *   - вернуть next()      → пропустить (всегда для безопасного);
 *   - вернуть {kind:'ask', reason} → хост спросит пользователя; без approval-
 *     сервиса или без агента ядро само деградирует в deny (см. dsh-tools
 *     serviceAsk) — т.е. защита не ослабляется;
 *   - ошибки плагина → next() (fail-open, инструменты не ломаем).
 *
 * Конфиг (cordis.patch.yml, volatile-рефы 0.2.0 — unwrap через .get()):
 *   mode: 'ask' (по умолчанию) | 'off'
 */

const PLUGIN = 'harness-guard'

const unwrap = (v) => (v && typeof v.get === 'function') ? v.get() : v

export function apply(ctx, entryConfig) {
  let mode = 'ask'
  try {
    const raw = entryConfig?.mode ?? entryConfig?.config?.mode
    const m = unwrap(raw)
    if (m === 'off' || m === 'ask') mode = m
  } catch { /* конфига нет — дефолт ask */ }

  console.log(`[${PLUGIN}] apply() — плагин загружен (v0.1.0, mode=${mode})`)

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (mode === 'off') return next()
      const r = classify(exec)
      if (!r) return next()
      try {
        const preview = exec?.name === 'bash'
          ? String(exec?.arguments?.command ?? '')
          : String(exec?.arguments?.file_path ?? exec?.arguments?.action ?? exec?.name ?? '')
        ctx.logger?.info?.(`[${PLUGIN}] ask rule=${r.rule} :: ${preview.slice(0, 80)}`)
      } catch { /* логирование не влияет на решение */ }
      return { kind: 'ask', reason: r.reason }
    } catch {
      return next() // fail-open: ошибка плагина никогда не ломает инструменты
    }
  }), `${PLUGIN}: pre-execute`)

  return () => {}
}

import { classify } from './rules.js'
export { classify }

/**
 * dsh-harness-guard — чистый классификатор вызовов инструментов.
 * classify(exec) → null | {kind:'ask', reason, rule}
 * Без побочных эффектов и зависимостей. Fail-open по построению: всё, что не
 * распознано как RED, — null (не мешаем обычной работе).
 */

const TOP_PREFIX = ['/dsh', '/opt', '/etc', '/var', '/usr', '/boot', '/root']
const TOP_EXACT = ['/', '/*', '~', '$HOME']

const isTopLevel = (t) => {
  const s = String(t).replace(/^["']|["']$/g, '')
  return TOP_EXACT.includes(s) ||
  TOP_PREFIX.some((p) => s === p || s.startsWith(p + '/')) ||
  s === '~' || s === '$HOME' ||
  /^\$\{?\w+\}?\/?/.test(s) || /\/\$\{?\w/.test(s)
}

const PROTECTED = [
  '/dsh/.dsh/AGENTS.md',
  '/dsh/.dsh/profiles/web/cordis.patch.yml',
  '/dsh/.dsh/profiles/web/package.json',
  '/dsh/.dsh/profiles/web/pnpm-workspace.yaml',
  '/dsh/.dsh/profiles/web/patches/',
  '/dsh/.dsh/skills-manager/state.json',
  '/etc/fstab',
  '/etc/systemd/',
  '/etc/ssh/',
  '/opt/projects/harness/backups/',
  '/opt/projects/harness/tools/golden.manifest',
  '/opt/projects/harness/dsh-harness-guard/',
]

const DISK_TOOLS = /\b(mkfs\S*|wipefs|fdisk|sfdisk|cfdisk|gdisk|parted|mount|umount|swapon|swapoff|chattr)\b/

/** Грубый токенайзер: env/sudo-префиксы, bash -c, &&, ||, ;, |, $(...). */
export function subcommands(cmd) {
  const strip = /^(\s*(sudo|nohup|env(\s+\w+=\S+)*|bash\s+-c|sh\s+-c)\s*|['"])+/
  return String(cmd)
    .replace(/\$\(/g, '; ')
    .split(/&&|\|\||;|\|/)
    .map((s) => { let p = s.trim(); let prev; do { prev = p; p = p.replace(strip, '') } while (p !== prev); return p.trim() })
    .filter(Boolean)
}

const words = (s) => String(s).split(/\s+/).filter(Boolean)
const isRmRecursiveForce = (w) =>
  w[0] === 'rm' && w.slice(1).some((f) => /^-[a-z]*r[a-z]*/i.test(f)) && w.slice(1).some((f) => /^-[a-z]*f/i.test(f))

function isProtectedPath(p) {
  p = String(p)
  return PROTECTED.some((q) => p === q || (q.endsWith('/') ? p.startsWith(q) : p.startsWith(q + '/') || p === q))
}

/** bash-часть: команда пишется/правит защищённый файл? */
const WRITE_INTENT = /(^|\s)(>>|>|tee|sed|mv|cp|rm|install|truncate|dd)(?=\s|$)/
const PROTECTED_RE = PROTECTED.map((p) => p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\\\/$/, ''))
const PROTECTED_ANY = new RegExp('(^|[\\s\'"=])(' + PROTECTED_RE.join('|') + ')')

function bashRed(cmd) {
  const parts = subcommands(cmd)
  const joined = ' ' + cmd + ' '
  // curl/wget … | sh/bash
  for (let i = 1; i < parts.length; i++) {
    const w = words(parts[i])
    if ((w[0] === 'sh' || w[0] === 'bash') && /(^|\s)(curl|wget)\b/.test(parts[i - 1]))
      return { kind: 'ask', rule: 'pipe-to-shell', reason: 'curl/wget | sh — запуск скачанного скрипта требует подтверждения' }
  }
  for (const part of parts) {
    const w = words(part)
    const c = w[0]
    if (!c) continue
    if (c === 'rm' && isRmRecursiveForce(w)) {
      const targets = w.slice(1).filter((t) => !t.startsWith('-'))
      if (targets.some(isTopLevel))
        return { kind: 'ask', rule: 'rm-rf-top', reason: 'rm -rf по корню/верхнеуровневому каталогу — требует подтверждения' }
    }
    if (DISK_TOOLS.test(part) && !/^(status|lsblk|findmnt)/.test(c) && !/\b(status|list)\b/.test(part))
      return { kind: 'ask', rule: 'disk', reason: 'дисковая/маунт-операция — только после подтверждения' }
    if (c === 'dd' && /\bof=\/dev\//.test(part))
      return { kind: 'ask', rule: 'dd-device', reason: 'dd на устройство — затирание диска, требует подтверждения' }
    if (/^(iptables|ip6tables|nft)$/.test(c) && /(^|\s)-(F|X|P|D)\b|\bflush\b|\bdelete\b/.test(part))
      return { kind: 'ask', rule: 'firewall', reason: 'сброс/изменение правил файрвола — требует подтверждения' }
    if (c === 'ufw' && /^(disable|reset|delete|default)$/.test(w[1] || ''))
      return { kind: 'ask', rule: 'firewall', reason: 'отключение/сброс ufw — требует подтверждения' }
    if (c === 'docker' && /\b(system\s+prune|volume\s+rm|volume\s+prune|network\s+rm|image\s+prune|compose\s+down|rm\s+-f|rm\s+--force)\b/.test(part))
      return { kind: 'ask', rule: 'docker-destructive', reason: 'удаление контейнеров/томов/сетей docker — требует подтверждения' }
    if (/^(systemctl|service)$/.test(c)) {
      const act = c === 'service' ? (w[2] || '') : (w[1] || '')
      if (/^(stop|disable|mask|kill)$/.test(act) && /\b(dsh|ssh|docker|nginx|networking|systemd-)/i.test(part))
        return { kind: 'ask', rule: 'systemctl', reason: 'остановка/маскировка системной службы — требует подтверждения' }
      if (/^(restart|reload)$/.test(act) && /\bdsh/i.test(part))
        return { kind: 'ask', rule: 'dsh-restart', reason: 'рестарт dsh оборвёт текущую сессию — подтвердите' }
    }
    if (/\b(drop\s+(database|table)\b|truncate\s+(table\s+)?\w)/i.test(part))
      return { kind: 'ask', rule: 'sql-destructive', reason: 'DROP/TRUNCATE в базе данных — требует подтверждения' }
    if (/^(shutdown|reboot|poweroff|halt)$/.test(c) || /^init\s+[06]$/.test(part))
      return { kind: 'ask', rule: 'power', reason: 'выключение/перезагрузка сервера — требует подтверждения' }
    if (c === 'git' && w[1] === 'push' && w.slice(2).some((f) => f === '--force' || f === '-f' || f.startsWith('--force=')))
      return { kind: 'ask', rule: 'git-force-push', reason: 'git push --force перепишет удалённую историю — подтвердите' }
    if (c === 'git' && /^clean$/.test(w[1] || '') && /-.*[dx]/.test(w.slice(2).join('')))
      return { kind: 'ask', rule: 'git-clean', reason: 'git clean -fdx удалит неотслеживаемые файлы — подтвердите' }
    if (/^(chmod|chown)$/.test(c) && w.some((f) => /^-[a-z]*R/i.test(f)) && w.slice(1).some(isTopLevel))
      return { kind: 'ask', rule: 'chmod-top', reason: 'рекурсивная смена прав на верхнеуровневом каталоге — требует подтверждения' }
    if (/^(kill|killall|pkill)$/.test(c)) {
      if ((c === 'kill' && w.slice(1).some((t) => /^-.*9/.test(t)) && w.includes('1')) || (c === 'killall' && w[1] === 'node') || (c === 'pkill' && /\s-f\s/.test(part) && /dsh|node/.test(w.slice(2).join(' '))))
        return { kind: 'ask', rule: 'kill', reason: 'убийство процесса init/node/dsh — требует подтверждения' }
    }
    if (WRITE_INTENT.test(part)) {
      // cp/mv: защищённый путь как ИСТОЧНИК (бэкап-копирование) — не триггер
      const hit = (c === 'cp' || c === 'mv')
        ? w.slice(2).some(isProtectedPath)
        : PROTECTED_ANY.test(part)
      if (hit) return { kind: 'ask', rule: 'protected-file', reason: 'запись/правка защищённого файла — требует подтверждения' }
    }
  }
  return null
}

export function classify(exec) {
  if (!exec || typeof exec !== 'object') return null
  const name = exec.name
  const args = exec.arguments || {}
  if (name === 'bash' && typeof args.command === 'string') return bashRed(args.command)
  if ((name === 'write' || name === 'edit') && typeof args.file_path === 'string' && isProtectedPath(args.file_path))
    return { kind: 'ask', rule: 'protected-file', reason: `запись в защищённый файл ${args.file_path} — требует подтверждения` }
  if (name === 'skill_manage' && (args.action === 'create' || args.action === 'patch'))
    return { kind: 'ask', rule: 'skill-write', reason: `создание/правка скилла (${args.action}) — только после согласия пользователя` }
  return null
}

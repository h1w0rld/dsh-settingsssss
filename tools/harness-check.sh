#!/usr/bin/env bash
# harness-check.sh — единая проверка здоровья харнеса (аналог «линтера в CI»).
# Только чтение, без побочных эффектов. exit != 0 при проблемах.
# Использование: harness-check.sh [--no-eval] [--fidelity] [--help]
#   --no-eval    пропустить skill-eval (ходит в сеть/Jev)
#   --fidelity   дополнительно прогнать skill-fidelity.py (долго, Jev; критичные purpose → FAIL)
#   --help       справка. Пункты: lint, eval, патчи, AGENTS, systemd, aliases,
#   дрейф золотого набора (tools/golden.manifest), guard-тесты, нумерация AGENTS 1–11.
set -u
cd "$(dirname "$0")/.."   # корень проекта /opt/projects/harness
NO_EVAL=0; FIDELITY=0
for a in "$@"; do
  case "$a" in
    --no-eval) NO_EVAL=1 ;;
    --fidelity) FIDELITY=1 ;;
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестный флаг: $a (--help для справки)"; exit 2 ;;
  esac
done
FAIL=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
skip() { echo "SKIP  $1"; }
warn() { echo "WARN  $1"; }   # предупреждение без падения чека
info() { echo "INFO  $1"; }   # информационная строка без падения чека

echo "=== Проверка здоровья харнеса $(date '+%F %T') ==="

# 0) активные скиллы <= 150 (иначе WARN «пересмотреть решение про Ollama»)
lint_out=$(python3 tools/skill-lint.py --cut 100 --max 300 2>&1)
nsk=$(printf '%s\n' "$lint_out" | sed -n 's/.*скиллов активных: \([0-9]\+\).*/\1/p' | tail -1)
if [ "${nsk:-0}" -le 150 ]; then
  pass "0) активных скиллов: ${nsk:-?} <= 150 (семантика/Ollama не нужна)"
else
  warn "0) активных скиллов: $nsk > 150 — пересмотреть решение про Ollama (semanticEnabled: false)"
fi

# 1) skill-lint.py: ERR=0 обязательно, число WARN вывести (результат уже посчитан в п.0)
out="$lint_out"
err=$(printf '%s\n' "$out" | sed -n 's/.*ERR=\([0-9]*\).*/\1/p' | tail -1)
warn=$(printf '%s\n' "$out" | sed -n 's/.*WARN=\([0-9]*\).*/\1/p' | tail -1)
echo "$out" | tail -1
if [ "${err:-1}" = "0" ]; then pass "1) skill-lint: ERR=0 (WARN=${warn:-?})"; else fail "1) skill-lint: ERR=${err:-?}"; fi

# 2) skill-eval: >=85% точности (--no-eval пропускает: ходит в сеть/jev)
if [ "$NO_EVAL" = 1 ]; then
  skip "2) skill-eval (--no-eval; точность >=85% не проверена)"
else
  out=$(python3 tools/skill-eval/skill-eval.py --cut 100 2>&1 | tail -8)
  echo "$out"
  acc=$(printf '%s\n' "$out" | sed -n 's/.*accuracy=[0-9]\+\/[0-9]\+ (\([0-9]\+\(\.[0-9]\+\)\?\)%).*/\1/p' | tail -1)
  if awk -v a="${acc:-0}" 'BEGIN{exit !(a>=85)}'; then pass "2) skill-eval: точность ${acc}% >= 85%"; else fail "2) skill-eval: точность ${acc:-?}% < 85%"; fi
fi

# 3) check-patches.sh, если существует
if [ -x tools/check-patches.sh ] || [ -f tools/check-patches.sh ]; then
  if tools/check-patches.sh; then pass "3) check-patches: OK"; else fail "3) check-patches: патч не применён/версия разошлась"; fi
else
  skip "3) tools/check-patches.sh не существует (это нормально)"
fi

# 4) бюджет каталога: строка «каталог при cut=100: ~N симв.», токены ≈ N/4, <= 5000
chars=$(printf '%s\n' "$out" | sed -n 's/.*каталог при cut=100: ~\([0-9]\+\) симв.*/\1/p' | tail -1)
# если out перезаписан выводом eval — взять из вывода lint (п.0)
[ -z "$chars" ] && chars=$(printf '%s\n' "$lint_out" | sed -n 's/.*каталог при cut=100: ~\([0-9]\+\) симв.*/\1/p' | tail -1)
tok=$(( ${chars:-0} / 4 ))
if [ "$tok" -le 5000 ]; then pass "4) бюджет каталога: ${chars:-0} симв. ≈ ${tok} ток. <= 5000"; else fail "4) бюджет каталога: ${chars:-0} симв. ≈ ${tok} ток. > 5000"; fi

# 5) AGENTS.md существует и ссылается на ключевые скиллы
AG=/dsh/.dsh/AGENTS.md
if [ -f "$AG" ]; then
  missing=""
  for s in verify-before-done scope-guard research-escalation; do
    grep -q "$s" "$AG" || missing="$missing $s"
  done
  if [ -z "$missing" ]; then pass "5) AGENTS.md: ссылки на verify-before-done, scope-guard, research-escalation есть"; else fail "5) AGENTS.md: нет ссылок:$missing"; fi
else
  fail "5) /dsh/.dsh/AGENTS.md не существует"
fi

# 6) systemd: dsh.service активен, failed-юнитов нет
if systemctl is-active -q dsh.service; then pass "6) dsh.service: active"; else fail "6) dsh.service: $(systemctl is-active dsh.service)"; fi
if [ -z "$(systemctl --failed --no-legend 2>/dev/null)" ]; then pass "6) systemctl --failed: пусто"; else fail "6) systemctl --failed: $(systemctl --failed --no-legend | tr '\n' '; ')"; fi

# 7) aliases в cordis.patch.yml: YAML валиден (SafeLoader + multi-constructor для !!js),
#    у skill-folder есть semanticEnabled: false и блок aliases
python3 - <<'PY' && pass "7) aliases: YAML валиден, skill-folder: aliases + semanticEnabled: false" || fail "7) aliases/YAML: см. выше"
import yaml, sys
class L(yaml.SafeLoader): pass
L.add_multi_constructor('', lambda l, s, n: None)
doc = yaml.load(open('/dsh/.dsh/profiles/web/cordis.patch.yml'), Loader=L)
def find_sf(o):
    if isinstance(o, dict):
        if o.get('id') == 'skill-folder': return o
        for v in o.values():
            r = find_sf(v)
            if r is not None: return r
    elif isinstance(o, list):
        for v in o:
            r = find_sf(v)
            if r is not None: return r
    return None
e = find_sf(doc)
assert e is not None, 'нет записи id: skill-folder'
cfg = e.get('config') or {}
se = cfg.get('semanticEnabled')
assert se is False, f'semanticEnabled={se!r}, ожидается false'
al = cfg.get('aliases') or {}
assert isinstance(al, dict) and len(al) >= 40, f'aliases пуст/мал: {len(al)}'
print(f'    skill-folder: {len(al)} скиллов с алиасами, semanticEnabled: false', file=sys.stderr)
PY

# 8) alias precision: live-aliases из cordis.patch.yml → tools/staging/alias-live.json
#    (перезаписывается), precision-тест alias-test.mjs; FAIL при wrongCount>0
if [ -f tools/staging/alias-test.mjs ]; then
  if python3 - <<'PY' > tools/staging/alias-live.json
import yaml, json
class L(yaml.SafeLoader): pass
L.add_multi_constructor('', lambda l, s, n: None)
doc = yaml.load(open('/dsh/.dsh/profiles/web/cordis.patch.yml'), Loader=L)
def find_sf(o):
    if isinstance(o, dict):
        if o.get('id') == 'skill-folder': return o
        for v in o.values():
            r = find_sf(v)
            if r is not None: return r
    elif isinstance(o, list):
        for v in o:
            r = find_sf(v)
            if r is not None: return r
    return None
cfg = (find_sf(doc) or {}).get('config') or {}
print(json.dumps(cfg.get('aliases') or {}, ensure_ascii=False))
PY
  then
    fails_total=0
    for cases in tools/skill-eval/cases.json tools/skill-eval/alias-holdout.json; do
      out_a=$(node tools/staging/alias-test.mjs tools/staging/alias-live.json "$cases" 2>&1)
      wrong=$(printf '%s\n' "$out_a" | sed -n 's/.*"wrongCount": \([0-9]\+\).*/\1/p' | tail -1)
      kfp=$(printf '%s\n' "$out_a" | sed -n 's/.*"knownFpCount": \([0-9]\+\).*/\1/p' | tail -1)
      cov=$(printf '%s\n' "$out_a" | sed -n 's/.*"coveragePct": \([0-9.]\+\).*/\1/p' | tail -1)
      name=$(basename "$cases")
      info "8) alias precision [$name]: известных исключений: ${kfp:-0} (см. tools/skill-eval/alias-known-fp.json)"
      if [ "${wrong:-1}" = "0" ]; then pass "8) alias precision [$name]: wrongCount=0, coverage ${cov:-?}%"; else echo "$out_a" | head -15; fail "8) alias precision [$name]: wrongCount=${wrong:-?} (coverage ${cov:-?}%)"; fi
    done
  else
    fail "8) alias precision: не удалось выгрузить aliases из cordis.patch.yml"
  fi
else
  skip "8) alias precision (tools/staging/alias-test.mjs не существует)"
fi

# 9) дрейф золотого набора: sha256 живых файлов vs tools/golden.manifest
if [ -f tools/golden.manifest ]; then
  drift=""
  n_ok=0
  while read -r sum path; do
    case "$path" in
      ./AGENTS.md) live=/dsh/.dsh/AGENTS.md ;;
      ./dsh-agents-skills/*) live=/dsh/.agents/skills/${path#./dsh-agents-skills/} ;;
      ./profile-web-*) live=/dsh/.dsh/profiles/web/${path#./profile-web-} ;;
      ./profile-patches/*) live=/dsh/.dsh/profiles/web/patches/${path#./profile-patches/} ;;
      ./skills-manager-state.json) live=/dsh/.dsh/skills-manager/state.json ;;
      ./tools/*|./notes/*|./dsh-harness-guard/*) live=/opt/projects/harness/${path#./} ;;
      *) continue ;;
    esac
    if [ -f "$live" ]; then
      if [ "$(sha256sum "$live" | cut -d' ' -f1)" = "$sum" ]; then n_ok=$((n_ok+1)); else drift="$drift
    изменён: $live"; fi
    else drift="$drift
    отсутствует: $live"; fi
  done < tools/golden.manifest
  if [ -z "$drift" ]; then pass "9) дрейф золотого набора: $n_ok файлов совпадают с tools/golden.manifest"; else
    echo "$drift" | head -11
    fail "9) дрейф золотого набора: расхождения выше. Намеренная правка → ./tools/harness-backup.sh; нежелательная → ./tools/harness-restore.sh (сначала dry-run)"
  fi
else
  skip "9) дрейф золотого набора (tools/golden.manifest нет — запусти ./tools/harness-backup.sh)"
fi

# 10) guard-тесты dsh-harness-guard (если есть)
if [ -d dsh-harness-guard/test ]; then
  if out_g=$(node --test dsh-harness-guard/test/rules.test.mjs 2>&1); then
    st=$(printf '%s\n' "$out_g" | sed -n 's/^# \(tests [0-9]*[^|]*| pass [0-9]*[^|]*| fail [0-9]*\).*/\1/p' | tail -1)
    pass "10) guard-тесты: ${st:-ok}"
  else
    printf '%s\n' "$out_g" | tail -15
    fail "10) guard-тесты: есть падения (см. выше)"
  fi
else
  skip "10) guard-тесты (dsh-harness-guard/test нет)"
fi

# 11) AGENTS.md: нумерация правил 1..11 целая
AG=/dsh/.dsh/AGENTS.md
if [ -f "$AG" ]; then
  nums=$(grep -cE '^[0-9]+\. ' "$AG")
  seq_ok=$(seq 1 11 | while read -r n; do grep -qE "^$n\. " "$AG" || echo "нет правила $n"; done)
  if [ "$nums" = 11 ] && [ -z "$seq_ok" ]; then pass "11) AGENTS.md: нумерация 1–11 целая"; else fail "11) AGENTS.md: правил с нумерацией=$nums; ${seq_ok:-}"; fi
else fail "11) /dsh/.dsh/AGENTS.md не существует"; fi

# 12) skill-fidelity: по флагу --fidelity (долго, ходит в сеть/Jev); критичные purpose → FAIL
if [ "$FIDELITY" = 1 ]; then
  out_f=$(python3 tools/skill-fidelity.py 2>&1 | tail -5)
  echo "$out_f"
  crit=$(printf '%s\n' "$out_f" | sed -n 's/.*критичных \([0-9]\+\).*/\1/p' | tail -1)
  if [ "${crit:-1}" = "0" ]; then pass "12) skill-fidelity: критичных 0"; else fail "12) skill-fidelity: критичных ${crit:-?} (purpose=wrong/искажения смысла)"; fi
else
  skip "12) skill-fidelity (долго + сеть; запустить с --fidelity)"
fi

echo "=== Итог: $([ $FAIL = 0 ] && echo ALL PASS || echo FAILURES) ==="
exit $FAIL

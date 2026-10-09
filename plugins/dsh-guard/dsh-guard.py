#!/usr/bin/env python3
# dsh-guard v1.0 (design v3) — внешний сторож DSH: не даёт LLM-сессиям оставить
# стенд без провайдеров/конфига; легитимные правки отличает от поломок.
# Один файл, python3 stdlib. Дизайн-принципы: хост DSH в штатном режиме не трогаем,
# тяжёлые проверки только при изменении конфига, дебаунс, healthy→baseline.
import os, sys, json, time, glob, shutil, socket, hashlib, subprocess, re
import urllib.request, urllib.parse

BASE     = "/opt/dsh/dsh-guard"
PATCH    = "/dsh/.dsh/profiles/web/cordis.patch.yml"
PKG      = "/dsh/.dsh/profiles/web/package.json"
SESSIONS = "/dsh/.dsh/sessions"
NOTICE   = os.path.join(BASE, "notice.md")
DISABLED = os.path.join(BASE, "disabled")
SUSPEND  = os.path.join(BASE, "suspend")
STATE_F  = os.path.join(BASE, "state.json")
GOLDEN_F = os.path.join(BASE, "golden-manifest.json")
EVENTS   = os.path.join(BASE, "events.log")
BACKUPS  = os.path.join(BASE, "backups")
QUAR     = os.path.join(BASE, "quarantine")

def load_env(path, default={}):
    env = dict(default)
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env

ENV = load_env(os.path.join(BASE, "guard.env"), {
    "POLL": "30", "DEBOUNCE": "30", "HOT": "180", "WARM": "600",
    "HARD_HOT": "90", "HARD_WARM": "300", "CANARY_CONFIRM": "600",
    "MIN_LLM": "1", "MIN_SIZE": "5000", "STRUCT_DROP": "0.3",
    "DISK_MIN_MB": "500", "BASELINE_EVERY": "86400",
    "TG_ENV": "/opt/dsh/telegram.env", "CHAT_ID": "",
    "CANARIES": "mcp-jev,messenger,permission",
})
TG = load_env(ENV["TG_ENV"])
TG_TOKEN = TG.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("DSH_GUARD_CHAT_ID") or ENV["CHAT_ID"]
FATAL_RE = re.compile(r"MISSING_CREDENTIAL|no (?:working )?provider|provider.*(?:failed|missing)", re.I)
JOURNAL_WIN = "5 min"

def log(msg):
    line = f"{time.strftime('%F %T')} {msg}"
    print(line, flush=True)
    try:
        with open(EVENTS, "a", encoding="utf-8") as f: f.write(line + "\n")
    except OSError: pass

def state_load():
    try: return json.load(open(STATE_F, encoding="utf-8"))
    except Exception: return {}
def state_save(st):
    tmp = STATE_F + ".tmp"
    json.dump(st, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_F)

def sha256(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""): h.update(chunk)
        return h.hexdigest()
    except OSError: return ""

def files_hash():
    return {p: sha256(p) for p in (PATCH, PKG)}

def suppressed():
    if os.path.exists(DISABLED): return "disabled"
    try:
        if time.time() - os.stat(SUSPEND).st_mtime < float(ENV["CANARY_CONFIRM"]) * 2:
            return "suspend"
    except OSError: pass
    return None

def session_activity():
    """(age_seconds, session_id) самой свежей активности в /dsh/.dsh/sessions."""
    newest, sid = 0.0, ""
    for d in glob.glob(os.path.join(SESSIONS, "*", "session-*")):
        for root, _, files in os.walk(d):
            for fn in files:
                if fn == "session.lock": continue
                try: m = os.stat(os.path.join(root, fn)).st_mtime
                except OSError: continue
                if m > newest: newest, sid = m, os.path.basename(d)
    return (time.time() - newest, sid) if newest else (1e9, "")

def dump_config_ok():
    """L1: хост сам собирает профиль своим парсером. True/False/None(не удалось запустить)."""
    try:
        env = {k: v for k, v in os.environ.items() if k != "NOTIFY_SOCKET"}
        env.update({"DSH_HOME": "/dsh/.dsh", "HOME": "/dsh"})
        r = subprocess.run(["/usr/local/bin/dsh", "--profile", "web", "--dump-config"],
                           env=env, capture_output=True, timeout=90)
        return r.returncode == 0
    except Exception as e:
        log(f"dump-config исключение: {e}")
        return None

def patch_ids():
    # и top-level (- id: X), и вложенные (    - id: X внутри insert/mcp-блоков)
    try: return set(re.findall(r"^\s*-\s*id:\s*(\S+)", open(PATCH, encoding="utf-8").read(), re.M))
    except OSError: return set()

def llm_count():
    try: return len(re.findall(r"^-\s*id:\s*llm-", open(PATCH, encoding="utf-8").read(), re.M))
    except OSError: return 0

def journal_fatal():
    try:
        r = subprocess.run(["journalctl", "-u", "dsh.service", "--since", f"-{JOURNAL_WIN}",
                            "--no-pager"], capture_output=True, text=True, timeout=30)
        return len(FATAL_RE.findall(r.stdout))
    except Exception: return 0

def struct_drop():
    """Доля id золотого манифеста, исчезнувших из патча."""
    g = json.load(open(GOLDEN_F, encoding="utf-8")) if os.path.exists(GOLDEN_F) else {"ids": []}
    missing = [i for i in g.get("ids", []) if i not in patch_ids()]
    return (len(missing) / len(g["ids"]), missing) if g.get("ids") else (0.0, [])

def health():
    """Возвращает (healthy: bool, reasons: list, kind: str)."""
    reasons, kind = [], "none"
    try:
        if os.path.getsize(PATCH) < int(ENV["MIN_SIZE"]):
            reasons.append(f"размер патча {os.path.getsize(PATCH)} < {ENV['MIN_SIZE']}"); kind = "broken"
    except OSError as e:
        reasons.append(f"патч не читается: {e}"); kind = "broken"
    n_llm = llm_count()
    if n_llm < int(ENV["MIN_LLM"]):
        reasons.append(f"провайдеров llm-*: {n_llm} < {ENV['MIN_LLM']}"); kind = "broken"
    for c in [x.strip() for x in ENV["CANARIES"].split(",") if x.strip()]:
        if c not in patch_ids():
            reasons.append(f"канарейка потеряна: id {c}")
            if kind == "none": kind = "canary"
    drop, missing = struct_drop()
    if drop > float(ENV["STRUCT_DROP"]):
        reasons.append(f"структурная диффа: исчезло {len(missing)}/{len(missing)+drop and ''}"
                       f"{int(drop*100)}% блоков (например: {', '.join(missing[:6])})")
        if kind == "none": kind = "struct"
    d_ok = dump_config_ok()
    if d_ok is False:
        reasons.append("dsh --dump-config: хост не может собрать профиль"); kind = "broken"
    elif d_ok is None:
        reasons.append("dump-config не запустился (проверка пропущена)")
    if journal_fatal() >= 10 and n_llm >= int(ENV["MIN_LLM"]) and d_ok:
        reasons.append(f"journalctl: >=10 фатальных строк за {JOURNAL_WIN} (MISSING_CREDENTIAL/провайдеры)")
        if kind == "none": kind = "journal"
    return (len(reasons) == 0, reasons, kind)

def disk_low():
    try:
        free = shutil.disk_usage("/opt").free // (1024 * 1024)
        return free < int(ENV["DISK_MIN_MB"]), free
    except OSError: return False, -1

def tg(method, **kw):
    if not TG_TOKEN: return None
    url = f"https://api.telegram.org/bot{TG_TOKEN}/{method}"
    try:
        req = urllib.request.urlopen(urllib.request.Request(
            url, data=json.dumps(kw).encode(), headers={"Content-Type": "application/json"}), timeout=15)
        return json.loads(req.read())
    except Exception as e:
        log(f"tg {method} ошибка: {e}"); return None

def tg_alert(text, buttons=None):
    kb = [[{"text": t, "callback_data": c} for t, c in b] for b in buttons] if buttons else None
    m = {"chat_id": CHAT_ID, "text": text[:4000], "parse_mode": "HTML"}
    if kb: m["reply_markup"] = {"inline_keyboard": kb}
    tg("sendMessage", **m)

def tg_handle_callbacks(st):
    off = st.get("tg_offset", 0)
    r = tg("getUpdates", offset=off, timeout=0)
    if not r or not r.get("ok"): return
    for u in r.get("result", []):
        st["tg_offset"] = u["update_id"] + 1
        cq = u.get("callback_query")
        if cq and cq.get("data") in ("guard_restore_yes", "guard_restore_no"):
            tg("answerCallbackQuery", callback_query_id=cq["id"])
            st["confirm_decision"] = "yes" if cq["data"].endswith("yes") else "no"
            tg_alert("✅ Принято: " + ("восстанавливаю канарейку" if st["confirm_decision"] == "yes"
                                        else "оставляю как есть (ваша воля)"))

SNAP_FILES = (PATCH, PKG)
def snapshot(tag, meta=None):
    ts = time.strftime("%Y%m%d-%H%M%S")
    d = os.path.join(BACKUPS, f"{ts}-{tag}")
    os.makedirs(d, exist_ok=True)
    for p in SNAP_FILES:
        if os.path.exists(p): shutil.copy2(p, d)
    info = {"tag": tag, "time": ts, "sha256": files_hash(), "ids": sorted(patch_ids()),
            "llm_count": llm_count(), **(meta or {})}
    json.dump(info, open(os.path.join(d, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    snaps = sorted(glob.glob(os.path.join(BACKUPS, "*")))
    for old in snaps[:-int(ENV.get("RETENTION", "20"))]:
        if os.path.isdir(old) and "baseline" not in old: shutil.rmtree(old, ignore_errors=True)
    log(f"снапшот {d}")
    return d

def valid_snapshot(d):
    try:
        m = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
        return m.get("llm_count", 0) >= int(ENV["MIN_LLM"]) and m.get("dump_ok", True)
    except Exception: return False

def golden_refresh():
    ids = patch_ids()
    json.dump({"ids": sorted(ids), "llm_count": llm_count(), "time": time.strftime("%F %T")},
              open(GOLDEN_F + ".tmp", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(GOLDEN_F + ".tmp", GOLDEN_F)

NOTICE_TMPL = """СТЕНД БЫЛ СЛОМАН ВО ВРЕМЯ РАБОТЫ СЕССИИ И ВОССТАНОВЛЕН ИЗ РЕЗЕРВНОЙ КОПИИ.
Сессия: {sid}. Что сломалось: {reasons}.
Конфиг откатан, хост DSH перезапущен. ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА ДАЛЬНЕЙШЕЙ РАБОТЫ:
— Никогда не перезаписывай файлы в /dsh/.dsh/** целиком (cp/mv/>): только точечные
  правки конкретных блоков через edit.
— Не удаляй и не комментируй блоки провайдеров (id: llm-*) и канарейки
  ({canaries}) в cordis.patch.yml: без них стенд неработоспособен.
— Не трогай /opt/dsh/*.env, юниты systemd, /opt/dsh/dsh-guard.
— Нужна правка конфига — покажи diff и дождись подтверждения пользователя.
Сломанное состояние сохранено в quarantine/ — ничего не потеряно."""

def restore(snap_dir, reasons, sid):
    low, free = disk_low()
    if low:
        tg_alert(f"🚨 dsh-guard: конфиг сломан ({'; '.join(reasons)}), но диска < {ENV['DISK_MIN_MB']} МБ ({free} МБ) — НЕ восстанавливаю автоматически."); return False
    ts = time.strftime("%Y%m%d-%H%M%S")
    qd = os.path.join(QUAR, ts)
    os.makedirs(qd, exist_ok=True)
    for p in SNAP_FILES:
        if os.path.exists(p): shutil.copy2(p, qd)
    json.dump({"reasons": reasons, "sid": sid, "snap": snap_dir},
              open(os.path.join(qd, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False)
    for p in SNAP_FILES:
        src = os.path.join(snap_dir, os.path.basename(p))
        if os.path.exists(src): shutil.copy2(src, p)
    diff_note = f"diff-копия сломанного: {qd}"
    tg_alert(f"🛠 dsh-guard: RESTORE выполнен.\nСессия: {sid or 'неизвестно'}\nПричины: {'; '.join(reasons)}\nQuarantine: {qd}\nСнапшот: {snap_dir}")
    if sid:
        with open(NOTICE, "w", encoding="utf-8") as f:
            f.write(NOTICE_TMPL.format(sid=sid, reasons="; ".join(reasons),
                                       canaries=", ".join(x.strip() for x in ENV["CANARIES"].split(","))))
    subprocess.run(["systemctl", "restart", "dsh.service"], timeout=60)
    ok = wait_healthy()
    if not ok:
        alt = [s for s in sorted(glob.glob(os.path.join(BACKUPS, "*"))) if valid_snapshot(s) and s != snap_dir]
        if alt:
            log("пост-верификация не прошла, пробую предыдущий снапшот")
            for p in SNAP_FILES:
                src = os.path.join(alt[-1], os.path.basename(p))
                if os.path.exists(src): shutil.copy2(src, p)
            subprocess.run(["systemctl", "restart", "dsh.service"], timeout=60)
            ok = wait_healthy()
    if not ok:
        tg_alert("🚨🚨 dsh-guard: восстановление не помогло — ТРЕБУЕТСЯ ЧЕЛОВЕК. Сторож уходит в карантин 15 мин.")
        return False
    tg_alert(f"✅ dsh-guard: пост-верификация пройдена, DSH здоров. {diff_note}")
    log(f"restore ok из {snap_dir}, sid={sid}")
    return True

def wait_healthy(timeout=120):
    deadline = time.time() + timeout
    time.sleep(20)  # grace
    while time.time() < deadline:
        if subprocess.run(["systemctl", "is-active", "--quiet", "dsh.service"]).returncode == 0 \
           and dump_config_ok() and llm_count() >= int(ENV["MIN_LLM"]):
            return True
        time.sleep(10)
    return False

def sd_notify(msg):
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr: return
    if addr.startswith("@"): addr = "\0" + addr[1:]
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.sendto(msg.encode(), addr); s.close()
    except OSError: pass

def main():
    for d in (BACKUPS, QUAR): os.makedirs(d, exist_ok=True)
    st = state_load()
    log(f"dsh-guard запущен, pid={os.getpid()}")
    sd_notify("READY=1")
    while True:
        try:
            sd_notify("WATCHDOG=1")
            if suppressed():
                time.sleep(float(ENV["POLL"])); continue
            tg_handle_callbacks(st)
            age, sid = session_activity()
            cur = files_hash()
            prev = st.get("hash", cur)
            now = time.time()
            if cur != prev:
                st["changed_at"] = now
                st["hash"] = cur
                st["evaluated_for"] = ""
            quiet_ok = cur == prev or (now - st.get("changed_at", 0)) >= float(ENV["DEBOUNCE"])
            eval_key = f"{cur.get(PATCH)}:{cur.get(PKG)}"
            if quiet_ok and st.get("evaluated_for") != eval_key:
                st["evaluated_for"] = eval_key
                healthy, reasons, kind = health()
                if healthy:
                    golden_refresh()
                    if age > float(ENV["WARM"]):        # правка вне сессии или сессия остыла → новый baseline
                        snapshot("baseline", {"sid": sid, "dump_ok": True})
                        st["last_baseline"] = now
                    log(f"healthy-изменение принято (sid={sid}, llm={llm_count()})")
                else:
                    hot, warm = float(ENV["HOT"]), float(ENV["WARM"])
                    if age < hot: thr, mode = float(ENV["HARD_HOT"]), "hot"
                    elif age < warm: thr, mode = float(ENV["HARD_WARM"]), "warm"
                    else: thr, mode = 0, "nosession"
                    log(f"unhealthy ({kind}): {reasons}; сессия age={int(age)}s mode={mode}")
                    if mode == "nosession":
                        if not st.get("alerted_nosession"):
                            tg_alert(f"⚠️ dsh-guard: конфиг нездоров без активной сессии.\n{'; '.join(reasons)}\nЕсли это не вы — восстановите: touch {DISABLED} не нужно, просто ответьте или выполните restore вручную из {BACKUPS}")
                            st["alerted_nosession"] = True
                    elif kind == "canary" and llm_count() >= int(ENV["MIN_LLM"]):
                        if st.get("confirm_decision") == "yes":
                            snaps = [s for s in sorted(glob.glob(os.path.join(BACKUPS, "*"))) if valid_snapshot(s)]
                            if snaps: restore(snaps[-1], reasons, sid)
                            st["confirm_decision"] = None
                        elif st.get("confirm_decision") == "no":
                            st["confirm_decision"] = None
                        elif not st.get("confirm_pending_at"):
                            st["confirm_pending_at"] = now
                            tg_alert(f"⚠️ dsh-guard: потеряна канарейка при активной сессии ({sid}).\n{'; '.join(reasons)}\nВосстановить блок? (дефолт через {int(ENV['CANARY_CONFIRM'])//60} мин — да)",
                                     buttons=[["Восстановить", "guard_restore_yes"], ["Это я удалил", "guard_restore_no"]])
                        elif now - st["confirm_pending_at"] > float(ENV["CANARY_CONFIRM"]):
                            st["confirm_pending_at"] = None
                            snaps = [s for s in sorted(glob.glob(os.path.join(BACKUPS, "*"))) if valid_snapshot(s)]
                            if snaps: restore(snaps[-1], reasons + ["(таймаут подтверждения)"], sid)
                    else:
                        st["bad_since"] = st.get("bad_since") or now
                        if now - st["bad_since"] >= thr:
                            snaps = [s for s in sorted(glob.glob(os.path.join(BACKUPS, "*"))) if valid_snapshot(s)]
                            if snaps:
                                restore(snaps[-1], reasons, sid)
                                st["restored_at"] = now; st["restore_count"] = st.get("restore_count", 0) + 1
                                if st["restore_count"] >= 3:
                                    tg_alert("🚨 dsh-guard: 3 восстановления за срок жизни процесса — системная проблема, нужен человек.")
                            else:
                                tg_alert(f"🚨 dsh-guard: конфиг сломан ({'; '.join(reasons)}), но ВАЛИДНЫХ СНАПШОТОВ НЕТ. Ручное восстановление требуется!")
                            st["bad_since"] = None
            else:
                if st.get("bad_since") and cur == prev:
                    h2, _, _ = health()
                    if h2: st["bad_since"] = None  # само починилось
            # граница сессии active→idle → коммит-снапшот
            was_active = st.get("sess_active")
            is_active = age < float(ENV["HOT"])
            if was_active and not is_active and age < float(ENV["WARM"]) and health()[0]:
                snapshot("session-end", {"sid": sid, "dump_ok": True})
                golden_refresh()
            st["sess_active"] = is_active
            if now - st.get("last_baseline", 0) > float(ENV["BASELINE_EVERY"]) and health()[0]:
                snapshot("baseline", {"dump_ok": True}); st["last_baseline"] = now
            state_save(st)
        except Exception as e:
            log(f"ОШИБКА ЦИКЛА: {e!r}")
        time.sleep(float(ENV["POLL"]))

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        st = state_load()
        age, sid = session_activity()
        h, r, k = health()
        print(json.dumps({"healthy": h, "kind": k, "reasons": r, "session_age_s": int(age),
                          "session": sid, "llm_count": llm_count(), **st}, ensure_ascii=False, indent=1))
    else:
        main()

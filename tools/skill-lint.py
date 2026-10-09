#!/usr/bin/env python3
"""skill-lint: проверка описаний скиллов под реальный каталог DSH (dsh-skill-folder обрезает до maxDescLength).
Использование: skill-lint.py [dir=/dsh/.agents/skills] [--cut 100] [--max 300]
Реальность каталога: dsh-skill-folder показывает модели первые maxDescLength (=100) символов; хост режет описание до 500; skill_search ищет по ≤500.
Проверки: нет description / имя != каталогу / >500 (ERR) / >--max (WARN) / нет триггера в первых --cut символов / агрессивные MUST|ALWAYS|NEVER.
Доп. проверки (информативные по умолчанию; WARN только с --strict, чтобы не ломать WARN=0):
  (a) двуязычный триггер (чеклист п.5): в первых 160 симв. должны быть латиница (use when/for) И кириллица,
      либо скилл в списке англоязычных исключений (EN_ONLY) внутри скрипта;
  (b) семейства по префиксу (gsap-*, pricewin-*, jev-*): в описании упомянут хотя бы один сосед (антитриггер).
Выход 1, если есть ERR."""
import os,re,sys,json
vals={sys.argv[i+1] for i,a in enumerate(sys.argv) if a.startswith('--') and i+1<len(sys.argv)}
args=[a for a in sys.argv[1:] if not a.startswith('--') and a not in vals]
root=args[0] if args else '/dsh/.agents/skills'
def opt(n,d):
    return int(sys.argv[sys.argv.index(n)+1]) if n in sys.argv else d
STRICT='--strict' in sys.argv
CUT=opt('--cut',100); MAXL=opt('--max',300); HARD=500
off=set(json.load(open('/dsh/.dsh/skills-manager/state.json'))['disabledSkills'].get('agents',[])) if os.path.exists('/dsh/.dsh/skills-manager/state.json') else set()
TRIG=re.compile(r'use when|use for|trigger|invoke|when the user|когда|используй|если пользовател|«|\'[а-яa-z ]+\'',re.I)
SHOUT=re.compile(r'\b(MUST|ALWAYS|NEVER|CRITICAL)\b')
# Чисто англоязычные скиллы (описания без кириллицы осмысленно): п.5 к ним не применяется.
EN_ONLY={'pr','tdd','restaurant-booking','ask-sonner','break-ui','wizard','write-swift',
         'codex-cli-calling','grok-cli-calling','hermes-cli-calling','kimi-cli-calling',
         'grill-with-docs','telegram-custom-emoji-mosaic'}
# Семейства по префиксу: антитриггер = в описании упомянут хотя бы один сосед.
FAMILIES=('gsap-','pricewin-','jev-')
RU=re.compile('[а-яА-ЯёЁ]'); LAT=re.compile(r'use (when|for)',re.I)
bi_bad=[]; fam_bad=[]
def parse(p):
    t=open(p,encoding='utf-8',errors='ignore').read()
    m=re.match(r'^---\n(.*?)\n---',t,re.S)
    if not m: return None,None
    fm=m.group(1)
    nm=re.search(r'^name:\s*(.+)$',fm,re.M)
    mm=re.search(r'^description:\s*(.*?)(?=^\S|\Z)',fm,re.S|re.M)
    d=mm.group(1).strip() if mm else None
    if d and d[:1] in '>|': d=' '.join(d.split('\n')[1:])
    if d: d=' '.join(d.strip().strip('"\'').split())
    return (nm.group(1).strip().strip('"\'') if nm else None),d
errs=warns=total=0; chars=0; shouts=[]
for s in sorted(os.listdir(root)):
    p=os.path.join(root,s,'SKILL.md')
    if not os.path.isfile(p) or s in off: continue
    n,d=parse(p); total+=1
    if not d: print(f'ERR  {s}: нет description'); errs+=1; continue
    chars+=min(len(d),CUT)
    if n!=s: print(f'ERR  {s}: name={n!r} != каталогу'); errs+=1
    if len(d)>HARD: print(f'ERR  {s}: {len(d)} симв. > {HARD} (хвост хоста обрежет)'); errs+=1
    elif len(d)>MAXL: print(f'WARN {s}: {len(d)} симв. > {MAXL}'); warns+=1
    if not TRIG.search(d[:CUT]) and len(d)>CUT: print(f'WARN {s}: триггер не в первых {CUT} симв. (обрежется в каталоге)'); warns+=1
    if SHOUT.search(d): shouts.append(s)
    head=d[:160]
    if s not in EN_ONLY and not (LAT.search(head) and RU.search(head)): bi_bad.append(s)
    for fam in FAMILIES:
        if s.startswith(fam):
            members=[t for t in os.listdir(root) if t.startswith(fam) and os.path.isfile(os.path.join(root,t,'SKILL.md'))]
            if not any(t!=s and t in d for t in members): fam_bad.append((fam,s))
if STRICT:
    for s in bi_bad: print(f'WARN {s}: в первых 160 симв. нет связки EN-триггер (use when/for) + кириллица (п.5 RU+EN)'); warns+=1
    for fam,s in fam_bad: print(f'WARN {s}: семейство {fam}* — в описании не упомянут ни один сосед (антитриггер)'); warns+=1
elif bi_bad or fam_bad:
    print(f'INFO двуязычный триггер (п.5): {len(bi_bad)} описаний не проходят (подробности: --strict): {", ".join(bi_bad[:15])}{"…" if len(bi_bad)>15 else ""}')
    print(f'INFO антитриггеры семейств ({", ".join(FAMILIES)}): {len(fam_bad)} описаний без упоминания соседа (подробности: --strict): {", ".join(s for _,s in fam_bad)}')
if len(shouts)>3: print(f'WARN агрессивные MUST/ALWAYS/NEVER в {len(shouts)} описаниях: {", ".join(shouts)}'); warns+=1
print(f'\nскиллов активных: {total}; каталог при cut={CUT}: ~{chars} симв. (~{chars//4} ток.); ERR={errs} WARN={warns}')
sys.exit(1 if errs else 0)

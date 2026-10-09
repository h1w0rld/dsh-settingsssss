#!/usr/bin/env python3
"""skill-fidelity: сохранность СМЫСЛА описаний (не маршрутизации). Для каждого скилла сравнивает описание с телом SKILL.md
(и со старым описанием из бэкапа, если есть) через Jev. Использование: skill-fidelity.py [--only a,b] [--old-dir backup-glob]
Вывод: строки FLAG для подозрительных; exit 1 если есть wrong/contradiction."""
import os,re,sys,json,glob,subprocess
H=os.path.dirname(os.path.abspath(__file__)); S='/dsh/.agents/skills'
def opt(n,d=None): return sys.argv[sys.argv.index(n)+1] if n in sys.argv else d
def split(p):
    t=open(p,encoding='utf-8').read(); m=re.match(r'^---\n(.*?)\n---\n?(.*)',t,re.S)
    mm=re.search(r'^description:\s*(.*?)(?=^\S|\Z)',m.group(1),re.S|re.M); d=mm.group(1).strip()
    if d[:1] in '>|': d=' '.join(d.split('\n')[1:])
    return ' '.join(d.strip().strip('"\'').split()), m.group(2)
off=set(json.load(open('/dsh/.dsh/skills-manager/state.json'))['disabledSkills'].get('agents',[]))
orig={}
for p in sorted(glob.glob(f'{H}/backup-20261007-151159/skills/*/SKILL.md')+glob.glob(f'{H}/backup-apply-*/skills/*/SKILL.md')): orig.setdefault(p.split('/')[-2],p)
names=[s for s in sorted(os.listdir(S)) if os.path.isfile(f'{S}/{s}/SKILL.md') and s not in off]
if opt('--only'): names=[n for n in names if n in opt('--only').split(',')]
else: names=[n for n in names if n in orig and split(orig[n])[0]!=split(f'{S}/{n}/SKILL.md')[0]]
bad=0
for n in names:
    new,body=split(f'{S}/{n}/SKILL.md'); old=split(orig[n])[0] if n in orig else '(нет)'
    st=f"SKILL: {n}\n\nNEW DESCRIPTION:\n{new}\n\nOLD DESCRIPTION (original, authoritative wording of purpose):\n{old}\n\nSKILL BODY (first 5000 chars):\n{body[:5000]}"
    q={"purpose":{"type":"choice","instructions":"Does NEW DESCRIPTION still tell the model what this skill actually DOES (its main function per BODY) and when to load it? faithful = main function and trigger conveyed; partial = trigger OK but main function or key capability lost/vague; wrong = misleading.","criteria":{"faithful":"main function + trigger conveyed","partial":"key function/capability lost or vague","wrong":"misleading"}},
       "fact":{"type":"noul","instructions":"Does NEW DESCRIPTION contain a factual claim that contradicts BODY (e.g. names a site, tool or scope the skill does not have)?"},
       "narrow":{"type":"noul","instructions":"Does NEW DESCRIPTION wrongly tell the model NOT to use this skill (or to prefer another skill) for cases that BODY says this skill covers?"}}
    for _ in range(3):
        r=subprocess.run(["/root/.local/bin/jev","run","--provider","openrouter","-"],input=json.dumps({"state":st,"questions":q}),capture_output=True,text=True)
        try: a=json.loads(r.stdout)["answers"]; break
        except Exception: a=None
    if a is None: print('ERR jev',n,r.stdout[:150]); continue
    pu=a["purpose"]["choice"]; fa=a["fact"].get("probability",a["fact"].get("noul",0)); na=a["narrow"].get("probability",a["narrow"].get("noul",0))
    flag=pu!='faithful' or fa>0.5 or na>0.5
    if flag: print(f'FLAG {n}: purpose={pu} fact={fa:.2f} narrow={na:.2f}')
    if pu=='wrong' or fa>0.7: bad+=1
print(f'проверено {len(names)}; критичных {bad}')
sys.exit(1 if bad else 0)

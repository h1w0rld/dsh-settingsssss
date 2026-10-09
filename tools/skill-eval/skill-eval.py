#!/usr/bin/env python3
"""skill-eval: качество маршрутизации «запрос → скилл» при реальном срезе каталога.
  skill-eval.py [--cut 100] [--overrides file.json] [--only name1,name2] [--dir /dsh/.agents/skills]
cases.json: [{"skill":..., "q":...}]. overrides.json: {"skill":"новое описание"} — проверка ДО применения.
Использует `jev run --provider openrouter` (≈$0.001/прогон). Выход 1, если точность <85%."""
import json,os,re,subprocess,sys
H=os.path.dirname(os.path.abspath(__file__))
def opt(n,d=None): return sys.argv[sys.argv.index(n)+1] if n in sys.argv else d
CUT=int(opt('--cut',100)); DIR=opt('--dir','/dsh/.agents/skills')
sys.path.insert(0,os.path.join(H,'..'))
def parse(p):
    t=open(p,encoding='utf-8',errors='ignore').read(); m=re.match(r'^---\n(.*?)\n---',t,re.S)
    if not m: return None
    mm=re.search(r'^description:\s*(.*?)(?=^\S|\Z)',m.group(1),re.S|re.M)
    if not mm: return None
    d=mm.group(1).strip()
    if d[:1] in '>|': d=' '.join(d.split('\n')[1:])
    return ' '.join(d.strip().strip('"\'').split())
off=set(json.load(open('/dsh/.dsh/skills-manager/state.json'))['disabledSkills'].get('agents',[]))
desc={s:parse(f'{DIR}/{s}/SKILL.md') for s in sorted(os.listdir(DIR)) if os.path.isfile(f'{DIR}/{s}/SKILL.md') and s not in off}
desc={k:v for k,v in desc.items() if v}
if opt('--overrides'): desc.update(json.load(open(opt('--overrides'))))
cut=lambda d: d if len(d)<=CUT else d[:CUT-3]+'...'
cat="\n".join(f"- {k}: {cut(v)}" for k,v in sorted(desc.items()))
cases=json.load(open(opt('--cases',f'{H}/cases.json')))
if opt('--only'): w=set(opt('--only').split(',')); cases=[c for c in cases if c['skill'] in w]
cases=[c for c in cases if c['skill'] in desc]
opts={k:"skill" for k in desc}; opts["__none__"]="none"
ok=0; miss=[]; B=6
for st in range(0,len(cases),B):
    ch=cases[st:st+B]
    qs={f"q{i}":{"type":"choice","instructions":f"Каталог скиллов — в state. Пользователь пишет: «{c['q']}». Какой скилл модель должна загрузить в первую очередь?","criteria":opts} for i,c in enumerate(ch)}
    for _ in range(3):
        r=subprocess.run(["/root/.local/bin/jev","run","--provider","openrouter","-"],input=json.dumps({"state":cat,"questions":qs}),capture_output=True,text=True)
        try: ans=json.loads(r.stdout)["answers"]; break
        except Exception: ans=None
    if ans is None: print("jev error:",r.stdout[:200]); sys.exit(2)
    for i,c in enumerate(ch):
        a=ans[f"q{i}"]["choice"]
        if a==c['skill']: ok+=1
        else: miss.append((c['skill'],a,c['q']))
print(f"cut={CUT} catalog={len(cat)} симв. accuracy={ok}/{len(cases)} ({100*ok//max(1,len(cases))}%)")
for m in miss: print("  MISS",m)
sys.exit(0 if ok*100>=85*len(cases) else 1)

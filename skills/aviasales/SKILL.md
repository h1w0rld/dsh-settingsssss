---
name: aviasales
description: "API-поиск дешёвых авиабилетов Aviasales/Travelpayouts. Use when «найди авиабилеты/билеты», cheap flights, «когда дешевле лететь», route+даты — любой маршрут, RU и EN. Не сравнение OTA-сайтов (pricewin-flight-search), не отели."
compatibility: Requires Node.js. AVIASALES_TOKEN must be set in .env at project root. Network access required.
metadata:
  author: godorov
  version: "1.0"
  api: Travelpayouts v2 (cached prices, last 48h)
---

# Aviasales Flight Search

Search flight prices via Travelpayouts v2 API.

The script is at `scripts/search.js` relative to this skill's directory.
Resolve the full path based on where the skill is installed, e.g.:
- Project skill: `node .claude/skills/aviasales/scripts/search.js`
- Global skill: `node ~/.claude/skills/aviasales/scripts/search.js`

`AVIASALES_TOKEN` is read from `.env` in the project root (where Claude Code is running).

## Workflow

1. Identify **origin**, **destination** (IATA codes), and **time frame** from the user's request.
2. If the user gives a city name instead of IATA — look it up in [references/iata.md](references/iata.md).
3. Pick the right command:
   - Specific date → `week`
   - Whole month → `month`
   - Cheapest overall → `latest`
   - No destination ("where's cheapest from LED?") → `latest` without `--to`
   - Compare nearby routes → `nearby`
4. Run the command via bash.
5. Report the cheapest option(s): price, date, airline, stops.

## Commands

```bash
node <skill-path>/scripts/search.js latest --from <IATA> [--to <IATA>] [--currency RUB] [--limit 10]
node <skill-path>/scripts/search.js month  --from <IATA> --to <IATA> --month YYYY-MM [--limit 15]
node <skill-path>/scripts/search.js week   --from <IATA> --to <IATA> --depart YYYY-MM-DD [--return YYYY-MM-DD]
node <skill-path>/scripts/search.js nearby --from <IATA> --to <IATA> [--depart YYYY-MM-DD] [--flex 0-7]
```

## Examples

**"Когда дешевле лететь из Питера в Бангкок в мае?"**
```bash
node <skill-path>/scripts/search.js month --from LED --to BKK --month 2026-05
```

**"Найди билеты LED → Пхукет около 10 апреля"**
```bash
node <skill-path>/scripts/search.js week --from LED --to HKT --depart 2026-04-10
```

**"Куда дешевле всего из Москвы?"**
```bash
node <skill-path>/scripts/search.js latest --from SVO --limit 20
```

See [references/iata.md](references/iata.md) for common IATA codes.

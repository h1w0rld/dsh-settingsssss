# ticket-search-aviasale

An [Agent Skill](https://agentskills.io) for searching cheap flights via the [Travelpayouts v2 API](https://travelpayouts.github.io/slate/#flight-data-access-api-v2) (Aviasales). Returns cached prices from the last 48 hours.

## Requirements

- Node.js
- Travelpayouts API token — get one at [travelpayouts.com](https://www.travelpayouts.com/programs/100/tools/api)

## Installation

**Project-level** (available only in current project):
```bash
git clone https://github.com/Yurgodo/ticket-search-aviasales .claude/skills/aviasales
```

**Global** (available in all Claude Code projects):
```bash
git clone https://github.com/Yurgodo/ticket-search-aviasales ~/.claude/skills/aviasales
```

## Setup

Create a `.env` file in your project root:
```bash
cp .claude/skills/aviasales/.env.example .env
# or if installed globally:
cp ~/.claude/skills/aviasales/.env.example .env
```

Fill in your token:
```
AVIASALES_TOKEN=your_token_here
```

## Usage

Once installed, Claude will automatically use this skill when you ask about flights. Examples:

- "Найди дешевые билеты из Питера в Бангкок"
- "Когда дешевле лететь LED → HKT в мае?"
- "Куда дешевле всего улететь из Москвы?"
- "Сравни цены на рейсы из Питера в Пхукет около 10 апреля"

## Commands

The skill runs `scripts/search.js` with one of four commands:

| Command  | Description                          | Key options                              |
|----------|--------------------------------------|------------------------------------------|
| `latest` | Latest prices, sorted by price       | `--from`, `--to`, `--limit`              |
| `month`  | Cheapest days in a given month       | `--from`, `--to`, `--month YYYY-MM`      |
| `week`   | Prices around a specific date (±3d)  | `--from`, `--to`, `--depart YYYY-MM-DD`  |
| `nearby` | Prices for nearby routes             | `--from`, `--to`, `--depart`, `--flex`   |

All commands accept `--currency` (default: RUB).

## Limitations

- Data is cached — prices reflect the last 48 hours, not real-time
- For real-time prices, use the [Travelpayouts Affiliate Search API](https://tickets-api.travelpayouts.com)

## License

MIT

# Documentation map — 3x-ui / Xray / клиенты (где что искать)

Проверено 2026-10-07. Первичное правило: **не выдумывать поля конфига** — только то, что явно есть в официальной документации.

## Xray-core (официальная документация Project X)

База: **https://xtls.github.io** (есть русский раздел `/ru/`).

| Что ищем | Куда |
|---|---|
| Полный дамп доков одним файлом (для LLM/офлайн) | https://xtls.github.io/llms-full.txt |
| Карта конфига (log/dns/routing/inbounds/outbounds/...) | https://xtls.github.io/en/config/ |
| Инбаунды по протоколам (VLESS, VMess, Trojan, SS, **Hysteria**, WireGuard, TUN) | https://xtls.github.io/en/config/inbounds/ |
| Аутбаунды (freedom+fragment, blackhole, **Hysteria**, warp-подобное) | https://xtls.github.io/en/config/outbounds/ |
| Транспорты: RAW, **XHTTP**, gRPC, WS, HTTPUpgrade, mKCP, Hysteria | https://xtls.github.io/en/config/transports/ |
| **REALITY** / TLS / FinalMask / Sockopt | https://xtls.github.io/en/config/transports/reality.html и т.д. |
| XTLS Vision глубокий разбор, fallback, browser dialer | https://xtls.github.io/en/config/features/ |
| XHTTP «Beyond REALITY» (режимы packet-up/stream-one, scMaxEachPostBytes, uplink placement) | https://xtls.github.io/en/config/transports/xhttp.html |
| Слойные гайды level-0…level-2 (reverse proxy/NAT и пр.) | https://xtls.github.io/en/document/ |
| Релизы/чейнджлог (сверять поведение версии) | https://github.com/XTLS/Xray-core/releases |

Важно (наш прод): Xray 26.x уже **нативно поддерживает Hysteria** (инбаунд/аутбаунд/транспорт в доках) — раньше мы считали, что нет. При проблемах Hy2 сверяться с `/en/config/inbounds/hysteria.html`.

## 3x-ui панель (MHSanaei)

| Что ищем | Куда |
|---|---|
| Главная док-база (установка, эксплуатация, **полный REST API reference**) | https://docs.sanaei.dev |
| README (фичи, БД, переменные окружения) | https://github.com/MHSanaei/3x-ui |
| PostgreSQL backend: `XUI_DB_TYPE=postgres`, `XUI_DB_DSN`, миграция sqlite→pg `x-ui migrate-db --dsn` | README → Database Options; https://docs.sanaei.dev/docs/reference/env-vars |
| **Кастомные шаблоны страницы подписки** (Go html/template, переменные `{{ .links }}`, `{{ .subUrl }}`, `?format=info` live-JSON) | https://github.com/MHSanaei/3x-ui/blob/main/docs/custom-subscription-templates.md |
| Health-monitor туннеля (`XUI_TUNNEL_HEALTH_*` — может сам рестартить xray, по умолчанию off) | README → Environment Variables |
| Исходники генератора подписки (откуда берётся адрес в ссылках) | репозиторий: `internal/sub/`, `web/html/` |

Критично для нас: адрес в выдаваемых ссылках (`localhost` vs реальный IP) задаётся на уровне панели/инбаунда — при багах типа «клиент подключается сам к себе» смотреть генератор подписки в исходниках и настройки Sub Domain/URI, а не клиента.

## Клиенты

| Клиент | Доки/источники |
|---|---|
| Happ (iOS/Android, ядро xray + отдельный hy2-движок) | https://www.hap.cyou — релизы/версии; логи ядра экспортируются из приложения (это клиентский xray-лог: `[Info] app/dispatcher`, `dialing to tcp/udp:...`) |
| sing-box (альтернативное ядро) | https://sing-box.sagernet.org/documentation/ |
| v2rayN / v2rayNG | https://github.com/2dust/... README |

Паттерн чтения клиентских Happ-логов: одна сессия лога = один запуск ядра; профиль активен → исходящие dials идут через его outbound (единицы dials на UDP-адрес сервера = Hy2-профиль; повторы/ошибки отсутствуют = QUIC умирает молча); сверять с серверным access.log по времени.

## Наш прод — отклонения от ванильных доков (не перепутать)

- 3x-ui — **самосборный KIT-форк, PostgreSQL** (не sqlite; `/etc/x-ui/x-ui.db` пустой). Вендорский install/update-скрипт НЕ запускать — затрёт кастом. Доки валидны для UI/API, но схему БД и юниты сверять с живой системой.
- Правки xray — только через `settings.xrayTemplateConfig` в PostgreSQL + `systemctl restart x-ui`; прямой edit config.json перетирается панелью.
- WARP outbound: reserved-байты [189,226,246] + `"noKernelTun": true`.
- Вся KIT-архитектура (nginx stream ssl_preread, маскировка, порт-хоп NAT) — самодельная, описана в `vpn-tspu-research`, не в доках.

#!/usr/bin/env node

/**
 * Aviasales Flight Data CLI (v2 API — кэш за 48ч)
 *
 * Команды:
 *   node search.js latest  --from LED --to HKT [--currency RUB] [--limit 10]
 *   node search.js month   --from LED --to HKT --month 2026-04
 *   node search.js week    --from LED --to HKT --depart 2026-04-10 [--return 2026-04-20]
 *   node search.js nearby  --from LED --to HKT [--depart 2026-04-10]
 *
 * Env (в .env файле):
 *   AVIASALES_TOKEN=ваш_токен
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Загрузка .env ---
// Ищем .env: сначала в корне проекта (process.cwd()), потом рядом со скиллом
const envPath = [
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '..', '.env'),
].find(fs.existsSync);
if (envPath) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .forEach(line => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    });
}

const TOKEN = process.env.AVIASALES_TOKEN;
if (!TOKEN) {
  console.error('Ошибка: нужен AVIASALES_TOKEN в .env или окружении');
  process.exit(1);
}

// --- Парсинг аргументов ---
const [command, ...rawArgs] = process.argv.slice(2);

const COMMANDS = ['latest', 'month', 'week', 'nearby'];
if (!command || !COMMANDS.includes(command)) {
  console.log(`Использование: node search.js <команда> [параметры]

Команды:
  latest   Последние цены по маршруту
  month    Цены по дням на месяц
  week     Цены на неделю вперёд
  nearby   Цены на соседние направления

Примеры:
  node search.js latest --from LED --to HKT
  node search.js month  --from LED --to HKT --month 2026-04
  node search.js week   --from LED --to HKT --depart 2026-04-10
  node search.js nearby --from LED --to HKT --depart 2026-04-10`);
  process.exit(0);
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    result[args[i].replace(/^--/, '')] = args[i + 1];
  }
  return result;
}

const opts = parseArgs(rawArgs);

// --- HTTP GET ---
function get(endpoint, params = {}) {
  const query = new URLSearchParams({ token: TOKEN, ...params }).toString();
  const url = `https://api.travelpayouts.com${endpoint}?${query}`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'X-Access-Token': TOKEN, 'Accept-Encoding': 'identity' } }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

// --- Форматирование ---
function currency(value, cur = 'RUB') {
  return `${value.toLocaleString('ru-RU')} ${cur}`;
}

function changes(n) {
  if (n === 0) return 'прямой';
  if (n === 1) return '1 пересадка';
  return `${n} пересадки`;
}

function printTable(rows) {
  if (!rows.length) { console.log('Данных нет.'); return; }
  console.log('');
  rows.forEach((r, i) => {
    const parts = [`#${i + 1}`];
    if (r.depart_date) parts.push(r.depart_date);
    if (r.return_date) parts.push(`→ ${r.return_date}`);
    if (r.destination) parts.push(`${r.origin || ''} → ${r.destination}`);
    if (r.value !== undefined) parts.push(currency(r.value, r.currency || 'RUB'));
    if (r.number_of_changes !== undefined) parts.push(`(${changes(r.number_of_changes)})`);
    if (r.airline) parts.push(`[${r.airline}]`);
    if (r.gate) parts.push(r.gate);
    if (r.actual === false) parts.push('[устарело]');
    console.log(parts.join('  '));
  });
  console.log('');
}

// --- Команды ---
async function cmdLatest() {
  if (!opts.from) { console.error('Нужен --from'); process.exit(1); }

  const params = {
    currency: opts.currency || 'RUB',
    origin: opts.from.toUpperCase(),
    period_type: 'year',
    limit: opts.limit || 10,
    show_to_affiliates: true,
    sorting: 'price',
  };
  if (opts.to) params.destination = opts.to.toUpperCase();

  console.log(`Последние цены: ${params.origin}${opts.to ? ' → ' + params.destination : ' → все'}`);

  const res = await get('/v2/prices/latest', params);
  if (!res.body.success) { console.error('Ошибка:', res.body); process.exit(1); }

  const rows = res.body.data.map(d => ({
    origin: d.origin,
    destination: d.destination,
    depart_date: d.depart_date,
    return_date: d.return_date || null,
    number_of_changes: d.number_of_changes,
    value: d.value,
    actual: d.actual,
  }));

  printTable(rows);
}

async function cmdMonth() {
  if (!opts.from || !opts.to || !opts.month) {
    console.error('Нужны --from, --to, --month (YYYY-MM)');
    process.exit(1);
  }

  const month = opts.month.length === 7 ? opts.month + '-01' : opts.month;
  const params = {
    currency: opts.currency || 'RUB',
    origin: opts.from.toUpperCase(),
    destination: opts.to.toUpperCase(),
    month,
    show_to_affiliates: true,
  };

  console.log(`Цены на месяц: ${params.origin} → ${params.destination}, ${opts.month}`);

  const res = await get('/v2/prices/month-matrix', params);
  if (!res.body.success) { console.error('Ошибка:', res.body); process.exit(1); }

  const rows = Object.values(res.body.data)
    .flat()
    .sort((a, b) => a.value - b.value)
    .slice(0, parseInt(opts.limit || 15))
    .map(d => ({
      depart_date: d.depart_date,
      return_date: d.return_date,
      number_of_changes: d.number_of_changes,
      value: d.value,
    }));

  printTable(rows);
}

async function cmdWeek() {
  if (!opts.from || !opts.to || !opts.depart) {
    console.error('Нужны --from, --to, --depart');
    process.exit(1);
  }

  const params = {
    currency: opts.currency || 'RUB',
    origin: opts.from.toUpperCase(),
    destination: opts.to.toUpperCase(),
    depart_date: opts.depart,
    show_to_affiliates: true,
  };
  if (opts.return) params.return_date = opts.return;

  console.log(`Цены на неделю: ${params.origin} → ${params.destination}, ~${opts.depart}`);

  const res = await get('/v2/prices/week-matrix', params);
  if (!res.body.success) { console.error('Ошибка:', res.body); process.exit(1); }

  const rows = res.body.data
    .sort((a, b) => a.value - b.value)
    .map(d => ({
      depart_date: d.depart_date,
      return_date: d.return_date,
      number_of_changes: d.number_of_changes,
      value: d.value,
    }));

  printTable(rows);
}

async function cmdNearby() {
  if (!opts.from || !opts.to) {
    console.error('Нужны --from и --to');
    process.exit(1);
  }

  const params = {
    currency: opts.currency || 'RUB',
    origin: opts.from.toUpperCase(),
    destination: opts.to.toUpperCase(),
    limit: opts.limit || 10,
    flexibility: opts.flex || 0,
    show_to_affiliates: true,
  };
  if (opts.depart) params.depart_date = opts.depart;
  if (opts.return) params.return_date = opts.return;

  console.log(`Соседние направления: ${params.origin} → ${params.destination}`);

  const res = await get('/v2/prices/nearest-places-matrix', params);
  if (!Array.isArray(res.body.prices)) { console.error('Ошибка:', res.body); process.exit(1); }

  const rows = res.body.prices
    .sort((a, b) => a.price - b.price)
    .slice(0, parseInt(opts.limit || 10))
    .map(d => ({
      origin: d.origin,
      destination: d.destination,
      depart_date: d.depart_date?.slice(0, 10),
      number_of_changes: d.transfers,
      value: d.price,
      gate: d.gate,
      airline: d.main_airline,
    }));

  printTable(rows);
}

// --- Запуск ---
const handlers = { latest: cmdLatest, month: cmdMonth, week: cmdWeek, nearby: cmdNearby };
handlers[command]().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});

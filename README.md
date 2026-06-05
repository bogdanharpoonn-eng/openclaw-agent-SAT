# Bybit Telegram Agent

Telegram-бот + HTTP API для **Bybit SPOT** (testnet/mainnet): баланс, PnL, risk-limits, угоди з захистом, голосові запити.

Стек: Node.js, Express, OpenAI (`gpt-4o-mini`, Whisper), Bybit API v5.

## Railway

Railway збирає через **Railpack** (`railway.toml`). Локальний Docker: `docker/Dockerfile`. Healthcheck: `GET /health`.

**Bybit 403 на Railway (навіть EU West):** регіон Amsterdam у тебе вже ок (`railwayRegion: europe-west4-drams3a`). Bybit CloudFront **блокує IP багатьох хмар** (Railway, AWS, Heroku), не лише США.

**Що спробувати по черзі:**
1. Redeploy з останнього коду — за замовчуванням `BYBIT_API_REGION=eu` → `https://api-testnet.bybit.eu`
2. API-ключі з **https://testnet.bybit.eu** (якщо були з `.com` — створи нові на EU testnet)
3. Якщо `/health` все ще `"bybitApi":"blocked"` — **статичний проксі** в Railway Variables:
   - `BYBIT_HTTPS_PROXY=http://user:pass@host:port` (QuotaGuard, VPS nginx, тощо)
4. Альтернатива: бот на **VPS** (Hetzner тощо), не PaaS — там Bybit зазвичай відповідає

Перевірка: `GET /bybit/ping` → `"bybitApi":"ok"`. Якщо `403 Forbidden for your country` — ключі ок, але **IP Railway заблокований**. Рішення: `BYBIT_HTTPS_PROXY` або VPS/локально на ПК.

**Testnet coins:** інколи нараховують **USD**, а не USDT. Бот торгує пари на кшталт `BTCUSDT` — потрібен **USDT** на Unified (Convert USD→USDT або новий Request Test Coins з USDT).

**Обов’язкові змінні:**
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `BASE_URL` — публічний URL (`https://<service>.up.railway.app`)
- `BYBIT_API_KEY`, `BYBIT_API_SECRET`
- `BYBIT_TESTNET=true` (рекомендовано на старті)
- `BYBIT_ACCOUNT_TYPE=UNIFIED` (для testnet зазвичай UNIFIED, не SPOT)

**Рекомендовано:**
- `TELEGRAM_CHAT_ALLOWLIST` — твій `chat_id`
- `BYBIT_ALERT_CHAT_ID` — алерти STOP

**Risk (за замовчуванням):**
- `BYBIT_DAILY_LOSS_LIMIT_PCT=10`
- `BYBIT_MAX_TRADE_PCT=30`
- `BYBIT_RESERVE_PCT=10`
- `BYBIT_AUTO_MONITOR=true`
- `BYBIT_AUTO_TRADE=false` — увімкни `true` для авто-угод на testnet

**Стратегія (за замовчуванням):**
- `BYBIT_BUY_DIP_PCT=1.5` — купівля при просадці від локального піку
- `BYBIT_TAKE_PROFIT_PCT=2` — продаж у плюс
- `BYBIT_STOP_LOSS_PCT=1.5` — продаж у мінус по позиції
- `BYBIT_AUTO_TRADE_PCT=15` — розмір угоди (% від max spend, не більше 30% ліміту)
- `BYBIT_MIN_TRADE_USDT=5`
- `BYBIT_TRADE_COOLDOWN_MS=300000` — пауза між угодами (5 хв)
- `BYBIT_POLL_MS=30000` — перевірка ринку

## Telegram

- Звичайні повідомлення → аналіз Bybit + відповідь
- Голос → Whisper → той самий потік
- `bybit status` — статус рахунку
- `стоп bybit` — kill-switch
- `bybit resume` — зняти ручний стоп

Webhook:
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<BASE_URL>/telegram/webhook
```

## API

| Метод | Шлях | Опис |
|--------|------|------|
| GET | `/health` | Живість сервісу |
| GET | `/bybit/status` | Баланс, PnL, ліміти |
| POST | `/bybit/stop` | Зупинити торгівлю |
| POST | `/bybit/resume` | Відновити (якщо ліміти дозволяють) |
| POST | `/bybit/order` | Угода з перевіркою risk engine |
| POST | `/agent` | Текстовий запит (завжди BYBIT_Agent) |
| POST | `/telegram/webhook` | Вхід від Telegram |

**Order buy:** `{ "side": "buy", "symbol": "BTCUSDT", "spend_usdt": 50 }`  
**Order sell:** `{ "side": "sell", "symbol": "BTCUSDT", "qty": 0.001 }`

## Локально

```bash
npm install
cp .env.example .env
npm start
```

## Структура

- `bybit.js` — API Bybit + risk engine
- `index.js` — сервер, Telegram, `/agent`
- `agents.json` — один агент `BYBIT_Agent`
- `prompts/bybit_agent.txt` — інструкція агента

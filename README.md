# Bybit Telegram Agent

Telegram-бот + HTTP API для **Bybit SPOT** (testnet/mainnet): баланс, PnL, risk-limits, угоди з захистом, голосові запити.

Стек: Node.js, Express, OpenAI (`gpt-4o-mini`, Whisper), Bybit API v5.

## Railway

`Dockerfile` — Node.js only. Healthcheck: `GET /health`.

**Обов’язкові змінні:**
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `BASE_URL` — публічний URL (`https://<service>.up.railway.app`)
- `BYBIT_API_KEY`, `BYBIT_API_SECRET`
- `BYBIT_TESTNET=true` (рекомендовано на старті)

**Рекомендовано:**
- `TELEGRAM_CHAT_ALLOWLIST` — твій `chat_id`
- `BYBIT_ALERT_CHAT_ID` — алерти STOP

**Risk (за замовчуванням):**
- `BYBIT_DAILY_LOSS_LIMIT_PCT=10`
- `BYBIT_MAX_TRADE_PCT=30`
- `BYBIT_RESERVE_PCT=10`
- `BYBIT_AUTO_MONITOR=true`
- `BYBIT_AUTO_TRADE=false`

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

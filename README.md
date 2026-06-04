# openclaw-agent-SAT

HTTP-сервіс для **маршрутизації запитів до кількох «субагентів»** (різні системні промпти) з опційним підвантаженням веб-сторінок. Зручно викликати з **n8n** (вузол HTTP Request).

Це **не** повноцінний [OpenClaw Gateway](https://github.com/openclaw/openclaw) — окремий легкий движок на Express + OpenAI API.

## Вимоги

- Node.js 18+ (потрібен глобальний `fetch`)
- Ключ API: `OPENAI_API_KEY`

## Встановлення та запуск

```bash
npm install
npm start
```

За замовчуванням сервер слухає порт **3000** (змінити: `PORT=8080`).

## Railway (Docker)

`Dockerfile` — легкий образ **Node.js only** (швидший деплой). Healthcheck: `GET /health`.

Мінімум змінних у Railway:
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `BASE_URL` (публічний URL сервісу, напр. `https://<service>.up.railway.app`)
- `TELEGRAM_CHAT_ALLOWLIST` (рекомендовано)
- `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `BYBIT_TESTNET=true` (якщо потрібен Bybit)

## Змінні середовища

| Змінна | Опис |
|--------|------|
| `OPENAI_API_KEY` | Обов’язково. Ключ OpenAI. |
| `PORT` | Порт сервера (за замовчуванням `3000`). |
| `WEB_FETCH_TIMEOUT_MS` | Таймаут завантаження URL (за замовчуванням `8000`). |
| `WEB_FETCH_MAX_CHARS` | Максимум символів з однієї сторінки (за замовчуванням `12000`). |
| `WEB_FETCH_ALLOWLIST` | Через кому: дозволені **домени** для `fetch` (наприклад `example.com,docs.example.com`). Якщо порожньо — дозволені всі `http`/`https` (обережно в проді). |
| `SCRAPLING_BIN` | Шлях до бінарника Scrapling (за замовчуванням `scrapling`). |
| `SCRAPE_TIMEOUT_MS` | Таймаут запуску Scrapling у мс (за замовчуванням `45000`). |
| `SCRAPLING_NO_VERIFY` | Якщо `true`, Scrapling запускається з `--no-verify` (корисно при локальній SSL-проблемі сертифікатів). |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота для endpoint-ів `/telegram/*`. |
| `BASE_URL` | Публічний URL сервісу (використовується для налаштування webhook). |
| `TELEGRAM_CHAT_ALLOWLIST` | Список дозволених `chat_id` через кому. Якщо порожньо — дозволені всі чати. |
| `TELEGRAM_RATE_LIMIT_WINDOW_MS` | Вікно rate limit у мс (за замовчуванням `60000`). |
| `TELEGRAM_RATE_LIMIT_MAX` | Максимум повідомлень на `chat_id` за вікно (за замовчуванням `20`). |
| `TELEGRAM_VOICE_MAX_BYTES` | Максимальний розмір голосового файлу для розпізнавання (за замовчуванням `26214400`, ліміт Whisper ~25 MB). |
| `WHISPER_LANGUAGE` | Опційно: код мови для Whisper (наприклад `uk`). Якщо не задано — авто. |
| `ERROR_LOG_FILE` | Шлях до файлу логів помилок (за замовчуванням `logs/errors.log`). |

## API

### `POST /agent`

Основний виклик для n8n.

**Тіло (JSON):**

- `message` або `prompt` (рядок) — запит користувача; **обов’язково одне з них**.
- `use_web` (boolean, опційно) — намагатися підтягнути веб-контекст.
- `urls` (масив рядків, опційно) — явний список URL. Якщо не передано, URL можуть бути витягнуті з тексту `prompt` (до 3 штук).
- `use_scrape` (boolean, опційно) — для `web_scraping_agent` вмикає Scrapling-контекст (за замовчуванням увімкнено).
- `scrape_mode` (опційно): `get` | `fetch` | `stealthy-fetch`.
- `css_selector`, `wait_selector`, `scrape_timeout_ms` (опційно) — параметри для Scrapling.

**Відповідь:** `text/plain` — текст відповіді моделі.

**Помилки:** `400` (немає повідомлення), `502` (увімкнено веб, але жоден URL не завантажився), `500`.

### `POST /fetch`

Завантажити один URL і повернути текст (з HTML робиться спрощене перетворення в текст).

**Тіло:** `{ "url": "https://..." }`

**Відповідь (JSON):** `{ "status": "ok", "url", "content" }` або `{ "status": "error", "message" }`.

### `POST /scrape`

Реальний запуск Scrapling CLI для збору контенту сторінки.

**Тіло (JSON):**

- `url` (рядок, обов’язково)
- `mode` (опційно): `get` | `fetch` | `stealthy-fetch` (за замовчуванням `get`)
- `css_selector` (опційно)
- `wait_selector` (опційно, для `fetch` / `stealthy-fetch`)
- `timeout_ms` (опційно)

**Відповідь (JSON):** `{ "status": "ok", "url", "mode", "content" }` або `{ "status": "error", "message" }`.

### `GET /capabilities`

Список агентів з `agents.json` у вигляді тексту (ім’я, id, опис).

### `POST /telegram/webhook`

Приймає webhook-повідомлення від Telegram, викликає `/agent`, і надсилає відповідь назад у чат через Telegram Bot API. Підтримуються **текстові** повідомлення та **голосові** (`voice`): аудіо завантажується з Telegram і транскрибується через **OpenAI Whisper** (`whisper-1`, потрібен `OPENAI_API_KEY`).

### `POST /telegram/send`

Ручна відправка повідомлення в Telegram-чат.

**Тіло (JSON):**

- `chat_id` (обов’язково)
- `text` (обов’язково)

### Bybit SPOT (`BYBIT_Agent`)

Потрібні ключі API (спочатку **testnet**): `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `BYBIT_TESTNET=true`.

| Змінна | За замовчуванням | Опис |
|--------|------------------|------|
| `BYBIT_DAILY_LOSS_LIMIT_PCT` | `10` | Стоп нових угод, якщо денний PnL ≤ -10% |
| `BYBIT_MAX_TRADE_PCT` | `30` | Макс. сума однієї угоди від доступного USDT |
| `BYBIT_RESERVE_PCT` | `10` | Резерв USDT, який не використовується |
| `BYBIT_AUTO_MONITOR` | `true` | Фоновий моніторинг лімітів |
| `BYBIT_AUTO_TRADE` | `false` | Авто-угоди (стратегія окремо; за замовчуванням вимкнено) |
| `BYBIT_ALERT_CHAT_ID` | — | Telegram chat_id для алертів STOP |

**Endpoints:** `GET /bybit/status`, `POST /bybit/stop`, `POST /bybit/resume`, `POST /bybit/order`  
**Тіло order (buy):** `{ "side": "buy", "symbol": "BTCUSDT", "spend_usdt": 50 }`  
**Тіло order (sell):** `{ "side": "sell", "symbol": "BTCUSDT", "qty": 0.001 }`

**Telegram:** `bybit status`, `стоп bybit`, `bybit resume`

### `GET /health/scrapling`

Швидка перевірка, чи Scrapling реально працює в runtime (тестовий запит до `https://example.com`).

## Як обирається агент

1. Якщо в конфігу лише **один** агент — завжди він.
2. Інакше: за збігом **ключових слів** у тексті запиту з поля `keywords` у `agents.json`.
3. Якщо ключові слова не спрацювали — **класифікатор** (окремий виклик LLM) обирає `agent`; за замовчуванням для загальних запитів — `general_assistant`.

## Структура репозиторію

| Шлях | Призначення |
|------|-------------|
| `agents.json` | id агента, `display_name`, `description`, `keywords`, `prompt_file` |
| `prompts/*.txt` | системні інструкції для кожного агента |
| `index.js` | Express-додаток і логіка маршрутизації |

## Приклад для n8n

**HTTP Request → Method POST → URL** `http://<ваш-хост>:3000/agent`  
**Body → JSON:**

```json
{
  "message": "Зібери чернетку n8n-флоу для відправки повідомлення в Telegram після нового рядка в Airtable",
  "use_web": false
}
```

## Обмеження

- Модель у коді зафіксована як **`gpt-4o-mini`** (класифікатор і основна відповідь).
- Для **кількох ізольованих агентів OpenClaw** з каналами, сесіями та `openclaw.json` див. офіційну документацію OpenClaw — цей репозиторій їх не замінює.

## Ліцензія

Уточніть у власника репозиторію (ТОВ ТК САТ / внутрішній проєкт).

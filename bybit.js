import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  ensureStrategyState,
  evaluateStrategy,
  getCoinAvailable,
  getStrategyConfig,
  parseSymbolPair,
  recordBuy,
  recordSell,
} from "./bybit-strategy.js";

const TESTNET = String(process.env.BYBIT_TESTNET || "true").toLowerCase() === "true";
const BASE_URL = TESTNET ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
const STATE_FILE = process.env.BYBIT_STATE_FILE || path.join(process.cwd(), "data", "bybit-state.json");
const DAILY_LOSS_LIMIT_PCT = Number(process.env.BYBIT_DAILY_LOSS_LIMIT_PCT || 10);
const MAX_TRADE_PCT = Number(process.env.BYBIT_MAX_TRADE_PCT || 30);
const RESERVE_PCT = Number(process.env.BYBIT_RESERVE_PCT || 10);
const AUTO_MONITOR = String(process.env.BYBIT_AUTO_MONITOR || "true").toLowerCase() === "true";
const AUTO_TRADE = String(process.env.BYBIT_AUTO_TRADE || "false").toLowerCase() === "true";
const POLL_MS = Number(process.env.BYBIT_POLL_MS || 30000);
const DEFAULT_SYMBOL = process.env.BYBIT_SYMBOL || "BTCUSDT";
const TIMEZONE = process.env.BYBIT_TIMEZONE || "Europe/Kyiv";

let monitorTimer = null;
let onMonitorAlert = null;

function getApiKey() {
  return (process.env.BYBIT_API_KEY || "").trim();
}

function getApiSecret() {
  return (process.env.BYBIT_API_SECRET || "").trim();
}

export function isConfigured() {
  return Boolean(getApiKey() && getApiSecret());
}

async function parseBybitResponse(response, context) {
  const raw = await response.text();
  if (!raw || !raw.trim()) {
    throw new Error(`${context}: empty response (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    const preview = raw.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`${context}: not JSON (HTTP ${response.status}): ${preview}`);
  }
}

function getDayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    ensureStrategyState(parsed);
    return parsed;
  } catch {
    return {
      dayKey: "",
      dayStartEquityUsdt: 0,
      tradingStopped: false,
      stopReason: "",
      lastEquityUsdt: 0,
      manualKill: false,
      strategy: {
        peakPrice: 0,
        position: null,
        lastTradeAt: 0,
        lastAction: "",
      },
    };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

async function signedRequest(method, endpoint, query = {}, body = null) {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET not configured");
  }

  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  let url = `${BASE_URL}${endpoint}`;
  let signPayload = "";

  if (method === "GET") {
    const qs = new URLSearchParams(query).toString();
    signPayload = timestamp + apiKey + recvWindow + qs;
    if (qs) url += `?${qs}`;
  } else {
    const bodyStr = body == null ? "" : JSON.stringify(body);
    signPayload = timestamp + apiKey + recvWindow + bodyStr;
  }

  const sign = crypto.createHmac("sha256", apiSecret).update(signPayload).digest("hex");
  const headers = {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-SIGN": sign,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : (body == null ? undefined : JSON.stringify(body)),
  });
  const data = await parseBybitResponse(response, `${method} ${endpoint}`);
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit API error ${data.retCode}`);
  }
  return data.result;
}

async function publicGet(endpoint, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE_URL}${endpoint}${qs ? `?${qs}` : ""}`;
  const response = await fetch(url);
  const data = await parseBybitResponse(response, `GET ${endpoint}`);
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit public API error ${data.retCode}`);
  }
  return data.result;
}

export async function getSpotUsdtSnapshot() {
  const result = await signedRequest("GET", "/v5/account/wallet-balance", {
    accountType: "SPOT",
  });
  const row = result?.list?.[0];
  if (!row) {
    return { equityUsdt: 0, availableUsdt: 0, coins: [] };
  }

  const coins = Array.isArray(row.coin) ? row.coin : [];
  const usdt = coins.find(c => c.coin === "USDT") || {};
  const availableUsdt = Number(usdt.availableToWithdraw || usdt.walletBalance || 0);
  const equityUsdt = Number(row.totalEquityUsd || row.totalWalletBalance || availableUsdt);

  return {
    equityUsdt: Number.isFinite(equityUsdt) ? equityUsdt : availableUsdt,
    availableUsdt: Number.isFinite(availableUsdt) ? availableUsdt : 0,
    coins,
  };
}

export async function getSpotSnapshot() {
  return getSpotUsdtSnapshot();
}

export async function getSpotTicker(symbol = DEFAULT_SYMBOL) {
  const result = await publicGet("/v5/market/tickers", { category: "spot", symbol });
  const row = result?.list?.[0];
  return {
    symbol,
    lastPrice: Number(row?.lastPrice || 0),
    bid: Number(row?.bid1Price || 0),
    ask: Number(row?.ask1Price || 0),
  };
}

function computeLimits(availableUsdt) {
  const reserveUsdt = availableUsdt * (RESERVE_PCT / 100);
  const tradableUsdt = Math.max(0, availableUsdt - reserveUsdt);
  const maxSpendUsdt = tradableUsdt * (MAX_TRADE_PCT / 100);
  return { reserveUsdt, tradableUsdt, maxSpendUsdt };
}

export async function refreshStatus() {
  const snapshot = await getSpotUsdtSnapshot();
  const state = await loadState();
  ensureStrategyState(state);
  const dayKey = getDayKey();
  const equityUsdt = snapshot.equityUsdt;

  if (state.dayKey !== dayKey) {
    state.dayKey = dayKey;
    state.dayStartEquityUsdt = equityUsdt;
    if (!state.manualKill) {
      state.tradingStopped = false;
      state.stopReason = "";
    }
  }

  if (!state.dayStartEquityUsdt || state.dayStartEquityUsdt <= 0) {
    state.dayStartEquityUsdt = equityUsdt;
  }

  state.lastEquityUsdt = equityUsdt;

  const dayPnlUsdt = equityUsdt - state.dayStartEquityUsdt;
  const dayPnlPct = state.dayStartEquityUsdt > 0
    ? (dayPnlUsdt / state.dayStartEquityUsdt) * 100
    : 0;

  if (!state.tradingStopped && dayPnlPct <= -DAILY_LOSS_LIMIT_PCT) {
    state.tradingStopped = true;
    state.stopReason = `Денний ліміт збитку ${DAILY_LOSS_LIMIT_PCT}% досягнуто (${dayPnlPct.toFixed(2)}%)`;
  }

  await saveState(state);

  const limits = computeLimits(snapshot.availableUsdt);

  return {
    testnet: TESTNET,
    symbol: DEFAULT_SYMBOL,
    equityUsdt,
    availableUsdt: snapshot.availableUsdt,
    dayStartEquityUsdt: state.dayStartEquityUsdt,
    dayPnlUsdt,
    dayPnlPct,
    tradingStopped: state.tradingStopped || state.manualKill,
    stopReason: state.manualKill ? (state.stopReason || "Manual STOP") : state.stopReason,
    manualKill: state.manualKill,
    autoTradeEnabled: AUTO_TRADE,
    strategy: state.strategy,
    strategyConfig: getStrategyConfig(),
    limits: {
      dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT,
      maxTradePct: MAX_TRADE_PCT,
      reservePct: RESERVE_PCT,
      ...limits,
    },
  };
}

export async function setKillSwitch(stop, reason = "Manual STOP") {
  const state = await loadState();
  state.manualKill = Boolean(stop);
  state.tradingStopped = Boolean(stop);
  state.stopReason = stop ? reason : "";
  await saveState(state);
  return refreshStatus();
}

export async function resumeTrading() {
  const state = await loadState();
  state.manualKill = false;
  state.tradingStopped = false;
  state.stopReason = "";
  await saveState(state);
  return refreshStatus();
}

export function validateSpendUsdt(status, spendUsdt) {
  if (!Number.isFinite(spendUsdt) || spendUsdt <= 0) {
    return { ok: false, reason: "Сума угоди має бути > 0 USDT" };
  }
  if (status.tradingStopped) {
    return { ok: false, reason: status.stopReason || "Торгівлю зупинено" };
  }
  if (spendUsdt > status.limits.maxSpendUsdt) {
    return {
      ok: false,
      reason: `Перевищено ліміт ${MAX_TRADE_PCT}% на угоду: max ${status.limits.maxSpendUsdt.toFixed(2)} USDT`,
    };
  }
  if (spendUsdt > status.availableUsdt) {
    return { ok: false, reason: "Недостатньо вільного USDT на SPOT" };
  }
  return { ok: true };
}

export async function placeSpotMarketBuy({ symbol = DEFAULT_SYMBOL, spendUsdt }) {
  const status = await refreshStatus();
  const check = validateSpendUsdt(status, spendUsdt);
  if (!check.ok) {
    return { ok: false, reason: check.reason, status };
  }

  const qty = spendUsdt.toFixed(2);
  const result = await signedRequest("POST", "/v5/order/create", {}, {
    category: "spot",
    symbol,
    side: "Buy",
    orderType: "Market",
    qty,
    marketUnit: "quoteCoin",
  });

  return { ok: true, order: result, status: await refreshStatus() };
}

export async function placeSpotMarketSell({ symbol = DEFAULT_SYMBOL, qty }) {
  const status = await refreshStatus();
  if (status.tradingStopped) {
    return { ok: false, reason: status.stopReason || "Торгівлю зупинено", status };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "qty має бути > 0", status };
  }

  const result = await signedRequest("POST", "/v5/order/create", {}, {
    category: "spot",
    symbol,
    side: "Sell",
    orderType: "Market",
    qty: String(qty),
  });

  return { ok: true, order: result, status: await refreshStatus() };
}

export async function buildAgentContext() {
  if (!isConfigured()) {
    return "Bybit API не налаштовано (немає BYBIT_API_KEY/SECRET).";
  }
  try {
    const status = await refreshStatus();
    const ticker = await getSpotTicker(status.symbol);
    return [
      "Дані Bybit SPOT (джерело правди, не вигадуй):",
      `- Режим: ${status.testnet ? "TESTNET" : "MAINNET"}`,
      `- Символ за замовчуванням: ${status.symbol}`,
      `- Ціна: ${ticker.lastPrice}`,
      `- Equity USDT: ${status.equityUsdt}`,
      `- Доступно USDT: ${status.availableUsdt}`,
      `- PnL за день: ${status.dayPnlUsdt.toFixed(2)} USDT (${status.dayPnlPct.toFixed(2)}%)`,
      `- Торгівля дозволена: ${status.tradingStopped ? "НІ" : "ТАК"}`,
      status.tradingStopped ? `- Причина стопу: ${status.stopReason}` : "",
      `- Макс. сума угоди зараз: ${status.limits.maxSpendUsdt.toFixed(2)} USDT`,
      `- Денний ліміт збитку: ${DAILY_LOSS_LIMIT_PCT}%`,
      `- Резерв: ${RESERVE_PCT}%`,
      `- Авто-стратегія: ${AUTO_TRADE ? "увімкнена" : "вимкнена"}`,
      status.strategy?.position
        ? `- Позиція: entry ${status.strategy.position.entryPrice}, qty ${status.strategy.position.qty}`
        : "- Позиція: немає",
      status.strategy?.lastAction ? `- Остання дія: ${status.strategy.lastAction}` : "",
      "- Тільки SPOT, без маржі та без плеча.",
      "- Не пропонуй угоди, що перевищують max spend або доступний баланс.",
    ].filter(Boolean).join("\n");
  } catch (err) {
    return `Bybit помилка контексту: ${err.message}`;
  }
}

export async function getStatusText() {
  let status;
  let ticker;
  try {
    status = await refreshStatus();
    ticker = await getSpotTicker(status.symbol);
  } catch (err) {
    throw new Error(err?.message || "Bybit API request failed");
  }
  return [
    `Bybit ${status.testnet ? "TESTNET" : "MAINNET"} (SPOT)`,
    `Символ: ${status.symbol} | Ціна: ${ticker.lastPrice}`,
    `Equity: ${status.equityUsdt.toFixed(2)} USDT`,
    `Доступно: ${status.availableUsdt.toFixed(2)} USDT`,
    `PnL день: ${status.dayPnlPct.toFixed(2)}% (${status.dayPnlUsdt.toFixed(2)} USDT)`,
    `Торгівля: ${status.tradingStopped ? "ЗУПИНЕНО" : "АКТИВНА"}`,
    status.tradingStopped ? `Причина: ${status.stopReason}` : "",
    `Макс. угода: ${status.limits.maxSpendUsdt.toFixed(2)} USDT (${MAX_TRADE_PCT}%)`,
    `Денний стоп: -${DAILY_LOSS_LIMIT_PCT}%`,
    `Авто-угоди: ${AUTO_TRADE ? "увімкнено" : "вимкнено"}`,
    `Стратегія: dip -${getStrategyConfig().buyDipPct}% | TP +${getStrategyConfig().takeProfitPct}% | SL -${getStrategyConfig().stopLossPct}%`,
    status.strategy?.position
      ? `Позиція: ${status.strategy.position.qty} @ ${status.strategy.position.entryPrice}`
      : "Позиція: —",
    status.strategy?.lastAction ? `Останнє: ${status.strategy.lastAction}` : "",
  ].filter(Boolean).join("\n");
}

async function runAutoStrategy(status) {
  const state = await loadState();
  const strategy = ensureStrategyState(state);
  const ticker = await getSpotTicker(status.symbol);
  const snapshot = await getSpotUsdtSnapshot();
  const price = ticker.lastPrice;

  if (!price || price <= 0) return null;

  const decision = evaluateStrategy({
    price,
    status,
    strategy,
    coins: snapshot.coins,
    symbol: status.symbol,
  });

  let alertText = null;

  if (decision.action === "buy" && decision.spendUsdt) {
    const result = await placeSpotMarketBuy({ symbol: status.symbol, spendUsdt: decision.spendUsdt });
    if (result.ok) {
      const after = await getSpotUsdtSnapshot();
      const { base } = parseSymbolPair(status.symbol);
      const qty = getCoinAvailable(after.coins, base);
      recordBuy(strategy, { price, qty, symbol: status.symbol });
      await saveState(state);
      alertText = `✅ BUY ${status.symbol}\n${decision.reason}\nСума: ${decision.spendUsdt} USDT\nQty≈${qty}`;
    } else {
      alertText = `⛔ BUY відхилено: ${result.reason}`;
    }
  } else if (decision.action === "sell" && decision.sellQty) {
    const sellQty = Number(decision.sellQty.toFixed(6));
    const result = await placeSpotMarketSell({ symbol: status.symbol, qty: sellQty });
    if (result.ok) {
      recordSell(strategy, price);
      await saveState(state);
      alertText = `✅ SELL ${status.symbol}\n${decision.reason}\nQty: ${sellQty}`;
    } else {
      alertText = `⛔ SELL відхилено: ${result.reason}`;
    }
  } else if (decision.action === "hold") {
    await saveState(state);
  }

  return alertText;
}

async function monitorTick() {
  if (!isConfigured()) return;
  try {
    const prev = await loadState();
    const status = await refreshStatus();
    if (status.tradingStopped && !prev.tradingStopped && onMonitorAlert) {
      await onMonitorAlert(`⚠️ Bybit STOP: ${status.stopReason}`);
    }
    if (AUTO_TRADE && !status.tradingStopped) {
      const tradeAlert = await runAutoStrategy(status);
      if (tradeAlert && onMonitorAlert) {
        await onMonitorAlert(tradeAlert);
      }
    } else {
      const state = await loadState();
      ensureStrategyState(state);
      await saveState(state);
    }
  } catch (err) {
    console.error("Bybit monitor error:", err.message);
  }
}

export function startAutoMonitor(alertCallback) {
  if (!AUTO_MONITOR || !isConfigured()) return;
  onMonitorAlert = alertCallback || null;
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(monitorTick, POLL_MS);
  monitorTick();
}

export function stopAutoMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

export function getPublicConfig() {
  return {
    testnet: TESTNET,
    dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT,
    maxTradePct: MAX_TRADE_PCT,
    reservePct: RESERVE_PCT,
    autoMonitor: AUTO_MONITOR,
    autoTrade: AUTO_TRADE,
    symbol: DEFAULT_SYMBOL,
    configured: isConfigured(),
    strategy: getStrategyConfig(),
  };
}

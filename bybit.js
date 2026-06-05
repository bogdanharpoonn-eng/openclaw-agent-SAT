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

const API_BASES = {
  testnet: {
    global: "https://api-testnet.bybit.com",
    eu: "https://api-testnet.bybit.eu",
  },
  mainnet: {
    global: "https://api.bybit.com",
    eu: "https://api.bybit.eu",
  },
};

export function resolveBybitBaseUrl() {
  const custom = (process.env.BYBIT_API_BASE_URL || "").trim();
  if (custom) return custom.replace(/\/$/, "");
  const region = (process.env.BYBIT_API_REGION || "eu").trim().toLowerCase();
  const map = TESTNET ? API_BASES.testnet : API_BASES.mainnet;
  return map[region] || map.global;
}

function getBaseUrl() {
  return resolveBybitBaseUrl();
}

function getProxyUrl() {
  return (process.env.BYBIT_HTTPS_PROXY || process.env.HTTPS_PROXY || "").trim();
}

let proxyAgent = null;

async function getFetchOptions(init = {}) {
  const proxy = getProxyUrl();
  if (!proxy) return init;
  if (!proxyAgent) {
    const { ProxyAgent } = await import("undici");
    proxyAgent = new ProxyAgent(proxy);
  }
  return { ...init, dispatcher: proxyAgent };
}

async function bybitFetch(url, init = {}) {
  return fetch(url, await getFetchOptions(init));
}

export function getBybitApiConfig() {
  return {
    testnet: TESTNET,
    baseUrl: getBaseUrl(),
    region: (process.env.BYBIT_API_REGION || "eu").trim().toLowerCase(),
    proxy: Boolean(getProxyUrl()),
  };
}
const STATE_FILE = process.env.BYBIT_STATE_FILE || path.join(process.cwd(), "data", "bybit-state.json");
const DAILY_LOSS_LIMIT_PCT = Number(process.env.BYBIT_DAILY_LOSS_LIMIT_PCT || 10);
const MAX_TRADE_PCT = Number(process.env.BYBIT_MAX_TRADE_PCT || 30);
const RESERVE_PCT = Number(process.env.BYBIT_RESERVE_PCT || 10);
const AUTO_MONITOR = String(process.env.BYBIT_AUTO_MONITOR || "true").toLowerCase() === "true";
const AUTO_TRADE = String(process.env.BYBIT_AUTO_TRADE || "false").toLowerCase() === "true";
const POLL_MS = Number(process.env.BYBIT_POLL_MS || 30000);
const DEFAULT_SYMBOL = process.env.BYBIT_SYMBOL || "BTCUSDT";
const ACCOUNT_TYPE = (process.env.BYBIT_ACCOUNT_TYPE || "UNIFIED").trim().toUpperCase();
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

/** Public Bybit ping — fails with CloudFront 403 if deploy region is blocked. */
export async function probeBybitReachability() {
  await publicGet("/v5/market/time");
  return { ok: true, ...getBybitApiConfig() };
}

async function parseBybitResponse(response, context) {
  const raw = await response.text();
  if (!raw || !raw.trim()) {
    throw new Error(`${context}: empty response (HTTP ${response.status})`);
  }
  if (response.status === 403 && /cloudfront|block access from your country/i.test(raw)) {
    const proxyHint = getProxyUrl()
      ? ""
      : " Bybit часто блокує IP хмар (Railway/AWS) навіть у EU — додай BYBIT_HTTPS_PROXY (статичний egress) або VPS (Hetzner).";
    throw new Error(
      `${context}: Bybit CloudFront 403 — IP сервера в deny-list CDN.${proxyHint} ` +
      `Endpoint: ${getBaseUrl()}.`
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    const preview = raw.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`${context}: not JSON (HTTP ${response.status}): ${preview}`);
  }
}

const FUNDING_STABLE_COINS = ["USDT", "USD"];

function pickCoinRow(coins, coin) {
  const list = Array.isArray(coins) ? coins : [];
  return list.find(c => c.coin === coin) || {};
}

function coinAvailable(row) {
  return Number(
    row.equity ||
    row.walletBalance ||
    row.availableToWithdraw ||
    0
  );
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
  let url = `${getBaseUrl()}${endpoint}`;
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

  const response = await bybitFetch(url, {
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
  const url = `${getBaseUrl()}${endpoint}${qs ? `?${qs}` : ""}`;
  const response = await bybitFetch(url);
  const data = await parseBybitResponse(response, `GET ${endpoint}`);
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit public API error ${data.retCode}`);
  }
  return data.result;
}

async function getFundingCoinSnapshot(coin) {
  try {
    const result = await signedRequest("GET", "/v5/asset/transfer/query-account-coins-balance", {
      accountType: "FUND",
      coin,
    });
    const row = Array.isArray(result?.balance)
      ? result.balance.find(c => c.coin === coin) || result.balance[0]
      : null;
    const wallet = Number(row?.walletBalance || 0);
    const transfer = Number(row?.transferBalance || wallet);
    return {
      coin,
      wallet: Number.isFinite(wallet) ? wallet : 0,
      transfer: Number.isFinite(transfer) ? transfer : 0,
    };
  } catch {
    return { coin, wallet: 0, transfer: 0 };
  }
}

export async function getFundingUsdtSnapshot() {
  return getFundingSnapshot();
}

export async function getFundingSnapshot() {
  const parts = await Promise.all(FUNDING_STABLE_COINS.map(getFundingCoinSnapshot));
  const byCoin = Object.fromEntries(parts.map(p => [p.coin, p]));
  const walletUsdt = byCoin.USDT?.wallet || 0;
  const walletUsd = byCoin.USD?.wallet || 0;
  const transferUsdt = byCoin.USDT?.transfer || 0;
  const transferUsd = byCoin.USD?.transfer || 0;
  return {
    walletUsdt,
    transferUsdt: transferUsdt + transferUsd,
    walletUsd,
    transferUsd,
    byCoin,
  };
}

export async function getSpotUsdtSnapshot() {
  const result = await signedRequest("GET", "/v5/account/wallet-balance", {
    accountType: ACCOUNT_TYPE,
  });
  const row = result?.list?.[0];
  const funding = await getFundingSnapshot();
  if (!row) {
    return {
      equityUsdt: 0,
      availableUsdt: 0,
      availableUsd: 0,
      coins: [],
      funding,
    };
  }

  const coins = Array.isArray(row.coin) ? row.coin : [];
  const usdt = pickCoinRow(coins, "USDT");
  const usd = pickCoinRow(coins, "USD");
  const usdtAvail = coinAvailable(usdt);
  const usdAvail = coinAvailable(usd);
  const equityUsdt = Number(row.totalEquity || row.totalWalletBalance || usdtAvail + usdAvail);
  const availableUsdt = usdtAvail;
  const availableUsd = usdAvail;

  return {
    equityUsdt: Number.isFinite(equityUsdt) ? equityUsdt : 0,
    availableUsdt: Number.isFinite(availableUsdt) ? availableUsdt : 0,
    availableUsd: Number.isFinite(availableUsd) ? availableUsd : 0,
    coins,
    funding,
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
    fundingUsdt: snapshot.funding?.walletUsdt || 0,
    fundingUsd: snapshot.funding?.walletUsd || 0,
    fundingTransferUsdt: snapshot.funding?.transferUsdt || 0,
    unifiedUsd: snapshot.availableUsd || 0,
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
      `- Unified equity: ${status.equityUsdt}`,
      `- Unified USDT: ${status.availableUsdt}`,
      status.unifiedUsd > 0 ? `- Unified USD: ${status.unifiedUsd}` : "",
      status.fundingUsdt > 0 ? `- Funding USDT: ${status.fundingUsdt}` : "",
      status.fundingUsd > 0 ? `- Funding USD: ${status.fundingUsd}` : "",
      status.availableUsdt <= 0 && status.unifiedUsd > 0
        ? "- Convert USD→USDT для угод BTCUSDT"
        : "",
      status.availableUsdt <= 0 && status.fundingTransferUsdt > 0
        ? "- Потрібен Transfer: Funding → Unified Trading"
        : "",
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
  const hints = [];
  if (status.availableUsdt <= 0 && status.unifiedUsd > 0) {
    hints.push("⚠️ Є USD на Unified — для spot потрібен USDT (Convert USD→USDT)");
  }
  if (status.availableUsdt <= 0 && status.fundingTransferUsdt > 0) {
    hints.push("⚠️ Stablecoins на Funding — Transfer → Unified Trading");
  }
  if (status.fundingUsd > 0 && status.fundingUsdt <= 0) {
    hints.push(`⚠️ Funding USD: ${status.fundingUsd.toFixed(2)} — переказ / конвертація в USDT`);
  }
  return [
    `Bybit ${status.testnet ? "TESTNET" : "MAINNET"} (${ACCOUNT_TYPE}, spot trades)`,
    `Символ: ${status.symbol} | Ціна: ${ticker.lastPrice}`,
    `Unified equity: ${status.equityUsdt.toFixed(2)} (≈ USD/USDT)`,
    `Unified USDT: ${status.availableUsdt.toFixed(2)}`,
    status.unifiedUsd > 0 ? `Unified USD: ${status.unifiedUsd.toFixed(2)}` : "",
    status.fundingUsdt > 0 ? `Funding USDT: ${status.fundingUsdt.toFixed(2)}` : "",
    status.fundingUsd > 0 ? `Funding USD: ${status.fundingUsd.toFixed(2)}` : "",
    ...hints,
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
    accountType: ACCOUNT_TYPE,
    configured: isConfigured(),
    strategy: getStrategyConfig(),
  };
}

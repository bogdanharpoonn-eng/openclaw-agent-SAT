/**
 * Проста SPOT-стратегія (testnet): купівля на просадці, продаж по TP/SL.
 * Без LLM у циклі — лише правила + risk engine.
 */

const BUY_DIP_PCT = Number(process.env.BYBIT_BUY_DIP_PCT || 1.5);
const TAKE_PROFIT_PCT = Number(process.env.BYBIT_TAKE_PROFIT_PCT || 2);
const STOP_LOSS_PCT = Number(process.env.BYBIT_STOP_LOSS_PCT || 1.5);
const AUTO_TRADE_PCT = Number(process.env.BYBIT_AUTO_TRADE_PCT || 15);
const MIN_TRADE_USDT = Number(process.env.BYBIT_MIN_TRADE_USDT || 5);
const COOLDOWN_MS = Number(process.env.BYBIT_TRADE_COOLDOWN_MS || 300000);

export function parseSymbolPair(symbol) {
  if (symbol.endsWith("USDT")) {
    return { base: symbol.slice(0, -4), quote: "USDT" };
  }
  throw new Error(`Unsupported symbol format: ${symbol}`);
}

export function getCoinAvailable(coins, coin) {
  const row = coins.find(c => c.coin === coin);
  if (!row) return 0;
  return Number(row.availableToWithdraw || row.walletBalance || 0);
}

export function ensureStrategyState(state) {
  if (!state.strategy) {
    state.strategy = {
      peakPrice: 0,
      position: null,
      lastTradeAt: 0,
      lastAction: "",
    };
  }
  return state.strategy;
}

export function computeAutoSpendUsdt(status) {
  const raw = status.limits.maxSpendUsdt * (AUTO_TRADE_PCT / 100);
  const spend = Math.max(MIN_TRADE_USDT, Math.min(raw, status.limits.maxSpendUsdt));
  return Number(spend.toFixed(2));
}

/**
 * @returns {{ action: string, reason: string, spendUsdt?: number, sellQty?: number }}
 */
export function evaluateStrategy({ price, status, strategy, coins, symbol }) {
  const { base } = parseSymbolPair(symbol);
  const baseQty = getCoinAvailable(coins, base);
  const now = Date.now();
  const cooldownLeft = Math.max(0, COOLDOWN_MS - (now - (strategy.lastTradeAt || 0)));

  if (status.tradingStopped) {
    return { action: "hold", reason: status.stopReason || "trading stopped" };
  }

  if (cooldownLeft > 0) {
    return { action: "hold", reason: `cooldown ${Math.ceil(cooldownLeft / 1000)}s` };
  }

  if (!strategy.peakPrice || strategy.peakPrice <= 0) {
    strategy.peakPrice = price;
  }

  const position = strategy.position;

  if (position && position.qty > 0) {
    const entry = position.entryPrice;
    const tpPrice = entry * (1 + TAKE_PROFIT_PCT / 100);
    const slPrice = entry * (1 - STOP_LOSS_PCT / 100);
    const sellQty = Math.min(position.qty, baseQty);

    if (sellQty <= 0) {
      strategy.position = null;
      return { action: "hold", reason: "position cleared (no base balance)" };
    }

    if (price >= tpPrice) {
      return {
        action: "sell",
        reason: `take-profit +${TAKE_PROFIT_PCT}% (ціна ${price} >= ${tpPrice.toFixed(2)})`,
        sellQty,
      };
    }
    if (price <= slPrice) {
      return {
        action: "sell",
        reason: `stop-loss -${STOP_LOSS_PCT}% (ціна ${price} <= ${slPrice.toFixed(2)})`,
        sellQty,
      };
    }

    return {
      action: "hold",
      reason: `в позиції entry=${entry}, qty=${sellQty}, TP=${tpPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}`,
    };
  }

  if (price > strategy.peakPrice) {
    strategy.peakPrice = price;
  }

  const triggerPrice = strategy.peakPrice * (1 - BUY_DIP_PCT / 100);
  if (price <= triggerPrice) {
    const spendUsdt = computeAutoSpendUsdt(status);
    return {
      action: "buy",
      reason: `dip -${BUY_DIP_PCT}% (ціна ${price} <= ${triggerPrice.toFixed(2)}, peak ${strategy.peakPrice})`,
      spendUsdt,
    };
  }

  return {
    action: "hold",
    reason: `очікування dip ${BUY_DIP_PCT}% (ціна ${price}, peak ${strategy.peakPrice}, trigger ${triggerPrice.toFixed(2)})`,
  };
}

export function recordBuy(strategy, { price, qty, symbol }) {
  strategy.position = { symbol, entryPrice: price, qty, openedAt: Date.now() };
  strategy.peakPrice = price;
  strategy.lastTradeAt = Date.now();
  strategy.lastAction = `buy @ ${price}, qty ${qty}`;
}

export function recordSell(strategy, price) {
  strategy.position = null;
  strategy.peakPrice = price;
  strategy.lastTradeAt = Date.now();
  strategy.lastAction = `sell @ ${price}`;
}

export function getStrategyConfig() {
  return {
    buyDipPct: BUY_DIP_PCT,
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    autoTradePct: AUTO_TRADE_PCT,
    minTradeUsdt: MIN_TRADE_USDT,
    cooldownMs: COOLDOWN_MS,
  };
}

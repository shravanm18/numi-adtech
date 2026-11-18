import { create, all } from 'mathjs';
import * as chrono from 'chrono-node';
import currenciesData from './currencies.json';

const math = create(all);

export type ResultKind = 'number' | 'currency' | 'impressions' | 'cpm' | 'date' | 'unit' | 'text' | 'empty' | 'error';

export interface LineResult {
  lineIndex: number;
  raw: string;
  formatted: string;
  copyValue: string;
  kind: ResultKind;
  isComment?: boolean;
}

interface EvalValue {
  value: number;
  kind: ResultKind;
  currency?: string;
  unitLabel?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'CA$',
  AUD: 'A$',
  CHF: 'CHF ',
  CNY: '¥',
  INR: '₹',
  MXN: 'MX$',
  BRL: 'R$',
  KRW: '₩',
  SGD: 'S$',
  HKD: 'HK$',
  SEK: 'kr ',
  NOK: 'kr ',
  NZD: 'NZ$',
};

const RATES: Record<string, number> = currenciesData.rates;

function formatNumber(num: number, compact: boolean, decimals = 2): string {
  if (!Number.isFinite(num)) return String(num);

  if (compact && Math.abs(num) >= 1000) {
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e9) {
      return `${sign}${parseFloat((abs / 1e9).toFixed(2))}B`;
    }
    if (abs >= 1e6) {
      return `${sign}${parseFloat((abs / 1e6).toFixed(2))}M`;
    }
    if (abs >= 1e3) {
      return `${sign}${parseFloat((abs / 1e3).toFixed(2))}K`;
    }
  }

  const isInt = Math.abs(num - Math.round(num)) < 1e-9;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: isInt ? 0 : 0,
    maximumFractionDigits: isInt ? 0 : decimals,
  });
}

function formatEvalValue(ev: EvalValue, compact: boolean): { formatted: string; copyValue: string } {
  if (ev.kind === 'currency') {
    const code = ev.currency || 'USD';
    const sym = CURRENCY_SYMBOLS[code] || `${code} `;
    const decimals = code === 'JPY' || code === 'KRW' ? 0 : 2;
    const numStr = formatNumber(ev.value, compact, decimals);
    const fullStr = formatNumber(ev.value, false, decimals);
    return {
      formatted: `${sym}${numStr}`,
      copyValue: `${sym}${fullStr}`,
    };
  }
  if (ev.kind === 'impressions') {
    const numStr = formatNumber(ev.value, compact, 0);
    const fullStr = formatNumber(ev.value, false, 0);
    return {
      formatted: `${numStr} impressions`,
      copyValue: fullStr,
    };
  }
  if (ev.kind === 'cpm') {
    const numStr = ev.value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return {
      formatted: `$${numStr} CPM`,
      copyValue: `$${numStr}`,
    };
  }
  const numStr = formatNumber(ev.value, compact, 4);
  const fullStr = formatNumber(ev.value, false, 4);
  return {
    formatted: numStr,
    copyValue: fullStr,
  };
}

/**
 * Parse a single numeric token with optional $ and k/m/b/million/billion suffix.
 */
function parseScaledNumber(token: string): { value: number; isCurrency: boolean } | null {
  const cleaned = token.trim().replace(/,/g, '');
  const match = cleaned.match(/^(\$)?(-?\d+(?:\.\d+)?)\s*(k|m|million|b|billion)?$/i);
  if (!match) return null;
  const isCurrency = Boolean(match[1]);
  let num = parseFloat(match[2]);
  const suffix = match[3]?.toLowerCase();
  if (suffix === 'k') num *= 1e3;
  else if (suffix === 'm' || suffix === 'million') num *= 1e6;
  else if (suffix === 'b' || suffix === 'billion') num *= 1e9;
  return { value: num, isCurrency };
}

/**
 * Detect if the expression is requesting a length/temperature/mass unit conversion
 * where `m` (meters) or `k` (kelvin) should NOT be expanded to million/thousand.
 */
function isUnitConversionExpression(expr: string): boolean {
  return /\b(in|to|as)\s+(km|m|cm|mm|mi|yd|ft|in|inches|feet|meters|kilometers|miles|c|f|k|celsius|fahrenheit|kelvin|kg|g|lb|lbs|oz)\b/i.test(
    expr
  );
}

/**
 * Pre-process shorthand suffixes (k, m, million, b, billion) and $ signs.
 */
function expandSuffixes(expr: string): { expanded: string; hasCurrency: boolean } {
  let hasCurrency = false;
  if (/\$/.test(expr)) {
    hasCurrency = true;
  }

  // Remove commas inside numbers like 1,200,000
  let out = expr.replace(/(\d),(\d{3})/g, '$1$2');
  // Run twice for numbers with multiple commas like 1,200,000
  out = out.replace(/(\d),(\d{3})/g, '$1$2');

  // Strip leading $ from numbers like $1.5m or $500
  out = out.replace(/\$(\d)/g, '$1');

  if (!isUnitConversionExpression(expr)) {
    out = out.replace(
      /(\d+(?:\.\d+)?)\s*(billion|million|b|m|k)\b/gi,
      (_, numStr, suffix) => {
        const s = suffix.toLowerCase();
        const mult = s === 'k' ? 1e3 : s === 'm' || s === 'million' ? 1e6 : 1e9;
        return String(parseFloat(numStr) * mult);
      }
    );
  }

  // Support 'x' or 'X' as multiplication (e.g. "5 x 10", "5x10", "1.5m x 2")
  out = out.replace(/(\d|\))\s*[xX]\s*(\d|\()/g, '$1 * $2');
  out = out.replace(/\s+[xX]\s+/g, ' * ');

  return { expanded: out, hasCurrency };
}

/**
 * Try evaluating Ad-Tech CPM natural language expressions.
 */
function tryEvalAdTech(line: string): EvalValue | null {
  // 1. Impressions + CPM -> Spend
  // e.g. "2.5m impressions at $15 cpm" or "500k imp @ $12 cpm"
  const impAtCpm = line.match(
    /^(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*(?:imp|imps|impressions?)\s*(?:at|@)\s*(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*cpm$/i
  );
  if (impAtCpm) {
    const imp = parseScaledNumber(impAtCpm[1]);
    const cpm = parseScaledNumber(impAtCpm[2]);
    if (imp && cpm) {
      return { value: (imp.value / 1000) * cpm.value, kind: 'currency', currency: 'USD' };
    }
  }

  // 2. Budget + CPM -> Impressions
  // e.g. "$50k budget at $20 cpm" or "$50k at $20 cpm"
  const budgetAtCpm = line.match(
    /^(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*(?:budget|spend)?\s*(?:at|@)\s*(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*cpm$/i
  );
  if (budgetAtCpm) {
    const budget = parseScaledNumber(budgetAtCpm[1]);
    const cpm = parseScaledNumber(budgetAtCpm[2]);
    if (budget && cpm && cpm.value > 0) {
      return { value: (budget.value / cpm.value) * 1000, kind: 'impressions' };
    }
  }

  // 3. Budget + Impressions -> eCPM
  // e.g. "$15k for 1.2m impressions" or "cpm of $15k and 1.2m"
  const budgetForImp = line.match(
    /^(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*(?:for|\/)\s*(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*(?:imp|imps|impressions?)$/i
  );
  if (budgetForImp) {
    const budget = parseScaledNumber(budgetForImp[1]);
    const imp = parseScaledNumber(budgetForImp[2]);
    if (budget && imp && imp.value > 0) {
      return { value: (budget.value / imp.value) * 1000, kind: 'cpm' };
    }
  }

  const cpmOf = line.match(
    /^cpm\s+of\s+(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s+(?:and|for|on)\s+(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*(?:imp|imps|impressions?)?$/i
  );
  if (cpmOf) {
    const budget = parseScaledNumber(cpmOf[1]);
    const imp = parseScaledNumber(cpmOf[2]);
    if (budget && imp && imp.value > 0) {
      return { value: (budget.value / imp.value) * 1000, kind: 'cpm' };
    }
  }

  return null;
}

/**
 * Try evaluating offline currency conversion: e.g. "100 usd in eur", "$1.5m in eur"
 */
function tryEvalCurrency(line: string): EvalValue | null {
  const match = line.match(
    /^(\$?[\d.,]+\s*(?:k|m|million|b|billion)?)\s*([a-z]{3})?\s+(?:in|to)\s+([a-z]{3})$/i
  );
  if (!match) return null;

  const parsedNum = parseScaledNumber(match[1]);
  if (!parsedNum) return null;

  const fromCode = (match[2] || (parsedNum.isCurrency ? 'USD' : '')).toUpperCase();
  const toCode = match[3].toUpperCase();

  if (!fromCode || !RATES[fromCode] || !RATES[toCode]) return null;

  const usdAmount = parsedNum.value / RATES[fromCode];
  const converted = usdAmount * RATES[toCode];
  return { value: converted, kind: 'currency', currency: toCode };
}

/**
 * Try evaluating natural language dates via chrono-node:
 * e.g. "today + 2 weeks", "tomorrow + 3 days", "next friday"
 */
function tryEvalDate(line: string): { formatted: string; copyValue: string } | null {
  // Avoid triggering on pure math expressions
  if (/^[\d\s+\-*/().%$kmb]+$/i.test(line)) return null;

  // Check for "<date> +/- <N> <unit>"
  const offsetMatch = line.match(
    /^(.+?)\s*([+-])\s*(\d+)\s*(day|days|week|weeks|month|months|year|years)$/i
  );
  if (offsetMatch) {
    const baseParsed = chrono.parseDate(offsetMatch[1].trim(), new Date());
    if (baseParsed) {
      const sign = offsetMatch[2] === '+' ? 1 : -1;
      const amount = parseInt(offsetMatch[3], 10) * sign;
      const unit = offsetMatch[4].toLowerCase();
      const d = new Date(baseParsed);
      if (unit.startsWith('day')) d.setDate(d.getDate() + amount);
      else if (unit.startsWith('week')) d.setDate(d.getDate() + amount * 7);
      else if (unit.startsWith('month')) d.setMonth(d.getMonth() + amount);
      else if (unit.startsWith('year')) d.setFullYear(d.getFullYear() + amount);

      const formatted = d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      return { formatted, copyValue: formatted };
    }
  }

  // Direct date phrase like "today", "next friday", "in 2 weeks"
  if (
    /\b(today|tomorrow|yesterday|next|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(
      line
    )
  ) {
    const parsed = chrono.parseDate(line, new Date());
    if (parsed) {
      const formatted = parsed.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      return { formatted, copyValue: formatted };
    }
  }

  return null;
}

/**
 * Expand percentage expressions like "200k - 15%", "200k + 15%", "15% of 200k"
 */
function preprocessPercentages(expr: string): string {
  // "15% of 200000" -> "(0.15 * 200000)"
  let out = expr.replace(/(\d+(?:\.\d+)?)%\s+of\s+/gi, '($1 / 100) * ');
  // "A + B%" or "A - B%" -> "A + (A * B / 100)"
  out = out.replace(
    /(\b\d+(?:\.\d+)?|\))\s*([+-])\s*(\d+(?:\.\d+)?)%/g,
    '$1 $2 ($1 * $3 / 100)'
  );
  // Standalone "15%" -> "(15 / 100)"
  out = out.replace(/(\d+(?:\.\d+)?)%/g, '($1 / 100)');
  return out;
}

export function evaluateLines(text: string, compact: boolean): LineResult[] {
  const lines = text.split('\n');
  const variables: Record<string, EvalValue> = {};
  let blockValues: number[] = [];
  let prevValue: EvalValue | null = null;

  return lines.map((rawLine, idx) => {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      blockValues = [];
      return {
        lineIndex: idx,
        raw: rawLine,
        formatted: '',
        copyValue: '',
        kind: 'empty',
      };
    }

    // Full-line comment
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      return {
        lineIndex: idx,
        raw: rawLine,
        formatted: '',
        copyValue: '',
        kind: 'empty',
        isComment: true,
      };
    }

    // Strip inline comments (// or #)
    const commentStripped = trimmed.replace(/\s+(\/\/|#).*$/, '').trim();

    // Check variable assignment: e.g. "q4_budget = 1.2m"
    let varName: string | null = null;
    let expr = commentStripped;
    const assignMatch = commentStripped.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (assignMatch) {
      varName = assignMatch[1];
      expr = assignMatch[2].trim();
    }

    // 1. Block tokens: sum, avg, average
    if (/^(sum|total)$/i.test(expr)) {
      const total = blockValues.reduce((acc, v) => acc + v, 0);
      const ev: EvalValue = { value: total, kind: prevValue?.kind === 'currency' ? 'currency' : 'number', currency: prevValue?.currency };
      if (varName) variables[varName] = ev;
      prevValue = ev;
      const { formatted, copyValue } = formatEvalValue(ev, compact);
      return { lineIndex: idx, raw: rawLine, formatted, copyValue, kind: ev.kind };
    }

    if (/^(avg|average)$/i.test(expr)) {
      const avg = blockValues.length > 0 ? blockValues.reduce((acc, v) => acc + v, 0) / blockValues.length : 0;
      const ev: EvalValue = { value: avg, kind: prevValue?.kind === 'currency' ? 'currency' : 'number', currency: prevValue?.currency };
      if (varName) variables[varName] = ev;
      prevValue = ev;
      const { formatted, copyValue } = formatEvalValue(ev, compact);
      return { lineIndex: idx, raw: rawLine, formatted, copyValue, kind: ev.kind };
    }

    // 2. Ad-Tech CPM formulas
    const adTechResult = tryEvalAdTech(expr);
    if (adTechResult) {
      if (varName) variables[varName] = adTechResult;
      blockValues.push(adTechResult.value);
      prevValue = adTechResult;
      const { formatted, copyValue } = formatEvalValue(adTechResult, compact);
      return { lineIndex: idx, raw: rawLine, formatted, copyValue, kind: adTechResult.kind };
    }

    // 3. Offline currency conversion
    const currencyResult = tryEvalCurrency(expr);
    if (currencyResult) {
      if (varName) variables[varName] = currencyResult;
      blockValues.push(currencyResult.value);
      prevValue = currencyResult;
      const { formatted, copyValue } = formatEvalValue(currencyResult, compact);
      return { lineIndex: idx, raw: rawLine, formatted, copyValue, kind: currencyResult.kind };
    }

    // 4. Natural language dates
    const dateResult = tryEvalDate(expr);
    if (dateResult) {
      return {
        lineIndex: idx,
        raw: rawLine,
        formatted: dateResult.formatted,
        copyValue: dateResult.copyValue,
        kind: 'date',
      };
    }

    // 5. General math + variables + prev + percentages + mathjs units
    try {
      const { expanded, hasCurrency } = expandSuffixes(expr);
      const withPct = preprocessPercentages(expanded);

      // Build scope with numeric variables and `prev`
      const scope: Record<string, number> = {};
      let inheritedCurrency = hasCurrency;
      for (const [k, v] of Object.entries(variables)) {
        scope[k] = v.value;
        if (expr.includes(k) && v.kind === 'currency') {
          inheritedCurrency = true;
        }
      }
      if (prevValue !== null) {
        scope['prev'] = prevValue.value;
        if (/\bprev\b/.test(expr) && prevValue.kind === 'currency') {
          inheritedCurrency = true;
        }
      }

      const evaluated = math.evaluate(withPct, scope);

      if (typeof evaluated === 'number' && Number.isFinite(evaluated)) {
        const ev: EvalValue = {
          value: evaluated,
          kind: inheritedCurrency ? 'currency' : 'number',
          currency: 'USD',
        };
        if (varName) variables[varName] = ev;
        blockValues.push(evaluated);
        prevValue = ev;
        const { formatted, copyValue } = formatEvalValue(ev, compact);
        return { lineIndex: idx, raw: rawLine, formatted, copyValue, kind: ev.kind };
      }

      if (evaluated && typeof evaluated.toString === 'function') {
        const str = evaluated.toString();
        return {
          lineIndex: idx,
          raw: rawLine,
          formatted: str,
          copyValue: str,
          kind: 'unit',
        };
      }
    } catch {
      // Ignore incomplete/unparseable lines while typing
    }

    return {
      lineIndex: idx,
      raw: rawLine,
      formatted: '',
      copyValue: '',
      kind: 'empty',
    };
  });
}

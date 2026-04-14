import type {
  GoPlusTokenResult,
  RugCheckReport,
  HeliusHolder,
  OHLCVCandle,
} from './types';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateGoPlusResponse(data: unknown): GoPlusTokenResult | null {
  if (!isObject(data)) return null;
  const result = (data as Record<string, unknown>).result as unknown;
  if (!isObject(result)) return null;
  const entries = Object.values(result);
  if (entries.length === 0) return null;
  const token = entries[0];
  if (!isObject(token)) return null;
  return token as unknown as GoPlusTokenResult;
}

export function validateRugCheckResponse(data: unknown): RugCheckReport | null {
  if (!isObject(data)) return null;
  if (!('risks' in data) && !('tokenMeta' in data)) return null;
  return data as unknown as RugCheckReport;
}

export function validateHeliusHolders(data: unknown): HeliusHolder[] | null {
  if (!Array.isArray(data)) return null;
  if (data.length > 0) {
    const first = data[0];
    if (!isObject(first) || !('address' in first) || !('amount' in first)) return null;
  }
  return data as HeliusHolder[];
}

export function validateOHLCVCandle(data: unknown): OHLCVCandle[] | null {
  if (!Array.isArray(data)) return null;
  if (data.length > 0) {
    const first = data[0];
    if (!isObject(first)) return null;
    if (!('o' in first) || !('h' in first) || !('l' in first) || !('c' in first) || !('v' in first)) return null;
  }
  return data as OHLCVCandle[];
}

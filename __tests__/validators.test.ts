import { describe, it, expect } from 'vitest';
import { validateGoPlusResponse, validateRugCheckResponse, validateHeliusHolders, validateOHLCVCandle } from '../api/_lib/validators';

describe('validateGoPlusResponse', () => {
  it('returns null for non-object', () => {
    expect(validateGoPlusResponse(null)).toBeNull();
    expect(validateGoPlusResponse('str')).toBeNull();
    expect(validateGoPlusResponse(42)).toBeNull();
    expect(validateGoPlusResponse([])).toBeNull();
  });
  it('returns null when result missing', () => {
    expect(validateGoPlusResponse({})).toBeNull();
    expect(validateGoPlusResponse({ result: 'bad' })).toBeNull();
  });
  it('returns null for empty result', () => {
    expect(validateGoPlusResponse({ result: {} })).toBeNull();
  });
  it('returns null when token entry is not object', () => {
    expect(validateGoPlusResponse({ result: { abc: 'string' } })).toBeNull();
  });
  it('returns token for valid response', () => {
    const token = { is_honeypot: '0', is_open_source: '1' };
    expect(validateGoPlusResponse({ result: { mint: token } })).toEqual(token);
  });
});

describe('validateRugCheckResponse', () => {
  it('returns null for non-object', () => {
    expect(validateRugCheckResponse(null)).toBeNull();
    expect(validateRugCheckResponse(123)).toBeNull();
    expect(validateRugCheckResponse([])).toBeNull();
  });
  it('returns null if no risks or tokenMeta', () => {
    expect(validateRugCheckResponse({})).toBeNull();
  });
  it('returns data with risks', () => {
    const d = { risks: [{ name: 'x' }] };
    expect(validateRugCheckResponse(d)).toEqual(d);
  });
  it('returns data with tokenMeta', () => {
    const d = { tokenMeta: { name: 'A' } };
    expect(validateRugCheckResponse(d)).toEqual(d);
  });
});

describe('validateHeliusHolders', () => {
  it('returns null for non-array', () => {
    expect(validateHeliusHolders(null)).toBeNull();
    expect(validateHeliusHolders({})).toBeNull();
  });
  it('returns empty array', () => {
    expect(validateHeliusHolders([])).toEqual([]);
  });
  it('returns null for invalid first element', () => {
    expect(validateHeliusHolders([{ bad: true }])).toBeNull();
  });
  it('returns holders for valid data', () => {
    const h = [{ address: 'abc', amount: 100 }];
    expect(validateHeliusHolders(h)).toEqual(h);
  });
});

describe('validateOHLCVCandle', () => {
  it('returns null for non-array', () => {
    expect(validateOHLCVCandle(null)).toBeNull();
    expect(validateOHLCVCandle('bad')).toBeNull();
  });
  it('returns empty array', () => {
    expect(validateOHLCVCandle([])).toEqual([]);
  });
  it('returns null for invalid candle', () => {
    expect(validateOHLCVCandle([{ o: 1 }])).toBeNull();
  });
  it('returns null when first element is not object', () => {
    expect(validateOHLCVCandle([42])).toBeNull();
  });
  it('returns candles for valid data', () => {
    const c2 = [{ o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 }];
    expect(validateOHLCVCandle(c2)).toEqual(c2);
  });
});

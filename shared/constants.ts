// IMPORTANT: Keep in sync with api/_lib/constants.ts
// Strict base58 alphabet — excludes 0, O, I, l which are not valid in base58
export const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

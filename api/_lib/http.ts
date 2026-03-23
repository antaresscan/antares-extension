// api/http.ts — HTTP utility functions extracted from helpers.ts

export function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}, ms = 5000, maxRetries = 2): Promise<T | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t = withTimeout(ms);
    try {
      const r = await fetch(url, { ...init, signal: t.signal });
      t.clear();
      if (r.status === 429 || r.status === 503) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
          continue;
        }
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch (e: unknown) {
      t.clear();
      if (attempt === maxRetries) { console.warn("[antares]", e); return null; }
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  return null;
}

export async function fetchJsonPost<T = unknown>(url: string, body: object, ms = 5000, maxRetries = 2): Promise<T | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t = withTimeout(ms);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: t.signal,
      });
      t.clear();
      if (r.status === 429 || r.status === 503) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
          continue;
        }
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch (e: unknown) {
      t.clear();
      if (attempt === maxRetries) { console.warn("[antares]", e); return null; }
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  return null;
}

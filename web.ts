// Shared HTTP plumbing for the surfaces: a reply is data until app.ts puts it on the wire, which
// keeps every handler testable and free of socket bookkeeping.

export interface Reply {
  status: number;
  /** A JSON-serialisable body, or null for an empty body (204). */
  body: unknown;
  headers: Record<string, string>;
  /** When set, sent verbatim instead of the JSON body (the git protocol's bytes). */
  raw?: Buffer;
  contentType?: string;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): Reply {
  return { status, body: { message }, headers: {} };
}

export function rawReply(status: number, raw: Buffer, contentType: string): Reply {
  return { status, body: null, headers: {}, raw, contentType };
}

/** Parse a JSON request body; `undefined` for an empty body, the INVALID symbol for malformed JSON. */
export const INVALID_JSON: unique symbol = Symbol('invalid-json');

export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return INVALID_JSON;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** per_page/page from a query, GitHub's bounds (default 30, at most 100). */
export function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

export function pageSlice<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// src/index.ts
export interface Env {
  SUBGRAPH_URL: string;
}

// ✅ bump default TTL (more cache hits, less indexer load)
const DEFAULT_TTL_SECONDS = 8;

/**
 * Store in-flight results as plain data (NOT Response),
 * so we never reuse a locked ReadableStream.
 */
type InflightValue = {
  status: number;
  contentType: string;
  text: string;
  ok: boolean;
};

const inflight = new Map<string, Promise<InflightValue>>();

// --- Force-fresh + meta-guard config ---
const FORCE_FRESH_HEADER = "x-force-fresh"; // set to "1" from frontend after txs
const META_CACHE_TTL_SECONDS = 30 * 60; // 30m (only used for the meta guard value per key)
const META_FETCH_TIMEOUT_MS = 8000;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // ✅ FIX: pass request to OPTIONS handler (dynamic allow-headers)
      if (req.method === "OPTIONS") return handleOptions(req);

      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        return withCors(new Response("ok", { status: 200 }));
      }

      // Dedicated meta endpoint (simple + reliable)
      if (url.pathname === "/meta") {
        if (!env.SUBGRAPH_URL) {
          return withCors(new Response("Missing SUBGRAPH_URL", { status: 500 }));
        }

        // IMPORTANT: edge-cache only, never browser-cache
        const ttl = 3;
        const cc = cacheControlEdgeOnly(ttl);

        try {
          const upstream = await fetchWithTimeout(
            env.SUBGRAPH_URL,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query: "query __Meta { _meta { block { number } } }",
                variables: {},
                operationName: "__Meta",
              }),
            },
            8000
          );

          const text = await upstream.text();
          const ct = upstream.headers.get("content-type") ?? "application/json";

          const res = new Response(text, {
            status: upstream.status,
            headers: {
              "content-type": ct,
              "Cache-Control": cc,
              "CDN-Cache-Control": cc,
              "X-Cache": "MISS",
            },
          });

          return withCors(res);
        } catch (e) {
          return withCors(
            new Response(JSON.stringify({ error: "UPSTREAM_FETCH_FAILED", message: String(e) }), {
              status: isAbortTimeout(e) ? 504 : 502,
              headers: { "content-type": "application/json" },
            })
          );
        }
      }

      // GraphQL proxy
      if (url.pathname !== "/graphql") {
        return withCors(new Response("Not found", { status: 404 }));
      }
      if (req.method !== "POST") {
        return withCors(new Response("Method not allowed", { status: 405 }));
      }
      if (!env.SUBGRAPH_URL) {
        return withCors(new Response("Missing SUBGRAPH_URL", { status: 500 }));
      }

      const forceFresh = (req.headers.get(FORCE_FRESH_HEADER) || "").trim() === "1";

      // Parse request body
      const raw = await req.text();
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return withCors(new Response("Bad JSON", { status: 400 }));
      }

      const query = typeof body?.query === "string" ? body.query : "";
      const variables = body?.variables && typeof body.variables === "object" ? body.variables : {};

      if (!query) return withCors(new Response("Missing query", { status: 400 }));
      if (query.length > 60_000) return withCors(new Response("Query too large", { status: 413 }));

      // Clamp to protect indexer
      clampPagination(variables);

      const ttl = pickTtlSeconds(query);
      const cc = cacheControlEdgeOnly(ttl);

      // Cache key from query+variables (canonical)
      const hashKey = await sha256Hex(
        canonicalStringify({
          v: 7, // bump version due to force-fresh/meta-guard behavior
          query,
          variables,
        })
      );

      // Cache API uses Request as key; we make a synthetic GET
      // IMPORTANT: ignore incoming querystring entirely to allow frontend ?cb=... without busting edge cache
      const cacheUrl = new URL(req.url);
      cacheUrl.pathname = `/__cache/${hashKey}`;
      cacheUrl.search = "";
      const cacheReq = new Request(cacheUrl.toString(), { method: "GET" });

      const cache = caches.default;

      // Cache match (guarded) — skip if force-fresh
      if (!forceFresh) {
        try {
          const cached = await cache.match(cacheReq);
          if (cached) {
            const hit = addHeaders(cached, {
              "Cache-Control": cc,
              "CDN-Cache-Control": cc,
              "X-Cache": "HIT",
            });
            return withCors(hit);
          }
        } catch (e) {
          console.error("cache.match failed", e);
        }
      }

      // ✅ In-flight dedupe (still dedupes even for force-fresh to avoid stampedes)
      const existing = inflight.get(hashKey);
      if (existing) {
        const v = await existing;
        const res = makeTextResponse(v, ttl, forceFresh ? "COALESCED_BYPASS" : "COALESCED");
        return withCors(res);
      }

      const p = (async (): Promise<InflightValue> => {
        try {
          const upstream = await fetchWithTimeout(
            env.SUBGRAPH_URL,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query, variables }),
            },
            10_000
          );

          const text = await upstream.text();
          const ct = upstream.headers.get("content-type") ?? "application/json";

          const v: InflightValue = {
            status: upstream.status,
            contentType: ct,
            text,
            ok: upstream.ok,
          };

          // Cache only ok responses (and avoid caching GraphQL "errors" payloads)
          let okToCache = v.ok;
          if (okToCache && ct.includes("application/json")) {
            try {
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed === "object" && "errors" in parsed) okToCache = false;
            } catch {
              okToCache = false;
            }
          }

          /**
           * ✅ Meta-guard to avoid cache poisoning:
           * - We *may* bypass cache on force-fresh reads.
           * - But we should only write-through if the subgraph has advanced (by _meta.block.number)
           *   relative to what we last cached for this query key.
           */
          if (okToCache) {
            if (forceFresh) {
              // only write-through if meta advanced (best-effort). If meta fetch fails, do NOT write-through.
              const shouldWrite = await shouldWriteThroughCacheMetaGuard(env, cache, hashKey);
              if (shouldWrite) {
                const toCache = makeTextResponse(v, ttl, "BYPASS_WRITE");
                ctx.waitUntil(cache.put(cacheReq, toCache.clone()).catch((e) => console.error("cache.put failed", e)));
              }
            } else {
              const toCache = makeTextResponse(v, ttl, "MISS");
              ctx.waitUntil(cache.put(cacheReq, toCache.clone()).catch((e) => console.error("cache.put failed", e)));
            }
          }

          return v;
        } catch (e) {
          return {
            status: isAbortTimeout(e) ? 504 : 502,
            contentType: "application/json",
            text: JSON.stringify({
              error: isAbortTimeout(e) ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FETCH_FAILED",
              message: e instanceof Error ? e.message : String(e),
            }),
            ok: false,
          };
        }
      })().finally(() => {
        inflight.delete(hashKey);
      });

      inflight.set(hashKey, p);

      const v = await p;
      const res = makeTextResponse(v, ttl, forceFresh ? "BYPASS" : "MISS");
      return withCors(res);
    } catch (e) {
      return withCors(
        new Response(
          JSON.stringify({
            error: "WORKER_INTERNAL_ERROR",
            message: e instanceof Error ? e.message : String(e),
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      );
    }
  },
};

// -------------------- Cache-Control helpers --------------------

function cacheControlEdgeOnly(ttl: number) {
  return `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl}`;
}

function cacheControlMeta(ttl: number) {
  return `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${Math.min(30, ttl)}`;
}

// -------------------- Response builders (NO stream reuse) --------------------

type XCache = "HIT" | "MISS" | "COALESCED" | "BYPASS" | "COALESCED_BYPASS" | "BYPASS_WRITE";

function makeTextResponse(v: InflightValue, ttl: number, xCache: XCache): Response {
  const cc = cacheControlEdgeOnly(ttl);

  return new Response(v.text, {
    status: v.status,
    headers: {
      "content-type": v.contentType,
      "Cache-Control": cc,
      "CDN-Cache-Control": cc,
      "X-Cache": xCache,
    },
  });
}

function addHeaders(res: Response, extra: Record<string, string>): Response {
  const r = res.clone();
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

// -------------------- CORS --------------------

function withCors(res: Response) {
  const r = res.clone();
  const headers = new Headers(r.headers);

  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Force-Fresh");

  const vary = headers.get("Vary");
  if (vary && vary.toLowerCase().includes("origin")) {
    const cleaned = vary
      .split(",")
      .map((s) => s.trim())
      .filter((t) => t.toLowerCase() !== "origin")
      .join(", ");
    if (cleaned) headers.set("Vary", cleaned);
    else headers.delete("Vary");
  }

  return new Response(r.body, { status: r.status, headers });
}

function handleOptions(req: Request) {
  const headers = new Headers();

  const reqHeaders = req.headers.get("Access-Control-Request-Headers") || "content-type";
  const reqMethod = req.headers.get("Access-Control-Request-Method") || "POST";

  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", `POST, OPTIONS, GET, ${reqMethod}`);
  headers.set("Access-Control-Allow-Headers", reqHeaders);
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(null, { status: 204, headers });
}

// -------------------- Limits / TTL logic --------------------

function clampPagination(variables: any) {
  const walk = (obj: any) => {
    if (!obj || typeof obj !== "object") return;

    for (const k of Object.keys(obj)) {
      const v = obj[k];

      if (k === "first") obj[k] = clampNumberish(v, 1, 200);
      if (k === "skip") obj[k] = clampNumberish(v, 0, 100_000);

      if ((k === "ids" || k.endsWith("Ids")) && Array.isArray(v)) obj[k] = v.slice(0, 200);

      walk(v);
    }
  };

  walk(variables);
}

function clampNumberish(v: any, min: number, max: number) {
  if (typeof v === "number") return clampInt(v, min, max);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return clampInt(n, min, max);
  }
  return min;
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * ✅ TTL routing based on your REAL frontend operation names.
 * We look for "query <OperationName>" to avoid accidental matches.
 */
function pickTtlSeconds(query: string): number {
  const q = query.toLowerCase();

  // hot / meta
  if (q.includes("query globalfeed")) return 3;
  if (q.includes("_meta") || q.includes("query __meta")) return 3;

  // homepage / billboard
  if (q.includes("query globalstats") || q.includes("query globalstatsbillboard")) return 8;
  if (q.includes("query homelotteries")) return 8;

  // detail / user pages
  if (q.includes("query lotterybyid")) return 15;
  if (q.includes("query userlotteriesbyuser")) return 15;
  if (q.includes("query userlotteriesbylottery")) return 15;

  // filtered lists
  if (q.includes("query lotteriesbycreator")) return 20;
  if (q.includes("query lotteriesbyfeerecipient")) return 20;

  return DEFAULT_TTL_SECONDS;
}

// -------------------- Stable hashing --------------------

function canonicalStringify(value: any): string {
  const seen = new WeakSet();

  const helper = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);

    if (Array.isArray(v)) return v.map(helper);

    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = helper(v[k]);
    return out;
  };

  return JSON.stringify(helper(value));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -------------------- Meta-guard (avoid cache poisoning on force-fresh) --------------------

function metaKeyUrlFrom(reqUrl: string, hashKey: string): Request {
  const u = new URL(reqUrl);
  u.pathname = `/__meta/${hashKey}`;
  u.search = "";
  return new Request(u.toString(), { method: "GET" });
}

function parseMetaBlockFromJsonText(text: string): number | null {
  try {
    const j = JSON.parse(text);
    const n = j?.data?._meta?.block?.number;
    if (typeof n === "number") return n;
    if (typeof n === "string" && n.trim() !== "") {
      const k = Number(n);
      return Number.isFinite(k) ? k : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchSubgraphMetaBlock(env: Env): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      env.SUBGRAPH_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "query __Meta { _meta { block { number } } }",
          variables: {},
          operationName: "__Meta",
        }),
      },
      META_FETCH_TIMEOUT_MS
    );

    const text = await res.text();
    if (!res.ok) return null;
    return parseMetaBlockFromJsonText(text);
  } catch {
    return null;
  }
}

async function shouldWriteThroughCacheMetaGuard(env: Env, cache: Cache, hashKey: string): Promise<boolean> {
  const newMeta = await fetchSubgraphMetaBlock(env);
  if (newMeta == null) return false;

  const metaReq = metaKeyUrlFrom("https://example.invalid/graphql", hashKey);

  let oldMeta: number | null = null;
  try {
    const cached = await cache.match(metaReq);
    if (cached) {
      const txt = await cached.text();
      const n = Number(txt);
      if (Number.isFinite(n)) oldMeta = n;
    }
  } catch {
    // ignore
  }

  if (oldMeta != null && newMeta < oldMeta) return false;

  try {
    const cc = cacheControlMeta(META_CACHE_TTL_SECONDS);
    const toStore = new Response(String(newMeta), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "Cache-Control": cc,
        "CDN-Cache-Control": cc,
      },
    });
    await cache.put(metaReq, toStore);
  } catch {
    // ignore
  }

  return true;
}

// -------------------- Upstream timeout --------------------

function isAbortTimeout(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "").toLowerCase();
  return msg.includes("timeout");
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => {
    try {
      ac.abort(new Error("timeout"));
    } catch {
      // ignore
    }
  }, ms);

  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
// Cabeçalhos de cache HTTP.
//
// Estratégia "http": respostas GET 200 recebem Cache-Control público com
// max-age = TTL e um ETag forte (hash do corpo). Um GET com If-None-Match
// igual ao ETag recebe 304 sem corpo (validação condicional). O cache em si
// fica fora da aplicação: no nginx (intermediário compartilhado) e no cliente.
//
// Demais estratégias: "Cache-Control: no-store", para que o nginx — que está
// no caminho de todas as estratégias, por uniformidade — nunca armazene nada.
// Escritas sempre recebem no-store.
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CacheStrategy } from "./config";
import type { Metrics } from "./metrics";

export function etagOf(payload: string | Buffer): string {
  return `"${createHash("sha1").update(payload).digest("base64url")}"`;
}

/** true se algum ETag de If-None-Match (lista separada por vírgula ou "*") casa com o atual. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export function registerHttpCacheHeaders(
  app: FastifyInstance,
  opts: { strategy: CacheStrategy; ttlSeconds: number; metrics: Metrics },
): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/internal") || req.url === "/health") return payload;

    const cacheable = opts.strategy === "http" && req.method === "GET" && reply.statusCode === 200;
    if (!cacheable) {
      reply.header("Cache-Control", "no-store");
      return payload;
    }

    const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload ?? "");
    const etag = etagOf(body);
    reply.header("Cache-Control", `public, max-age=${opts.ttlSeconds}`);
    reply.header("ETag", etag);
    if (matchesIfNoneMatch(req.headers["if-none-match"], etag)) {
      opts.metrics.notModified++;
      reply.code(304);
      return "";
    }
    return payload;
  });
}

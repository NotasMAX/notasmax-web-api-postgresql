import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { createProblemResponse } from "./validation";

export type IfMatchResult =
  | { status: "ok"; value: string }
  | { status: "missing" }
  | { status: "malformed" };

export function readIfMatch(request: Pick<HttpRequest, "headers">): IfMatchResult {
  const value = request.headers.get("if-match");
  if (value === null) return { status: "missing" };
  if (!/^"[\x21\x23-\x7E]*"$/.test(value)) return { status: "malformed" };
  return { status: "ok", value };
}

export function strongEtag(value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("base64url");
  return `"${digest}"`;
}

export function ifMatchProblem(status: "missing" | "malformed" | "stale"): HttpResponseInit {
  if (status === "missing") {
    return createProblemResponse({
      status: 428,
      title: "Pré-condição necessária",
      detail: "Envie o ETag atual no cabeçalho If-Match.",
      headers: { "cache-control": "no-store" }
    });
  }
  if (status === "malformed") {
    return createProblemResponse({
      status: 400,
      title: "Cabeçalho If-Match inválido",
      detail: "Envie exatamente um ETag forte no cabeçalho If-Match.",
      headers: { "cache-control": "no-store" }
    });
  }
  return createProblemResponse({
    status: 412,
    title: "Pré-condição não satisfeita",
    detail: "O recurso mudou desde a última leitura. Atualize os dados antes de tentar novamente.",
    headers: { "cache-control": "no-store" }
  });
}

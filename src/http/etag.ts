import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { createProblemResponse } from "./validation";

export type IfMatchResult =
  | { status: "ok"; value: string }
  | { status: "missing" }
  | { status: "malformed" };

export function isStrongOpaqueEtag(value: string): boolean {
  return /^"[\x21\x23-\x7E]*"$/.test(value);
}

export function readIfMatch(request: Pick<HttpRequest, "headers">): IfMatchResult {
  const value = request.headers.get("if-match");
  if (value === null) return { status: "missing" };
  if (!isStrongOpaqueEtag(value)) return { status: "malformed" };
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
      title: "Atualização necessária",
      detail: "Atualize os dados da página e tente novamente.",
      headers: { "cache-control": "no-store" }
    });
  }
  if (status === "malformed") {
    return createProblemResponse({
      status: 400,
      title: "Não foi possível concluir a atualização",
      detail: "Atualize os dados da página e tente novamente.",
      headers: { "cache-control": "no-store" }
    });
  }
  return createProblemResponse({
    status: 412,
    title: "Os dados foram alterados",
    detail: "Atualize a página e tente novamente.",
    headers: { "cache-control": "no-store" }
  });
}

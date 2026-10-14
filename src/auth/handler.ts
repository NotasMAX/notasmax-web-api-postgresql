import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { createProblemResponse, validateJsonBody } from "../http/validation";
import {
  createLoginSession,
  inspectSession,
  revokeSession,
  type CurrentSessionResult,
  type SessionIdentity
} from "./session-service";

const SESSION_COOKIE_NAME = "notasmax_session";
const SESSION_COOKIE_PATH = "/api/v1";
const SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
const AUTHENTICATION_CHALLENGE = "NotasMAX-Session";
const LOGIN_BODY_MAX_BYTES = 8 * 1024;

const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(15).max(1024)
});

type RequestHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

export type AdminGuardResult =
  | { authorized: true; user: SessionIdentity; token: string }
  | { authorized: false; response: HttpResponseInit };

export function configuredOrigins(): string[] {
  return (process.env.NOTASMAX_WEB_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => {
      if (!origin) return false;
      try {
        const parsed = new URL(origin);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
          && parsed.origin === origin
          && parsed.username === ""
          && parsed.password === "";
      } catch {
        return false;
      }
    });
}

export function etagExposureHeaders(
  request: Pick<HttpRequest, "headers">,
  allowedOrigins: readonly string[]
): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins.includes(origin)
    ? { "access-control-expose-headers": "ETag" }
    : {};
}

export function authenticationRequired(): HttpResponseInit {
  return createProblemResponse({
    status: 401,
    title: "Entre na sua conta para continuar",
    code: "AUTHENTICATION_REQUIRED",
    detail: "Entre na sua conta para continuar.",
    headers: { "www-authenticate": AUTHENTICATION_CHALLENGE, "cache-control": "no-store" }
  });
}

export function authenticationFailed(): HttpResponseInit {
  return createProblemResponse({
    status: 401,
    title: "Não foi possível entrar",
    code: "AUTHENTICATION_FAILED",
    detail: "O e-mail ou a senha não conferem.",
    headers: { "www-authenticate": AUTHENTICATION_CHALLENGE, "cache-control": "no-store" }
  });
}

export function resourceNotFound(): HttpResponseInit {
  return createProblemResponse({
    status: 404,
    title: "Não encontramos o que você procura",
    code: "RESOURCE_NOT_FOUND",
    detail: "Confira as informações e tente novamente.",
    headers: { "cache-control": "no-store" }
  });
}

export function internalFailure(): HttpResponseInit {
  return createProblemResponse({
    status: 500,
    title: "Não foi possível concluir a ação",
    detail: "Tente novamente. Se o problema continuar, fale com o suporte.",
    headers: { "cache-control": "no-store" }
  });
}

export function mutationRejection(
  request: HttpRequest,
  allowedOrigins: readonly string[]
): HttpResponseInit | undefined {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !allowedOrigins.includes(origin)) {
    return createProblemResponse({
      status: 403,
      title: "Não foi possível concluir a ação",
      code: "ORIGIN_NOT_ALLOWED",
      detail: "Atualize a página e tente novamente.",
      headers: { "cache-control": "no-store" }
    });
  }

  if (request.headers.get("x-requested-with") !== "XMLHttpRequest") {
    return createProblemResponse({
      status: 403,
      title: "Atualize a página para continuar",
      code: "REQUEST_HEADER_REQUIRED",
      detail: "Atualize a página e tente novamente.",
      headers: { "cache-control": "no-store" }
    });
  }
}

function sessionToken(request: Pick<HttpRequest, "headers">): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  let token: string | undefined;
  let matches = 0;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    matches += 1;
    token = part.slice(separator + 1).trim();
  }

  return matches === 1 && token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

function sessionCookie(value: string, maxAge: number) {
  return {
    name: SESSION_COOKIE_NAME,
    value,
    path: SESSION_COOKIE_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
    maxAge
  };
}

export async function requireAdminSession(
  request: Pick<HttpRequest, "headers">,
  getDatabase: () => Knex = getKnex
): Promise<AdminGuardResult> {
  const token = sessionToken(request);
  if (!token) return { authorized: false, response: authenticationRequired() };

  let current: CurrentSessionResult;
  try {
    current = await inspectSession(getDatabase(), token);
  } catch {
    return { authorized: false, response: internalFailure() };
  }
  if (!current.authenticated) {
    return { authorized: false, response: authenticationRequired() };
  }
  if (current.user.profile !== "administrador") {
    return { authorized: false, response: resourceNotFound() };
  }
  return { authorized: true, user: current.user, token };
}

export function createAuthHandlers(options: {
  getDatabase?: () => Knex;
  allowedOrigins?: readonly string[];
} = {}): {
  createSession: RequestHandler;
  currentSession: RequestHandler;
  deleteCurrentSession: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();

  const createSession: RequestHandler = async (request, _context) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;

    try {
      const validated = await validateJsonBody(request, loginSchema, { maxBytes: LOGIN_BODY_MAX_BYTES });
      if (!validated.success) return validated.response;

      const result = await createLoginSession(
        getDatabase(),
        validated.data,
        sessionToken(request)
      );
      if (!result.success) return authenticationFailed();

      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        cookies: [sessionCookie(result.token, SESSION_ABSOLUTE_SECONDS)],
        jsonBody: { user: result.user }
      };
    } catch {
      return internalFailure();
    }
  };

  const currentSession: RequestHandler = async (request, _context) => {
    try {
      const result = await requireAdminSession(request, getDatabase);
      if (!result.authorized) return result.response;
      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        jsonBody: { user: result.user }
      };
    } catch {
      return internalFailure();
    }
  };

  const deleteCurrentSession: RequestHandler = async (request, _context) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;

    const token = sessionToken(request);
    if (!token) {
      return {
        ...authenticationRequired(),
        cookies: [sessionCookie("", 0)]
      };
    }

    try {
      const revoked = await revokeSession(getDatabase(), token);
      if (!revoked) {
        return {
          ...authenticationRequired(),
          cookies: [sessionCookie("", 0)]
        };
      }
      return {
        status: 204,
        headers: { "cache-control": "no-store" },
        cookies: [sessionCookie("", 0)]
      };
    } catch {
      return internalFailure();
    }
  };

  return { createSession, currentSession, deleteCurrentSession };
}

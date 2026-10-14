import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";

export type ValidationSource =
  | { in: "body" }
  | { in: "path" | "query"; name?: string };

export type InputValidationResult<Schema extends z.ZodType> =
  | { success: true; data: z.output<Schema> }
  | { success: false; response: HttpResponseInit };

type PublicErrorCode =
  | "FIELD_REQUIRED"
  | "INVALID_TYPE"
  | "INVALID_FORMAT"
  | "VALUE_OUT_OF_RANGE"
  | "INVALID_VALUE";

type ValidationIssue = z.ZodError["issues"][number];
type ValidationProblemError = {
  code: PublicErrorCode;
  detail: string;
  source: { in: "body"; pointer: string } | { in: "path" | "query"; name: string };
};

export type ProblemResponseOptions = {
  status: number;
  title: string;
  detail: string;
  code?: string;
  errors?: readonly unknown[];
  headers?: Record<string, string>;
};

type JsonBodyRequest = Pick<HttpRequest, "json"> & Partial<Pick<HttpRequest, "body" | "headers">>;

const problemContentType = "application/problem+json";
const issueDetails: Record<PublicErrorCode, string> = {
  FIELD_REQUIRED: "Preencha este campo.",
  INVALID_TYPE: "Confira o valor informado.",
  INVALID_FORMAT: "Use o formato indicado.",
  VALUE_OUT_OF_RANGE: "Informe um valor dentro do limite permitido.",
  INVALID_VALUE: "Escolha um valor válido."
};

function isMissingInput(input: unknown, path: PropertyKey[]): boolean {
  if (path.length === 0) return input === undefined;

  let current = input;
  for (const part of path) {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      return false;
    }
    if (!Object.hasOwn(current, part)) return true;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current === undefined;
}

function publicCode(issue: ValidationIssue, input: unknown): PublicErrorCode {
  if (issue.code === "invalid_type") {
    return isMissingInput(input, issue.path) ? "FIELD_REQUIRED" : "INVALID_TYPE";
  }

  switch (issue.code) {
    case "invalid_format":
      return "INVALID_FORMAT";
    case "too_small":
    case "too_big":
      return "VALUE_OUT_OF_RANGE";
    case "invalid_value":
      return "INVALID_VALUE";
    default:
      return "INVALID_VALUE";
  }
}

function jsonPointer(path: PropertyKey[]): string {
  if (path.length === 0) return "";
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function sourceForIssue(issue: ValidationIssue, source: ValidationSource): ValidationProblemError["source"] {
  if (source.in === "body") {
    return { in: "body", pointer: jsonPointer(issue.path) };
  }

  const name = issue.path.length > 0 ? String(issue.path[0]) : source.name ?? "parameters";
  return { in: source.in, name };
}

function validationProblem(
  status: 400 | 422,
  detail: string,
  errors: ValidationProblemError[]
): HttpResponseInit {
  return createProblemResponse({
    status,
    title: "Dados inválidos",
    code: "VALIDATION_ERROR",
    detail,
    errors
  });
}

function oversizedRequestProblem(): HttpResponseInit {
  return createProblemResponse({
    status: 413,
    title: "Conteúdo muito grande",
    detail: "Os dados enviados são muito grandes. Revise as informações e tente novamente."
  });
}

function malformedJsonProblem(): HttpResponseInit {
  return validationProblem(400, "Não foi possível ler os dados enviados. Confira as informações e tente novamente.", [{
    code: "INVALID_FORMAT",
    detail: "Confira as informações enviadas e tente novamente.",
    source: { in: "body", pointer: "" }
  }]);
}

export function createProblemResponse(options: ProblemResponseOptions): HttpResponseInit {
  const jsonBody: Record<string, unknown> = {
    type: "about:blank",
    title: options.title,
    status: options.status
  };
  if (options.code !== undefined) jsonBody.code = options.code;
  jsonBody.detail = options.detail;
  if (options.errors !== undefined) jsonBody.errors = options.errors;

  return {
    status: options.status,
    headers: {
      ...options.headers,
      "content-type": problemContentType
    },
    jsonBody
  };
}

function queryValues(query: URLSearchParams): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  query.forEach((value, name) => {
    if (!Object.hasOwn(values, name)) {
      values[name] = value;
      return;
    }

    const current = values[name];
    values[name] = Array.isArray(current) ? [...current, value] : [current, value];
  });
  return values;
}

export function validateInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  source: ValidationSource
): InputValidationResult<Schema> {
  const candidate = source.in === "query" && input instanceof URLSearchParams
    ? queryValues(input)
    : input;
  const result = schema.safeParse(candidate);
  if (result.success) return { success: true, data: result.data };

  const errors = result.error.issues.map((issue): ValidationProblemError => {
    const code = publicCode(issue, candidate);
    return {
      code,
      detail: issueDetails[code],
      source: sourceForIssue(issue, source)
    };
  });
  const status = source.in === "body" ? 422 : 400;
  const detail = source.in === "body"
    ? "Confira as informações e corrija os campos indicados."
    : "Confira as informações selecionadas e tente novamente.";
  return { success: false, response: validationProblem(status, detail, errors) };
}

export async function validateJsonBody<Schema extends z.ZodType>(
  request: JsonBodyRequest,
  schema: Schema,
  options: { maxBytes?: number } = {}
): Promise<InputValidationResult<Schema>> {
  let input: unknown;
  try {
    const maxBytes = options.maxBytes;
    if (maxBytes !== undefined) {
      const contentLength = request.headers?.get("content-length");
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
        return { success: false, response: oversizedRequestProblem() };
      }
    }

    if (maxBytes === undefined || request.body === undefined || request.body === null) {
      input = await request.json();
    } else {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength > maxBytes - byteLength) {
            void reader.cancel().catch(() => undefined);
            return { success: false, response: oversizedRequestProblem() };
          }
          chunks.push(value);
          byteLength += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }

      input = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, byteLength)));
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      success: false,
      response: malformedJsonProblem()
    };
  }

  return validateInput(schema, input, { in: "body" });
}

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { z } = require("zod");
const {
  HEALTH_CHECK_TIMEOUT_MS,
  databaseIsHealthy
} = require("../dist/health/database-check.js");
const { createHealthHandler } = require("../dist/health/handler.js");
const { parsePostgresPort } = require("../dist/database/knex.js");
const { validateInput, validateJsonBody } = require("../dist/http/validation.js");

function makeContext() {
  const messages = [];
  return {
    messages,
    context: {
      invocationId: "test-invocation",
      log(message) {
        messages.push(String(message));
      }
    }
  };
}

test("health handler returns 200 and its endpoint-specific success body", async () => {
  const { context, messages } = makeContext();
  const handler = createHealthHandler(async () => true);

  const response = await handler({}, context);

  assert.equal(response.status, 200);
  assert.equal(response.headers, undefined);
  assert.deepEqual(response.jsonBody, { status: "ok" });
  assert.equal(messages.length, 1);
  const successLog = JSON.parse(messages[0]);
  assert.deepEqual(Object.keys(successLog).sort(), ["durationMs", "event", "invocationId", "outcome"]);
  assert.equal(successLog.event, "health_check");
  assert.equal(successLog.invocationId, "test-invocation");
  assert.equal(successLog.outcome, "ok");
  assert.equal(Number.isFinite(successLog.durationMs), true);
});

test("database failure returns a sanitized RFC 9457 problem response", async () => {
  const { context, messages } = makeContext();
  const handler = createHealthHandler(async () => {
    throw new Error("password=do-not-leak postgres://private/db");
  });

  const response = await handler({}, context);

  assert.equal(response.status, 503);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.deepEqual(response.jsonBody, {
    type: "about:blank",
    title: "Service Unavailable",
    status: 503,
    code: "HEALTH_CHECK_UNAVAILABLE"
  });
  assert.equal(JSON.stringify(response).includes("do-not-leak"), false);
  assert.equal(messages.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(messages[0])).sort(), [
    "durationMs",
    "event",
    "invocationId",
    "outcome"
  ]);
  assert.equal(messages[0].includes("do-not-leak"), false);
  assert.equal(messages[0].includes("postgres://"), false);
});

test("database failure maps to a generic 503 even when the probe returns false", async () => {
  const { context } = makeContext();
  const handler = createHealthHandler(async () => false);

  const response = await handler({}, context);

  assert.equal(response.status, 503);
  assert.deepEqual(response.headers, { "content-type": "application/problem+json" });
  assert.equal(response.jsonBody.code, "HEALTH_CHECK_UNAVAILABLE");
});

test("database check enforces the configured three-second total deadline", async () => {
  assert.equal(HEALTH_CHECK_TIMEOUT_MS, 3000);
  const startedAt = Date.now();

  const result = await databaseIsHealthy(() => new Promise(() => {}));

  const elapsedMs = Date.now() - startedAt;
  assert.equal(result, false);
  assert.ok(elapsedMs >= 2800, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 4000, `deadline exceeded tolerance: ${elapsedMs}ms`);
});

test("database check sanitizes query rejection into an unavailable result", async () => {
  const result = await databaseIsHealthy(async () => {
    throw new Error("raw postgres error with sensitive details");
  });

  assert.equal(result, false);
});

test("PostgreSQL port configuration accepts only valid TCP ports", () => {
  assert.equal(parsePostgresPort(undefined), 5432);
  assert.equal(parsePostgresPort("5433"), 5433);
  for (const invalidPort of ["", "0", "65536", "54ab"]) {
    assert.throws(
      () => parsePostgresPort(invalidPort),
      { message: "Database configuration is incomplete." }
    );
  }
});

function assertValidationProblem(result, status) {
  assert.equal(result.success, false);
  const response = result.response;
  assert.equal(response.status, status);
  assert.deepEqual(response.headers, { "content-type": "application/problem+json" });
  assert.equal(response.jsonBody.type, "about:blank");
  assert.equal(response.jsonBody.status, status);
  assert.equal(response.jsonBody.code, "VALIDATION_ERROR");
  assert.equal(typeof response.jsonBody.detail, "string");
  assert.ok(response.jsonBody.detail.length > 0);
  assert.ok(Array.isArray(response.jsonBody.errors));
  return response.jsonBody;
}

test("400 validation problems use the localized Bad Request title", () => {
  const result = validateInput(z.string().uuid(), "private-invalid-route-value", {
    in: "path",
    name: "userId"
  });

  assert.equal(assertValidationProblem(result, 400).title, "Dados inválidos");
});

test("422 validation problems use the localized Unprocessable Content title", () => {
  const result = validateInput(z.string().min(2), "x", { in: "body" });

  assert.equal(assertValidationProblem(result, 422).title, "Dados inválidos");
});

test("shared validation accepts valid route, query, and JSON body inputs", async () => {
  const route = validateInput(
    z.object({ userId: z.string().uuid() }),
    { userId: "b8b9559a-36fa-4a5a-9aa7-b09d754c30c9" },
    { in: "path" }
  );
  assert.deepEqual(route, {
    success: true,
    data: { userId: "b8b9559a-36fa-4a5a-9aa7-b09d754c30c9" }
  });

  const query = validateInput(
    z.object({ page: z.coerce.number().int().min(1), tag: z.array(z.string()) }),
    new URLSearchParams("page=2&tag=math&tag=history&tag=science"),
    { in: "query" }
  );
  assert.equal(query.success, true);
  assert.deepEqual(query.data, { page: 2, tag: ["math", "history", "science"] });

  const body = await validateJsonBody({
    json: async () => ({ displayName: "Synthetic Student", active: true })
  }, z.object({ displayName: z.string().min(1), active: z.boolean() }));
  assert.deepEqual(body, {
    success: true,
    data: { displayName: "Synthetic Student", active: true }
  });
});

test("malformed JSON returns a sanitized 400 problem with a body source", async () => {
  const result = await validateJsonBody({
    json: async () => { throw new SyntaxError("parser-secret password=not-for-response"); }
  }, z.object({ name: z.string() }));
  const problem = assertValidationProblem(result, 400);

  assert.equal(problem.detail, "Não foi possível ler os dados enviados. Confira as informações e tente novamente.");
  assert.deepEqual(problem.errors, [{
    code: "INVALID_FORMAT",
    detail: "Confira as informações enviadas e tente novamente.",
    source: { in: "body", pointer: "" }
  }]);
  const serialized = JSON.stringify(result.response);
  assert.equal(serialized.includes("parser-secret"), false);
  assert.equal(serialized.includes("password=not-for-response"), false);
  assert.equal(serialized.includes("SyntaxError"), false);
});

test("invalid route and query formats or types return 400 with parameter names", () => {
  const route = validateInput(
    z.object({ userId: z.string().uuid() }),
    { userId: "route-secret-not-a-uuid" },
    { in: "path" }
  );
  const routeProblem = assertValidationProblem(route, 400);
  assert.deepEqual(routeProblem.errors[0], {
    code: "INVALID_FORMAT",
    detail: "Use o formato indicado.",
    source: { in: "path", name: "userId" }
  });

  const routeType = validateInput(
    z.object({ userId: z.string() }),
    { userId: 123 },
    { in: "path" }
  );
  assert.equal(assertValidationProblem(routeType, 400).errors[0].code, "INVALID_TYPE");
  assert.deepEqual(routeType.response.jsonBody.errors[0].source, { in: "path", name: "userId" });

  const query = validateInput(
    z.object({ limit: z.coerce.number().int().min(1) }),
    new URLSearchParams("limit=query-secret-not-a-number"),
    { in: "query" }
  );
  const queryProblem = assertValidationProblem(query, 400);
  assert.deepEqual(queryProblem.errors[0], {
    code: "INVALID_TYPE",
    detail: "Confira o valor informado.",
    source: { in: "query", name: "limit" }
  });

  const queryFormat = validateInput(
    z.object({ order: z.enum(["asc", "desc"]) }),
    new URLSearchParams("order=query-secret-invalid-option"),
    { in: "query" }
  );
  assert.equal(assertValidationProblem(queryFormat, 400).errors[0].code, "INVALID_VALUE");
  assert.deepEqual(queryFormat.response.jsonBody.errors[0].source, { in: "query", name: "order" });
  const serialized = JSON.stringify([route.response, routeType.response, query.response, queryFormat.response]);
  assert.equal(serialized.includes("route-secret-not-a-uuid"), false);
  assert.equal(serialized.includes("query-secret-not-a-number"), false);
  assert.equal(serialized.includes("query-secret-invalid-option"), false);
});

test("body validation maps each supported issue class to a stable public code", () => {
  const cases = [
    {
      schema: z.object({ name: z.string() }),
      input: {},
      code: "FIELD_REQUIRED",
      path: "/name"
    },
    {
      schema: z.object({ age: z.number() }),
      input: { age: "private-type-value" },
      code: "INVALID_TYPE",
      path: "/age"
    },
    {
      schema: z.object({ email: z.string().email() }),
      input: { email: "private-invalid-email" },
      code: "INVALID_FORMAT",
      path: "/email"
    },
    {
      schema: z.object({ age: z.number().min(18) }),
      input: { age: 17 },
      code: "VALUE_OUT_OF_RANGE",
      path: "/age"
    },
    {
      schema: z.object({ role: z.enum(["student", "teacher"]) }),
      input: { role: "private-unknown-role" },
      code: "INVALID_VALUE",
      path: "/role"
    }
  ];

  for (const { schema, input, code, path } of cases) {
    const problem = assertValidationProblem(validateInput(schema, input, { in: "body" }), 422);
    assert.equal(problem.errors.length, 1);
    assert.equal(problem.errors[0].code, code);
    assert.deepEqual(problem.errors[0].source, { in: "body", pointer: path });
    assert.equal(problem.errors[0].detail.includes("private-"), false);
  }
});

test("nested type failures under a non-object parent remain INVALID_TYPE", () => {
  const schema = z.unknown().superRefine((_, context) => {
    context.addIssue({
      code: "invalid_type",
      expected: "string",
      path: ["parent", "child"]
    });
  });
  const result = validateInput(schema, { parent: "private-scalar" }, { in: "body" });
  const problem = assertValidationProblem(result, 422);

  assert.equal(problem.errors[0].code, "INVALID_TYPE");
  assert.deepEqual(problem.errors[0].source, { in: "body", pointer: "/parent/child" });
  assert.equal(JSON.stringify(result.response).includes("private-scalar"), false);
});

test("too-small and too-large constraints map to VALUE_OUT_OF_RANGE", () => {
  const tooSmall = validateInput(z.number().min(1), 0, { in: "body" });
  const tooLarge = validateInput(z.number().max(3), 4, { in: "body" });

  assert.equal(assertValidationProblem(tooSmall, 422).errors[0].code, "VALUE_OUT_OF_RANGE");
  assert.equal(assertValidationProblem(tooLarge, 422).errors[0].code, "VALUE_OUT_OF_RANGE");
});

test("multiple body failures use escaped JSON Pointers and sanitized Portuguese details", async () => {
  const sensitiveValue = "private-personal-value-not-email";
  const rawLibraryMessage = "SQL password=internal-secret raw zod detail";
  const schema = z.object({
    "a~/b": z.string().email(),
    age: z.number().min(18),
    token: z.string().refine(() => false, { message: rawLibraryMessage })
  });
  const result = await validateJsonBody({
    json: async () => ({ "a~/b": sensitiveValue, age: 12, token: "private-token" })
  }, schema);
  const problem = assertValidationProblem(result, 422);

  assert.equal(problem.detail, "Confira as informações e corrija os campos indicados.");
  assert.deepEqual(problem.errors.map((error) => error.code), [
    "INVALID_FORMAT",
    "VALUE_OUT_OF_RANGE",
    "INVALID_VALUE"
  ]);
  assert.deepEqual(problem.errors.map((error) => error.source), [
    { in: "body", pointer: "/a~0~1b" },
    { in: "body", pointer: "/age" },
    { in: "body", pointer: "/token" }
  ]);
  assert.deepEqual(problem.errors.map((error) => error.detail), [
    "Use o formato indicado.",
    "Informe um valor dentro do limite permitido.",
    "Escolha um valor válido."
  ]);

  const serialized = JSON.stringify(result.response);
  for (const secret of [sensitiveValue, "private-token", rawLibraryMessage, "invalid_format", "custom", "SQL", "password=internal-secret"]) {
    assert.equal(serialized.includes(secret), false, `response exposed ${secret}`);
  }
});

test("unknown Zod issue classes use INVALID_VALUE without exposing keys or messages", () => {
  const privateKey = "personal-data-must-not-appear";
  const result = validateInput(
    z.strictObject({ name: z.string() }),
    { name: "Synthetic", [privateKey]: "private-value" },
    { in: "body" }
  );
  const problem = assertValidationProblem(result, 422);

  assert.deepEqual(problem.errors, [{
    code: "INVALID_VALUE",
    detail: "Escolha um valor válido.",
    source: { in: "body", pointer: "" }
  }]);
  const serialized = JSON.stringify(result.response);
  assert.equal(serialized.includes(privateKey), false);
  assert.equal(serialized.includes("unrecognized_keys"), false);
});

test("root path and query issues use the supplied parameter name or safe generic name", () => {
  const named = validateInput(z.string(), 42, { in: "path", name: "userId" });
  const unnamed = validateInput(z.string(), 42, { in: "query" });
  const missingRoot = validateInput(z.string(), undefined, { in: "body" });

  assert.deepEqual(assertValidationProblem(named, 400).errors[0].source, {
    in: "path",
    name: "userId"
  });
  assert.deepEqual(assertValidationProblem(unnamed, 400).errors[0].source, {
    in: "query",
    name: "parameters"
  });
  assert.equal(assertValidationProblem(missingRoot, 422).errors[0].code, "FIELD_REQUIRED");
  assert.deepEqual(assertValidationProblem(missingRoot, 422).errors[0].source, {
    in: "body",
    pointer: ""
  });
});

test("JSON body parser rethrows non-syntax failures instead of misclassifying them", async () => {
  const internalFailure = new Error("internal stream failure");
  await assert.rejects(
    validateJsonBody({ json: async () => { throw internalFailure; } }, z.object({ name: z.string() })),
    (error) => error === internalFailure
  );
});

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAdminSimulationHandlers } = require("../dist/auth/admin-simulation-handler.js");

const allowedOrigin = "http://localhost:5173";
function request(method, { origin = allowedOrigin, requestedWith = "XMLHttpRequest", params, query, body, ifMatch } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (requestedWith !== undefined) headers.set("x-requested-with", requestedWith);
  if (ifMatch !== undefined) headers.set("if-match", ifMatch);
  return { method, headers, params, query, async json() { return body; } };
}
function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.equal(response.jsonBody.type, "about:blank");
  assert.equal(response.jsonBody.status, status);
  if (code !== undefined) assert.equal(response.jsonBody.code, code);
}

test("simulation reads require admin before protected domain access", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminSimulationHandlers({
    getDatabase() { databaseFactoryCalls += 1; throw new Error("No cookie must not reach the database."); },
    allowedOrigins: [allowedOrigin]
  });
  for (const response of await Promise.all([
    handlers.list(request("GET", { params: { classId: "1" }, query: new URLSearchParams() }), {}),
    handlers.get(request("GET", { params: { classId: "1", simulationId: "1" } }), {})
  ])) assertProblem(response, 401, "AUTHENTICATION_REQUIRED");
  assert.equal(databaseFactoryCalls, 0);
});

test("simulation path/query validation and mutation origin checks are sanitized", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminSimulationHandlers({
    getDatabase() { databaseFactoryCalls += 1; throw new Error("Invalid input must not reach the database."); },
    allowedOrigins: [allowedOrigin]
  });
  assertProblem(await handlers.get(request("GET", { params: { classId: "01", simulationId: "1" } }), {}), 400, "VALIDATION_ERROR");
  assertProblem(await handlers.list(request("GET", {
    params: { classId: "1" }, query: new URLSearchParams("page=0&sort=private")
  }), {}), 400, "VALIDATION_ERROR");
  const submittedValue = "PRIVATE-SIMULATION-BODY-MUST-NOT-ECHO";
  const invalidBody = await handlers.create(request("POST", {
    params: { classId: "1" },
    body: { type: submittedValue, bimester: 1, scheduledDate: "2026-10-12",
      subjects: [{ subjectId: "1", totalQuestions: 10, weightPercent: 10 }] }
  }), {});
  assertProblem(invalidBody, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidBody).includes(submittedValue), false);
  const invalidCreate = await handlers.create(request("POST", {
    origin: "https://attacker.example.test",
    params: { classId: "1" }, body: { type: "objetivo", bimester: 1, scheduledDate: "2026-10-12", subjects: [], secret: "private" }
  }), {});
  assertProblem(invalidCreate, 403, "ORIGIN_NOT_ALLOWED");
  assert.equal(JSON.stringify(invalidCreate).includes("private"), false);
  assert.equal(databaseFactoryCalls, 0);
});

test("simulation writes require admin before checking mutation preconditions", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminSimulationHandlers({
    getDatabase() { databaseFactoryCalls += 1; throw new Error("No cookie means the auth guard returns before querying."); },
    allowedOrigins: [allowedOrigin]
  });
  const cases = [
    [handlers.create, request("POST", { params: { classId: "1" }, body: {
      type: "objetivo", bimester: 1, scheduledDate: "2026-10-12",
      subjects: [{ subjectId: "1", totalQuestions: 10, weightPercent: 100 }]
    } })],
    [handlers.update, request("PATCH", { params: { classId: "1", simulationId: "1" },
      body: { scheduledDate: "2026-10-13" }, ifMatch: '"current"' })],
    [handlers.confirm, request("POST", { params: { classId: "1", simulationId: "1" }, ifMatch: '"current"' })],
    [handlers.remove, request("DELETE", { params: { classId: "1", simulationId: "1" }, ifMatch: '"current"' })]
  ];
  for (const [handler, req] of cases) assertProblem(await handler(req, {}), 401, "AUTHENTICATION_REQUIRED");
  assert.equal(databaseFactoryCalls, 0);
});

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resultScore, weightedContribution, provisionalAverage } = require("../dist/auth/result-calculations.js");
const { createAdminResultHandlers } = require("../dist/auth/admin-result-handler.js");

test("result calculations preserve full precision and distinguish pending, absence, and zero", () => {
  assert.equal(resultScore("pending", null, 10), null);
  assert.equal(resultScore("absent", null, 10), 0);
  assert.equal(resultScore("assessed", 0, 10), 0);
  assert.equal(resultScore("assessed", 7, 9), 7 / 9 * 10);
  const score = resultScore("assessed", 7, 9);
  assert.equal(weightedContribution(score, 25), score * 25 / 100);
  assert.deepEqual(provisionalAverage([2.5], true, 100), { value: 2.5, provisional: true });
  assert.deepEqual(provisionalAverage([2.5], false, 50), { value: 2.5, provisional: true });
  assert.deepEqual(provisionalAverage([2.5], false, 100), { value: 2.5, provisional: false });
  assert.throws(() => resultScore("assessed", 11, 10), RangeError);
});

test("result handlers reject unauthorized requests before reading protected records", async () => {
  let databaseCalls = 0;
  const handlers = createAdminResultHandlers({ getDatabase() { databaseCalls += 1; throw new Error("Must not reach data."); }, allowedOrigins: ["http://localhost:5173"] });
  const request = (method, params, query) => ({ method, params, query, headers: new Headers(), json: async () => ({}) });
  assert.equal((await handlers.list(request("GET", { classId: "1", simulationId: "1" }, new URLSearchParams()), {})).status, 401);
  assert.equal((await handlers.get(request("GET", { classId: "1", simulationId: "1", studentId: "1", subjectId: "1" }), {})).status, 401);
  assert.equal(databaseCalls, 0);
});

test("result query and body validation reject unknown, repeated and invalid fields", async () => {
  let databaseCalls = 0;
  const handlers = createAdminResultHandlers({ getDatabase() { databaseCalls += 1; throw new Error("Invalid data must not query."); }, allowedOrigins: ["http://localhost:5173"] });
  const request = (method, params, query, body) => ({ method, params, query, body: null,
    headers: new Headers({ origin: "http://localhost:5173", "x-requested-with": "XMLHttpRequest" }), json: async () => body });
  const invalidQuery = await handlers.list(request("GET", { classId: "1", simulationId: "1" }, new URLSearchParams("status=pending&status=absent")), {});
  assert.equal(invalidQuery.status, 400);
  const invalidBody = await handlers.patch(request("PATCH", { classId: "1", simulationId: "1", studentId: "1", subjectId: "1" }, undefined,
    { status: "assessed", correctAnswers: -1 }), {});
  assert.equal(invalidBody.status, 422);
  assert.equal(databaseCalls, 0);
});

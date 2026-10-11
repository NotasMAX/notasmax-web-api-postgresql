"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAdminSubjectHandlers } = require("../dist/auth/admin-subject-handler.js");

const allowedOrigin = "http://localhost:5173";

function request(method, { origin = allowedOrigin, requestedWith = "XMLHttpRequest", body, params, query } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (requestedWith !== undefined) headers.set("x-requested-with", requestedWith);
  return { method, headers, params, query, async json() { return body; } };
}

function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.equal(response.jsonBody.type, "about:blank");
  assert.equal(response.jsonBody.status, status);
  if (code !== undefined) assert.equal(response.jsonBody.code, code);
  return response.jsonBody;
}

test("subject routes require an administrator session before domain access", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminSubjectHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("No session means no database access.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const context = { invocationId: "subject-auth-unit", log() {} };

  const responses = await Promise.all([
    handlers.listSubjects(request("GET", { query: new URLSearchParams() }), context),
    handlers.createSubject(request("POST", { body: { name: "Private subject value" } }), context),
    handlers.updateSubject(request("PATCH", {
      params: { subjectId: "1" }, body: { name: "Private subject value" }
    }), context),
    handlers.deleteSubject(request("DELETE", { params: { subjectId: "1" } }), context)
  ]);

  for (const response of responses) assertProblem(response, 401, "AUTHENTICATION_REQUIRED");
  assert.equal(databaseFactoryCalls, 0);
});

test("subject mutations enforce origin and custom header before reading input", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminSubjectHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("Rejected origin must not access database.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const emitted = [];
  const context = { invocationId: "subject-origin-unit", log(message) { emitted.push(message); } };

  for (const operation of ["createSubject", "updateSubject", "deleteSubject"]) {
    let bodyReads = 0;
    const input = request(operation === "createSubject" ? "POST" : operation === "updateSubject" ? "PATCH" : "DELETE", {
      origin: "https://attacker.example.test",
      body: { name: "Secret rejected input" },
      params: { subjectId: "1" }
    });
    input.json = async () => { bodyReads += 1; return { name: "Secret rejected input" }; };
    assertProblem(await handlers[operation](input, context), 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(bodyReads, 0);
  }

  const missingHeader = request("POST", { body: { name: "Another secret" } });
  missingHeader.headers.delete("x-requested-with");
  let headerBodyReads = 0;
  missingHeader.json = async () => { headerBodyReads += 1; return { name: "Another secret" }; };
  assertProblem(await handlers.createSubject(missingHeader, context), 403, "REQUEST_HEADER_REQUIRED");
  assert.equal(headerBodyReads, 0);
  assert.equal(databaseFactoryCalls, 0);

  const records = emitted.map((line) => JSON.parse(line));
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
    assert.equal(record.result, "rejected");
  }
  const logs = JSON.stringify(records);
  assert.equal(logs.includes("Secret rejected input"), false);
  assert.equal(logs.includes("Another secret"), false);
});

test("subject query, path, and PATCH schemas return sanitized RFC 9457 errors", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminSubjectHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("Invalid input must not reach database.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const context = { invocationId: "subject-validation-unit", log() {} };

  const badQuery = await handlers.listSubjects(request("GET", {
    query: new URLSearchParams("page=0&pageSize=101&sort=private")
  }), context);
  assertProblem(badQuery, 400, "VALIDATION_ERROR");
  assert.ok(Array.isArray(badQuery.jsonBody.errors));
  assert.equal(JSON.stringify(badQuery).includes("private"), false);

  const invalidBody = await handlers.createSubject(request("POST", {
    body: { name: "  ", description: "x".repeat(501) }
  }), context);
  assertProblem(invalidBody, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidBody).includes("xxx"), false);

  const longName = "subject".repeat(18);
  const oversizedName = await handlers.createSubject(request("POST", {
    body: { name: longName }
  }), context);
  assertProblem(oversizedName, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(oversizedName).includes(longName), false);

  const emptyPatch = await handlers.updateSubject(request("PATCH", {
    params: { subjectId: "1" }, body: {}
  }), context);
  assertProblem(emptyPatch, 422, "VALIDATION_ERROR");

  const invalidPath = await handlers.deleteSubject(request("DELETE", { params: { subjectId: "01" } }), context);
  assertProblem(invalidPath, 400, "VALIDATION_ERROR");
  assert.equal(databaseFactoryCalls, 0);
});

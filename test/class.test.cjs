"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAdminClassHandlers } = require("../dist/auth/admin-class-handler.js");

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

test("class and subject-offer routes require an administrator before domain access", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminClassHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("No session means no database access.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const context = { invocationId: "class-auth-unit", log() {} };
  const responses = await Promise.all([
    handlers.listClasses(request("GET", { query: new URLSearchParams() }), context),
    handlers.listClassYears(request("GET"), context),
    handlers.getClass(request("GET", { params: { classId: "1" } }), context),
    handlers.createClass(request("POST", { body: { series: 1, schoolYear: 2026 } }), context),
    handlers.updateClass(request("PATCH", {
      params: { classId: "1" }, body: { schoolYear: 2027 }
    }), context),
    handlers.deleteClass(request("DELETE", { params: { classId: "1" } }), context),
    handlers.listClassSubjects(request("GET", { params: { classId: "1" } }), context),
    handlers.addClassSubject(request("PUT", { params: { classId: "1", subjectId: "2" } }), context),
    handlers.removeClassSubject(request("DELETE", { params: { classId: "1", subjectId: "2" } }), context)
  ]);

  for (const response of responses) assertProblem(response, 401, "AUTHENTICATION_REQUIRED");
  assert.equal(databaseFactoryCalls, 0);
});

test("class mutations reject Origin and custom-header failures before parsing input or using the database", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminClassHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("Rejected mutation must not access the database.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const logs = [];
  const context = { invocationId: "class-origin-unit", log(message) { logs.push(message); } };

  for (const operation of ["createClass", "updateClass", "deleteClass", "addClassSubject", "removeClassSubject"]) {
    const input = request(operation === "createClass" ? "POST" : operation === "updateClass" ? "PATCH" :
      operation === "addClassSubject" ? "PUT" : "DELETE", {
      origin: "https://attacker.example.test",
      body: { series: 1, schoolYear: 2026, privateValue: "origin-secret" },
      params: { classId: "1", subjectId: "2" }
    });
    let bodyReads = 0;
    input.json = async () => { bodyReads += 1; return { series: 1, schoolYear: 2026 }; };
    assertProblem(await handlers[operation](input, context), 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(bodyReads, 0);
  }

  const missingHeader = request("POST", { body: { series: 1, schoolYear: 2026 } });
  missingHeader.headers.delete("x-requested-with");
  let bodyReads = 0;
  missingHeader.json = async () => { bodyReads += 1; return { series: 1, schoolYear: 2026 }; };
  assertProblem(await handlers.createClass(missingHeader, context), 403, "REQUEST_HEADER_REQUIRED");
  assert.equal(bodyReads, 0);
  assert.equal(databaseFactoryCalls, 0);

  const records = logs.map((line) => JSON.parse(line));
  assert.equal(records.length, 6);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
    assert.equal(record.result, "rejected");
  }
  assert.equal(JSON.stringify(records).includes("origin-secret"), false);
});

test("class path, query, and strict JSON schemas produce sanitized RFC 9457 errors", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminClassHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("Invalid input must not reach the database.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const context = { invocationId: "class-validation-unit", log() {} };

  const badQuery = await handlers.listClasses(request("GET", {
    query: new URLSearchParams("schoolYear=2026x&page=0&pageSize=101&sort=private")
  }), context);
  assertProblem(badQuery, 400, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(badQuery).includes("private"), false);

  const outOfRangeYear = await handlers.listClasses(request("GET", {
    query: new URLSearchParams("schoolYear=2147483648")
  }), context);
  assertProblem(outOfRangeYear, 400, "VALIDATION_ERROR");

  const invalidCreate = await handlers.createClass(request("POST", {
    body: { series: 4, schoolYear: 2026, extra: "secret" }
  }), context);
  assertProblem(invalidCreate, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidCreate).includes("secret"), false);

  const emptyPatch = await handlers.updateClass(request("PATCH", {
    params: { classId: "1" }, body: {}
  }), context);
  assertProblem(emptyPatch, 422, "VALIDATION_ERROR");

  const invalidYearPatch = await handlers.updateClass(request("PATCH", {
    params: { classId: "1" }, body: { schoolYear: 2147483648 }
  }), context);
  assertProblem(invalidYearPatch, 422, "VALIDATION_ERROR");

  const invalidPath = await handlers.deleteClass(request("DELETE", { params: { classId: "01" } }), context);
  assertProblem(invalidPath, 400, "VALIDATION_ERROR");

  const invalidOfferPath = await handlers.addClassSubject(request("PUT", {
    params: { classId: "1", subjectId: "0" }
  }), context);
  assertProblem(invalidOfferPath, 400, "VALIDATION_ERROR");
  assert.equal(databaseFactoryCalls, 0);
});

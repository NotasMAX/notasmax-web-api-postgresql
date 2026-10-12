"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAdminClassHandlers } = require("../dist/auth/admin-class-handler.js");
const { createAdminEnrollmentHandlers } = require("../dist/auth/admin-enrollment-handler.js");
const { createEnrollment } = require("../dist/auth/admin-enrollment-service.js");

const allowedOrigin = "http://localhost:5173";

function request(method, {
  origin = allowedOrigin,
  requestedWith = "XMLHttpRequest",
  cookie,
  body,
  params,
  query
} = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (requestedWith !== undefined) headers.set("x-requested-with", requestedWith);
  if (cookie !== undefined) headers.set("cookie", `notasmax_session=${cookie}`);
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

function renewalKnex({ previousStartDate, effectiveOnStart = true }) {
  const writes = [];
  const previousRows = [{
    id_matricula: "4",
    ano_letivo: 2026,
    inicio_vigencia: previousStartDate,
    effective_on_start: effectiveOnStart
  }];

  const transaction = (table) => {
    const query = {
      select() { return this; },
      join() { return this; },
      where() { return this; },
      whereNull() { return this; },
      whereRaw() { return this; },
      orderBy() { return this; },
      forUpdate() { return this; },
      returning() { return this; },
      async first() {
        if (table === "usuario") return { id_usuario: "2" };
        if (table === "aluno") return { id_usuario: "2" };
        if (table === "turma") return {
          id_turma: "3", ano_letivo: 2027, inicio_em: "2026-01-01", fechada_em: null
        };
        return undefined;
      },
      update(values) {
        writes.push({ table, operation: "update", values });
        return Promise.resolve(1);
      },
      insert(values) {
        writes.push({ table, operation: "insert", values });
        return this;
      },
      then(resolve, reject) {
        const rows = table === "matricula as m" ? previousRows : [{ id_matricula: "5" }];
        return Promise.resolve(rows).then(resolve, reject);
      }
    };
    return query;
  };
  transaction.raw = (query) => query.includes("business_date")
    ? { rows: [{ business_date: "2026-10-11" }] }
    : { query };

  return {
    writes,
    async transaction(callback) { return callback(transaction); }
  };
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
    handlers.createClass(request("POST", { body: { series: 1, schoolYear: 2026, startDate: "2026-10-12" } }), context),
    handlers.updateClass(request("PATCH", {
      params: { classId: "1" }, body: { schoolYear: 2027 }
    }), context),
    handlers.closeClass(request("POST", { params: { classId: "1" } }), context),
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

  for (const operation of ["createClass", "updateClass", "closeClass", "addClassSubject", "removeClassSubject"]) {
    const input = request(operation === "createClass" || operation === "closeClass" ? "POST" : operation === "updateClass" ? "PATCH" :
      operation === "addClassSubject" ? "PUT" : "DELETE", {
      origin: "https://attacker.example.test",
      body: { series: 1, schoolYear: 2026, startDate: "2026-10-12", privateValue: "origin-secret" },
      params: { classId: "1", subjectId: "2" }
    });
    let bodyReads = 0;
    input.json = async () => { bodyReads += 1; return { series: 1, schoolYear: 2026, startDate: "2026-10-12" }; };
    assertProblem(await handlers[operation](input, context), 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(bodyReads, 0);
  }

  const missingHeader = request("POST", { body: { series: 1, schoolYear: 2026, startDate: "2026-10-12" } });
  missingHeader.headers.delete("x-requested-with");
  let bodyReads = 0;
  missingHeader.json = async () => { bodyReads += 1; return { series: 1, schoolYear: 2026, startDate: "2026-10-12" }; };
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
    body: { series: 4, schoolYear: 2026, startDate: "2026-10-12", extra: "secret" }
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

  const invalidPath = await handlers.closeClass(request("POST", { params: { classId: "01" } }), context);
  assertProblem(invalidPath, 400, "VALIDATION_ERROR");

  const invalidOfferPath = await handlers.addClassSubject(request("PUT", {
    params: { classId: "1", subjectId: "0" }
  }), context);
  assertProblem(invalidOfferPath, 400, "VALIDATION_ERROR");
  assert.equal(databaseFactoryCalls, 0);
});

test("enrollment cancellation requires an administrator before domain access", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminEnrollmentHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("No session means no database access.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const context = { invocationId: "enrollment-auth-unit", log() {} };
  const response = await handlers.cancelEnrollment(request("POST", {
    params: { enrollmentId: "1" },
    body: { cancellationDate: "2026-10-12" }
  }), context);

  assertProblem(response, 401, "AUTHENTICATION_REQUIRED");
  assert.equal(databaseFactoryCalls, 0);
});

test("enrollment creation requires an administrator before domain access", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminEnrollmentHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("No session means no domain database access.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const context = { invocationId: "enrollment-create-auth-unit", log() {} };
  const response = await handlers.createEnrollment(request("POST", {
    params: { classId: "1" },
    body: { studentId: "2", startDate: "2026-10-12" }
  }), context);

  assertProblem(response, 401, "AUTHENTICATION_REQUIRED");
  assert.equal(databaseFactoryCalls, 0);
});

test("renewal start-date boundary blocks equality and distinguishes adjacent dates without writes", async () => {
  const exactStart = renewalKnex({ previousStartDate: "2026-10-11" });
  assert.deepEqual(await createEnrollment(exactStart, {
    classId: "3", studentId: "2", startDate: "2026-10-11"
  }), { status: "previous-year-cannot-be-renewed" });
  assert.deepEqual(exactStart.writes, []);

  const exactStartConfirmed = renewalKnex({ previousStartDate: "2026-10-11" });
  assert.deepEqual(await createEnrollment(exactStartConfirmed, {
    classId: "3", studentId: "2", startDate: "2026-10-11", confirmPreviousEnrollmentId: "4"
  }), { status: "previous-year-cannot-be-renewed" });
  assert.deepEqual(exactStartConfirmed.writes, []);

  const previousDay = renewalKnex({ previousStartDate: "2026-10-10" });
  assert.deepEqual(await createEnrollment(previousDay, {
    classId: "3", studentId: "2", startDate: "2026-10-11"
  }), { status: "confirmation-required", previousEnrollmentId: "4" });
  assert.deepEqual(previousDay.writes, []);

  const followingDay = renewalKnex({
    previousStartDate: "2026-10-12",
    effectiveOnStart: false
  });
  assert.deepEqual(await createEnrollment(followingDay, {
    classId: "3", studentId: "2", startDate: "2026-10-11"
  }), { status: "already-active" });
  assert.deepEqual(followingDay.writes, []);
});

test("enrollment creation rejects origins, IDs, and dates before domain access and sanitizes logs", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminEnrollmentHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("Rejected input must not access the database.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const logs = [];
  const context = { invocationId: "enrollment-create-validation-unit", log(message) { logs.push(message); } };

  const badOrigin = request("POST", {
    origin: "https://attacker.example.test",
    params: { classId: "1" },
    body: { studentId: "2", startDate: "2026-10-12", privateValue: "request-secret" }
  });
  let bodyReads = 0;
  badOrigin.json = async () => {
    bodyReads += 1;
    return { studentId: "2", startDate: "2026-10-12", privateValue: "request-secret" };
  };
  assertProblem(await handlers.createEnrollment(badOrigin, context), 403, "ORIGIN_NOT_ALLOWED");
  assert.equal(bodyReads, 0);

  const missingHeader = request("POST", {
    params: { classId: "1" },
    body: { studentId: "2", startDate: "2026-10-12" }
  });
  missingHeader.headers.delete("x-requested-with");
  assertProblem(await handlers.createEnrollment(missingHeader, context), 403, "REQUEST_HEADER_REQUIRED");

  const invalidPath = await handlers.createEnrollment(request("POST", {
    params: { classId: "01" },
    body: { studentId: "2", startDate: "2026-10-12" }
  }), context);
  assertProblem(invalidPath, 400, "VALIDATION_ERROR");

  const invalidBody = await handlers.createEnrollment(request("POST", {
    params: { classId: "1" },
    body: { studentId: "01", startDate: "2026-02-30", privateValue: "request-secret" }
  }), context);
  assertProblem(invalidBody, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidBody).includes("request-secret"), false);
  assert.equal(databaseFactoryCalls, 0);

  const records = logs.map((line) => JSON.parse(line));
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
    assert.equal(record.event, "admin_enrollment_create");
    assert.equal(record.result, "rejected");
  }
  assert.equal(JSON.stringify(records).includes("request-secret"), false);
});

test("enrollment cancellation rejects origins, IDs, and dates before domain access and sanitizes logs", async () => {
  let databaseFactoryCalls = 0;
  const handlers = createAdminEnrollmentHandlers({
    getDatabase() {
      databaseFactoryCalls += 1;
      throw new Error("Rejected input must not access the database.");
    },
    allowedOrigins: [allowedOrigin]
  });
  const logs = [];
  const context = { invocationId: "enrollment-validation-unit", log(message) { logs.push(message); } };

  const badOrigin = request("POST", {
    origin: "https://attacker.example.test",
    params: { enrollmentId: "1" },
    body: { cancellationDate: "2026-10-12", privateValue: "request-secret" }
  });
  let bodyReads = 0;
  badOrigin.json = async () => {
    bodyReads += 1;
    return { cancellationDate: "2026-10-12", privateValue: "request-secret" };
  };
  assertProblem(await handlers.cancelEnrollment(badOrigin, context), 403, "ORIGIN_NOT_ALLOWED");
  assert.equal(bodyReads, 0);

  const invalidPath = await handlers.cancelEnrollment(request("POST", {
    params: { enrollmentId: "01" },
    body: { cancellationDate: "2026-10-12" }
  }), context);
  assertProblem(invalidPath, 400, "VALIDATION_ERROR");

  const invalidDate = await handlers.cancelEnrollment(request("POST", {
    params: { enrollmentId: "1" },
    body: { cancellationDate: "2026-02-30", privateValue: "request-secret" }
  }), context);
  assertProblem(invalidDate, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidDate).includes("request-secret"), false);
  assert.equal(databaseFactoryCalls, 0);

  const records = logs.map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
    assert.equal(record.event, "admin_enrollment_cancel");
    assert.equal(record.result, "rejected");
  }
  assert.equal(JSON.stringify(records).includes("request-secret"), false);
});

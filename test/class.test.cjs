"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { createAdminClassHandlers } = require("../dist/auth/admin-class-handler.js");
const { getClass, listClasses } = require("../dist/auth/admin-class-service.js");
const { createAdminEnrollmentHandlers } = require("../dist/auth/admin-enrollment-handler.js");
const { createEnrollment } = require("../dist/auth/admin-enrollment-service.js");
const { strongEtag } = require("../dist/http/etag.js");

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

function cancellationKnex({ actorId, token, studentId, classId, enrollmentId, startDate }) {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const session = {
    id_sessao: "51",
    id_usuario: actorId,
    expira_em: new Date("2027-01-01T00:00:00.000Z"),
    expira_absoluta_em: new Date("2027-01-01T00:00:00.000Z"),
    hash_token_sha256: createHash("sha256").update(token).digest()
  };
  const administrator = {
    id_usuario: actorId,
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-hash",
    ativado_em: new Date("2026-01-01T00:00:00.000Z"),
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  };
  let sessionFirstCalls = 0;
  let userFirstCalls = 0;
  let enrollmentFirstCalls = 0;
  let enrollmentUpdated = false;
  let cancellationCommitted = false;

  const transaction = (table) => {
    let isSessionList = false;
    const query = {
      select() { return this; },
      join() { return this; },
      where() { return this; },
      whereNull() { return this; },
      whereRaw() { return this; },
      whereIn() { isSessionList = true; return this; },
      orderBy() { return this; },
      forUpdate() { return this; },
      forShare() { return this; },
      async first() {
        if (table === "sessao") {
          sessionFirstCalls += 1;
          return sessionFirstCalls === 1
            ? { id_sessao: session.id_sessao, id_usuario: actorId }
            : sessionFirstCalls === 2 ? session : undefined;
        }
        if (table === "usuario") {
          userFirstCalls += 1;
          if (userFirstCalls === 1 || userFirstCalls === 5) return administrator;
          if (userFirstCalls === 4) return { id_usuario: studentId, tipo_perfil: "aluno" };
          return undefined;
        }
        if (table === "aluno") return { id_usuario: studentId };
        if (table === "turma") return { id_turma: classId, fechada_em: null };
        if (table === "matricula") {
          enrollmentFirstCalls += 1;
          return enrollmentFirstCalls === 1
            ? { id_usuario_aluno: studentId, id_turma: classId }
            : {
              id_matricula: enrollmentId,
              id_usuario_aluno: studentId,
              id_turma: classId,
              inicio_vigencia: startDate,
              fim_vigencia: null,
              cancelada_em: null
            };
        }
        return undefined;
      },
      update() {
        if (table === "matricula") enrollmentUpdated = true;
        return Promise.resolve(1);
      },
      then(resolve, reject) {
        return Promise.resolve(table === "sessao" && isSessionList ? [session] : []).then(resolve, reject);
      }
    };
    return query;
  };

  transaction.raw = (sql) => {
    if (sql === "SELECT clock_timestamp() AS database_now") return { rows: [{ database_now: now }] };
    if (sql === "SELECT CURRENT_DATE::text AS business_date") {
      return { rows: [{ business_date: "2026-10-15" }] };
    }
    return sql;
  };
  transaction.transaction = async (callback) => {
    const result = await callback(transaction);
    if (enrollmentUpdated) cancellationCommitted = true;
    return result;
  };
  transaction.cancellationCommitted = () => cancellationCommitted;
  return transaction;
}

test("class list and detail read representations derive isClosed consistently", async () => {
  const fixtures = [
    {
      id_turma: "31", serie: 1, ano_letivo: 2026, inicio_em: "2026-02-01",
      fechada_em: null, version: 1, subjects_version: 1, expectedClosed: false
    },
    {
      id_turma: "32", serie: 2, ano_letivo: 2026, inicio_em: "2026-02-02",
      fechada_em: "2026-06-30T12:00:00.000Z", version: 2, subjects_version: 1, expectedClosed: true
    }
  ];
  const expectedKeys = ["classId", "isClosed", "schoolYear", "series", "startDate"];
  const readKnex = (rows) => Object.assign((table) => {
    assert.equal(table, "turma");
    let countQuery = false;
    const query = {
      select() { return this; },
      where() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      offset() { return this; },
      count() { countQuery = true; return this; },
      async first() { return countQuery ? { total_items: rows.length } : rows[0]; },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); }
    };
    return query;
  }, { raw(value) { return value; } });

  const list = await listClasses(readKnex(fixtures), { schoolYear: 2026, page: 1, pageSize: 20 });
  assert.equal(list.items.length, fixtures.length);
  for (const [index, fixture] of fixtures.entries()) {
    const listed = list.items[index];
    const detail = await getClass(readKnex([fixture]), fixture.id_turma);
    assert.ok(detail);
    assert.equal(listed.isClosed, fixture.expectedClosed);
    assert.equal(detail.schoolClass.isClosed, fixture.expectedClosed);
    assert.deepEqual(Object.keys(listed).sort(), expectedKeys);
    assert.deepEqual(Object.keys(detail.schoolClass).sort(), expectedKeys);
    assert.deepEqual(detail.schoolClass, listed);
    assert.equal(Object.hasOwn(listed, "fechada_em"), false);
    assert.equal(Object.hasOwn(detail.schoolClass, "fechada_em"), false);
  }
});

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

test("successful enrollment cancellation emits one minimal audit event for each mode", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    for (const nodeEnv of ["development", "production"]) {
      process.env.NODE_ENV = nodeEnv;
      for (const cancellationMode of ["immediate", "date_based"]) {
        const actorId = "41";
        const studentId = "73";
        const classId = "8";
        const enrollmentId = cancellationMode === "immediate" ? "91" : "92";
        const token = cancellationMode === "immediate" ? "a".repeat(43) : "b".repeat(43);
        const startDate = "2026-10-20";
        const cancellationDate = cancellationMode === "date_based" ? "2026-10-22" : undefined;
        const knex = cancellationKnex({ actorId, token, studentId, classId, enrollmentId, startDate });
        const handlers = createAdminEnrollmentHandlers({ getDatabase: () => knex, allowedOrigins: [allowedOrigin] });
        const logs = [];
        const context = {
          invocationId: "synthetic-cancel-audit-" + cancellationMode,
          log(message) {
            assert.equal(knex.cancellationCommitted(), true);
            logs.push(message);
          }
        };
        const ifMatch = strongEtag({
          enrollmentId,
          studentId,
          classId,
          startDate,
          cancellationDate: null,
          cancellationRequestedAt: null
        });
        const cancelRequest = request("POST", {
          cookie: token,
          params: { enrollmentId },
          body: cancellationDate === undefined ? {} : { cancellationDate }
        });
        cancelRequest.headers.set("if-match", ifMatch);

        const response = await handlers.cancelEnrollment(cancelRequest, context);
        assert.equal(response.status, 204);
        assert.equal(logs.length, 1);
        const record = JSON.parse(logs[0]);
        assert.deepEqual(Object.keys(record).sort(), [
          "actorId", "cancellationMode", "enrollmentId", "event", "invocationId", "result"
        ]);
        assert.deepEqual(record, {
          event: "admin_enrollment_cancel",
          actorId,
          enrollmentId,
          cancellationMode,
          result: "completed",
          invocationId: context.invocationId
        });
        const serialized = JSON.stringify(record);
        const excludedValues = [studentId, classId, token, startDate];
        if (cancellationDate !== undefined) excludedValues.push(cancellationDate);
        for (const excludedValue of excludedValues) assert.equal(serialized.includes(excludedValue), false);
      }
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("a cancellation rejected by the service emits no enriched audit event", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const actorId = "43";
    const studentId = "75";
    const classId = "10";
    const enrollmentId = "96";
    const token = "f".repeat(43);
    const startDate = "2026-10-15";
    const knex = cancellationKnex({ actorId, token, studentId, classId, enrollmentId, startDate });
    const handlers = createAdminEnrollmentHandlers({ getDatabase: () => knex, allowedOrigins: [allowedOrigin] });
    const logs = [];
    const cancelRequest = request("POST", { cookie: token, params: { enrollmentId }, body: {} });
    cancelRequest.headers.set("if-match", strongEtag({
      enrollmentId,
      studentId,
      classId,
      startDate,
      cancellationDate: null,
      cancellationRequestedAt: null
    }));

    const response = await handlers.cancelEnrollment(cancelRequest, {
      invocationId: "synthetic-cancel-rejected",
      log(message) { logs.push(message); }
    });
    assertProblem(response, 422, "VALIDATION_ERROR");
    assert.equal(knex.cancellationCommitted(), false);
    assert.equal(logs.length, 1);
    const record = JSON.parse(logs[0]);
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
    assert.equal(record.event, "admin_enrollment_cancel");
    assert.equal(record.result, "rejected");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("enrollment cancellation logger failure preserves the response and production diagnostics stay off", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const token = "c".repeat(43);
    const enrollmentId = "93";
    const studentId = "74";
    const classId = "9";
    const startDate = "2026-10-20";
    const knex = cancellationKnex({
      actorId: "42", token, studentId, classId, enrollmentId, startDate
    });
    const handlers = createAdminEnrollmentHandlers({ getDatabase: () => knex, allowedOrigins: [allowedOrigin] });
    const cancelRequest = request("POST", { cookie: token, params: { enrollmentId }, body: {} });
    cancelRequest.headers.set("if-match", strongEtag({
      enrollmentId,
      studentId,
      classId,
      startDate,
      cancellationDate: null,
      cancellationRequestedAt: null
    }));
    const response = await handlers.cancelEnrollment(cancelRequest, {
      invocationId: "synthetic-cancel-logger-failure",
      log() { throw new Error("synthetic logger failure"); }
    });
    assert.equal(response.status, 204);

    const logs = [];
    const rejectingHandlers = createAdminEnrollmentHandlers({
      getDatabase() { throw new Error("synthetic database failure"); },
      allowedOrigins: [allowedOrigin]
    });
    const invalidPath = await rejectingHandlers.cancelEnrollment(request("POST", {
      params: { enrollmentId: "01" }, body: {}
    }), { invocationId: "synthetic-production-rejection", log(message) { logs.push(message); } });
    assertProblem(invalidPath, 400, "VALIDATION_ERROR");

    const failedAuthorization = await rejectingHandlers.cancelEnrollment(request("POST", {
      cookie: "d".repeat(43), params: { enrollmentId: "94" }, body: {}
    }), { invocationId: "synthetic-production-failure", log(message) { logs.push(message); } });
    assert.equal(failedAuthorization.status, 500);
    assert.deepEqual(logs, []);

    process.env.NODE_ENV = "development";
    const developmentLogs = [];
    const developmentHandlers = createAdminEnrollmentHandlers({
      getDatabase() { throw new Error("synthetic database failure"); },
      allowedOrigins: [allowedOrigin]
    });
    const developmentFailure = await developmentHandlers.cancelEnrollment(request("POST", {
      cookie: "e".repeat(43), params: { enrollmentId: "95" }, body: {}
    }), { invocationId: "synthetic-development-failure", log(message) { developmentLogs.push(message); } });
    assert.equal(developmentFailure.status, 500);
    assert.equal(developmentLogs.length, 1);
    const failureRecord = JSON.parse(developmentLogs[0]);
    assert.deepEqual(Object.keys(failureRecord).sort(), ["durationMs", "event", "invocationId", "result"]);
    assert.equal(failureRecord.event, "admin_enrollment_cancel");
    assert.equal(failureRecord.result, "failed");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

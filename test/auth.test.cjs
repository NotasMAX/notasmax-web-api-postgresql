"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const argon2 = require("argon2");
const { createAuthHandlers, requireAdminSession } = require("../dist/auth/handler.js");
const { createAdminAccountHandlers } = require("../dist/auth/admin-account-handler.js");
const { createAccountLifecycleHandlers } = require("../dist/auth/account-lifecycle-handler.js");
const { accountActionUrl, createFakeEmailAdapter } = require("../dist/auth/email-transport.js");
const { createLoginSession, reauthenticateAdministrator } = require("../dist/auth/session-service.js");

const allowedOrigin = "http://localhost:5173";
const password = "synthetic-unit-password-123";
const loginBody = { email: "admin@example.test", password };

function request(method, headers = {}, body, bodyStream) {
  let jsonCalls = 0;
  return {
    method,
    headers: new Headers(headers),
    body: bodyStream,
    async json() {
      jsonCalls += 1;
      if (body instanceof Error) throw body;
      return body;
    },
    get jsonCalls() { return jsonCalls; }
  };
}

function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.equal(response.jsonBody.type, "about:blank");
  assert.equal(response.jsonBody.status, status);
  if (code) assert.equal(response.jsonBody.code, code);
  return response.jsonBody;
}

function createLoginRaceFixture(initialAccount) {
  const state = {
    account: { ...initialAccount },
    snapshots: 0,
    lockedReads: 0,
    transactionCalls: 0,
    insideTransaction: false,
    updates: [],
    sessions: []
  };
  const queryFor = (table, locked) => ({
    select() { return this; },
    where() { return this; },
    whereNull() { return this; },
    forUpdate() { return this; },
    async first() {
      if (table !== "usuario") return undefined;
      if (locked) state.lockedReads += 1;
      else state.snapshots += 1;
      return { ...state.account };
    },
    async update(values) {
      state.updates.push({ ...values });
      Object.assign(state.account, values);
      return 1;
    },
    async insert(values) {
      state.sessions.push({ ...values });
      return 1;
    }
  });
  const transaction = (table) => queryFor(table, true);
  transaction.raw = async () => ({ rows: [{ database_now: new Date("2026-10-09T12:00:00.000Z") }] });
  const knex = Object.assign((table) => queryFor(table, false), {
    async transaction(callback) {
      state.transactionCalls += 1;
      state.insideTransaction = true;
      try {
        return await callback(transaction);
      } finally {
        state.insideTransaction = false;
      }
    }
  });
  return { knex, state };
}

const noContext = { log() { throw new Error("Auth handler must not log request data."); } };

test("login and logout reject absent, null, and disallowed Origin before body or database access", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });

  for (const origin of [undefined, "null", "https://attacker.example.test"]) {
    const headers = { "x-requested-with": "XMLHttpRequest" };
    if (origin !== undefined) headers.origin = origin;
    const loginRequest = request("POST", headers, loginBody);
    const login = await handlers.createSession(loginRequest, noContext);
    assertProblem(login, 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(loginRequest.jsonCalls, 0);

    const logout = await handlers.deleteCurrentSession(request("DELETE", headers), noContext);
    assertProblem(logout, 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(JSON.stringify([login, logout]).includes(origin || "missing-origin"), false);
  }

  assert.equal(databaseCalls, 0);
});

test("login and logout require the exact custom header before database access", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });

  for (const value of [undefined, "not-xml-http-request"]) {
    const headers = { origin: allowedOrigin };
    if (value !== undefined) headers["x-requested-with"] = value;
    const loginRequest = request("POST", headers, loginBody);
    assertProblem(await handlers.createSession(loginRequest, noContext), 403, "REQUEST_HEADER_REQUIRED");
    assert.equal(loginRequest.jsonCalls, 0);
    assertProblem(await handlers.deleteCurrentSession(request("DELETE", headers), noContext), 403,
      "REQUEST_HEADER_REQUIRED");
  }

  assert.equal(databaseCalls, 0);
});

test("login reuses shared JSON validation for malformed and invalid input without accessing the database", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const headers = { origin: allowedOrigin, "x-requested-with": "XMLHttpRequest" };

  const malformed = request("POST", headers, new SyntaxError("private-parser-error"));
  const malformedResponse = await handlers.createSession(malformed, noContext);
  assertProblem(malformedResponse, 400, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(malformedResponse).includes("private-parser-error"), false);

  const invalid = request("POST", headers, {
    email: "private-invalid-email",
    password: "short-secret"
  });
  const invalidResponse = await handlers.createSession(invalid, noContext);
  const body = assertProblem(invalidResponse, 422, "VALIDATION_ERROR");
  assert.deepEqual(body.errors.map((entry) => entry.code), ["INVALID_FORMAT", "VALUE_OUT_OF_RANGE"]);
  assert.equal(JSON.stringify(invalidResponse).includes("private-invalid-email"), false);
  assert.equal(JSON.stringify(invalidResponse).includes("short-secret"), false);
  assert.equal(databaseCalls, 0);
});

test("bounded login streams preserve malformed JSON and ordinary validation responses", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const headers = {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest"
  };
  const streamFor = (text) => {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    }, { highWaterMark: 0 });
  };
  const malformedRequest = request("POST", headers, undefined, streamFor('{"email":'));
  const malformed = await handlers.createSession(malformedRequest, noContext);
  assertProblem(malformed, 400, "VALIDATION_ERROR");
  assert.equal(malformed.jsonBody.detail, "O corpo da requisição não contém um JSON válido.");
  assert.equal(malformedRequest.jsonCalls, 0);

  const invalidRequest = request("POST", headers, undefined, streamFor(JSON.stringify({
    email: "private-invalid-email",
    password: "short-secret"
  })));
  const invalid = await handlers.createSession(invalidRequest, noContext);
  const invalidBody = assertProblem(invalid, 422, "VALIDATION_ERROR");
  assert.deepEqual(invalidBody.errors.map((entry) => entry.code), ["INVALID_FORMAT", "VALUE_OUT_OF_RANGE"]);
  assert.equal(invalidRequest.jsonCalls, 0);
  assert.equal(JSON.stringify([malformed, invalid]).includes("private-invalid-email"), false);
  assert.equal(JSON.stringify([malformed, invalid]).includes("short-secret"), false);
  assert.equal(databaseCalls, 0);
});

test("login rejects a declared oversized body before reading it or accessing the database", async () => {
  let bodyReadCount = 0;
  let databaseCalls = 0;
  const bodyStream = new ReadableStream({
    pull() {
      bodyReadCount += 1;
      throw new Error("oversized request body should not be read");
    }
  }, { highWaterMark: 0 });
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const loginRequest = request("POST", {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest",
    "content-length": String(8 * 1024 + 1)
  }, undefined, bodyStream);

  const response = await handlers.createSession(loginRequest, noContext);

  assert.equal(response.status, 413);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.deepEqual(response.jsonBody, {
    type: "about:blank",
    title: "Conteúdo muito grande",
    status: 413,
    detail: "O corpo da requisição excede o tamanho máximo permitido."
  });
  assert.equal(bodyReadCount, 0);
  assert.equal(loginRequest.jsonCalls, 0);
  assert.equal(databaseCalls, 0);
});

test("login enforces the byte limit when Content-Length is absent or underreported", async () => {
  const rejectedMarker = "synthetic-oversized-credential";
  const encodeLoginPayload = (unexpected) => new TextEncoder().encode(JSON.stringify({
    email: `${rejectedMarker}@example.test`,
    password: `short-${rejectedMarker}`,
    unexpected
  }));
  const utf8Payload = JSON.stringify({ email: "a@example.test", password: "synthetic-password", unexpected: "é".repeat(4200) });
  const escapedPayload = JSON.stringify({ email: "a@example.test", password: "synthetic-password", unexpected: String.fromCharCode(0).repeat(1500) });
  assert.ok(utf8Payload.length < 8 * 1024);
  assert.ok(new TextEncoder().encode(utf8Payload).byteLength > 8 * 1024);
  assert.ok(escapedPayload.length > 8 * 1024);
  const oversizedBodies = [
    encodeLoginPayload("x".repeat(9 * 1024)),
    encodeLoginPayload("é".repeat(4200)),
    encodeLoginPayload(String.fromCharCode(0).repeat(1500))
  ];
  assert.ok(oversizedBodies.every((body) => body.byteLength > 8 * 1024));

  for (const bodyBytes of oversizedBodies) {
    for (const contentLength of [undefined, "1"]) {
      let cancelled = false;
      let pullCount = 0;
      let databaseCalls = 0;
      const splitAt = Math.floor(8 * 1024 / 2);
      const chunks = [bodyBytes.subarray(0, splitAt), bodyBytes.subarray(splitAt)];
      let chunkIndex = 0;
      const headers = {
        origin: allowedOrigin,
        "x-requested-with": "XMLHttpRequest"
      };
      if (contentLength !== undefined) headers["content-length"] = contentLength;
      const bodyStream = new ReadableStream({
        pull(controller) {
          pullCount += 1;
          if (chunkIndex < chunks.length) controller.enqueue(chunks[chunkIndex++]);
          else controller.close();
        },
        cancel() { cancelled = true; }
      }, { highWaterMark: 0 });
      const handlers = createAuthHandlers({
        getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
        allowedOrigins: [allowedOrigin]
      });
      const loginRequest = request("POST", headers, undefined, bodyStream);

      const response = await handlers.createSession(loginRequest, noContext);

      assert.equal(response.status, 413);
      assert.equal(response.headers["content-type"], "application/problem+json");
      assert.equal(response.jsonBody.code, undefined);
      assert.equal(loginRequest.jsonCalls, 0);
      assert.equal(pullCount, 2);
      assert.equal(cancelled, true);
      assert.equal(databaseCalls, 0);
      assert.equal(JSON.stringify(response).includes(rejectedMarker), false);
    }
  }
});

test("the reusable administrator guard denies a missing or ambiguous cookie without database access", async () => {
  let databaseCalls = 0;
  for (const cookie of [undefined, "other=synthetic", "notasmax_session=bad", "notasmax_session=abc; notasmax_session=def"]) {
    const headers = new Headers();
    if (cookie !== undefined) headers.set("cookie", cookie);
    const result = await requireAdminSession({ headers }, () => {
      databaseCalls += 1;
      throw new Error("must not access database");
    });
    assert.equal(result.authorized, false);
    assertProblem(result.response, 401, "AUTHENTICATION_REQUIRED");
    assert.equal(result.response.headers["www-authenticate"], "NotasMAX-Session");
    assert.equal(result.response.headers["cache-control"], "no-store");
  }
  assert.equal(databaseCalls, 0);
});

test("unknown-email login invokes Argon2 verification with the approved dummy hash", async () => {
  const query = {
    select() { return this; },
    where() { return this; },
    async first() { return undefined; }
  };
  let transactionCalls = 0;
  let insideTransaction = false;
  const knex = Object.assign(() => query, {
    async transaction(callback) {
      transactionCalls += 1;
      insideTransaction = true;
      try {
        return await callback(Object.assign(() => query, { raw: async () => undefined }));
      } finally {
        insideTransaction = false;
      }
    }
  });
  const originalVerify = argon2.verify;
  const hashes = [];
  argon2.verify = async (hash, candidate, ...rest) => {
    assert.equal(insideTransaction, false);
    hashes.push(String(hash));
    return originalVerify(hash, candidate, ...rest);
  };

  try {
    assert.deepEqual(await createLoginSession(knex, {
      email: "unknown@example.test",
      password
    }), { success: false });
  } finally {
    argon2.verify = originalVerify;
  }

  assert.equal(hashes.length, 1);
  assert.equal(transactionCalls, 0);
  assert.match(hashes[0], /^\$argon2id\$v=19\$m=19456,(?:p=1,t=2|t=2,p=1)\$/);
});

test("known-account login runs Argon2 verification before opening a transaction", async () => {
  const databaseNow = new Date("2026-10-09T12:00:00.000Z");
  const account = {
    id_usuario: "42",
    email_institucional: "admin@example.test",
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-password-hash",
    ativado_em: databaseNow,
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  };
  const updates = [];
  const insertedSessions = [];
  let insideTransaction = false;
  const queryFor = (table) => ({
    select() { return this; },
    where() { return this; },
    whereNull() { return this; },
    forUpdate() { return this; },
    async first() { return table === "usuario" ? account : undefined; },
    async update(values) { updates.push(values); return 1; },
    async insert(values) { insertedSessions.push(values); return 1; }
  });
  const transaction = Object.assign((table) => queryFor(table), {
    async raw() { return { rows: [{ database_now: databaseNow }] }; }
  });
  const knex = Object.assign((table) => queryFor(table), {
    async transaction(callback) {
      insideTransaction = true;
      try {
        return await callback(transaction);
      } finally {
        insideTransaction = false;
      }
    }
  });
  const originalVerify = argon2.verify;
  let verifyInsideTransaction = false;
  argon2.verify = async () => {
    verifyInsideTransaction = insideTransaction;
    return true;
  };

  let result;
  try {
    result = await createLoginSession(knex, { email: account.email_institucional, password });
  } finally {
    argon2.verify = originalVerify;
  }

  assert.equal(verifyInsideTransaction, false);
  assert.equal(result.success, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].contador_pedidos_redefinicao, 0);
  assert.equal(updates[0].inicio_janela_redefinicao, null);
  assert.equal(insertedSessions.length, 1);
});

test("login session cookie covers authenticated API routes", async () => {
  const fixture = createLoginRaceFixture({
    id_usuario: "42",
    email_institucional: "admin@example.test",
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-password-hash",
    ativado_em: new Date("2026-10-09T12:00:00.000Z"),
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  });
  const handlers = createAuthHandlers({
    getDatabase: () => fixture.knex,
    allowedOrigins: [allowedOrigin]
  });
  const originalVerify = argon2.verify;
  argon2.verify = async () => true;

  let response;
  try {
    response = await handlers.createSession(request("POST", {
      origin: allowedOrigin,
      "x-requested-with": "XMLHttpRequest"
    }, loginBody), noContext);
  } finally {
    argon2.verify = originalVerify;
  }

  assert.equal(response.status, 200);
  const cookie = response.cookies.find((entry) => entry.name === "notasmax_session");
  assert.ok(cookie);
  assert.equal(cookie.path, "/api/v1");
  assert.ok("/api/v1/admin/students".startsWith(cookie.path + "/"));
});

test("stale password verification cannot create a session after the account hash changes", async () => {
  const fixture = createLoginRaceFixture({
    id_usuario: "42",
    email_institucional: "admin@example.test",
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-old-hash",
    ativado_em: new Date("2026-10-09T11:00:00.000Z"),
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  });
  const originalVerify = argon2.verify;
  const verifiedHashes = [];
  argon2.verify = async (hash) => {
    assert.equal(fixture.state.insideTransaction, false);
    verifiedHashes.push(String(hash));
    if (verifiedHashes.length === 1) {
      fixture.state.account.hash_senha = "synthetic-current-hash";
      return true;
    }
    return false;
  };

  let result;
  try {
    result = await createLoginSession(fixture.knex, {
      email: "admin@example.test",
      password: "synthetic-stale-password"
    });
  } finally {
    argon2.verify = originalVerify;
  }

  assert.deepEqual(verifiedHashes, ["synthetic-old-hash", "synthetic-current-hash"]);
  assert.deepEqual(result, { success: false });
  assert.equal(fixture.state.snapshots, 2);
  assert.equal(fixture.state.lockedReads, 4);
  assert.equal(fixture.state.sessions.length, 0);
  assert.equal(fixture.state.updates.length, 1);
});

test("login retry verifies the current account hash after a concurrent password change", async () => {
  const fixture = createLoginRaceFixture({
    id_usuario: "43",
    email_institucional: "admin@example.test",
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-before-reset-hash",
    ativado_em: new Date("2026-10-09T11:00:00.000Z"),
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  });
  const originalVerify = argon2.verify;
  const verifiedHashes = [];
  argon2.verify = async (hash) => {
    assert.equal(fixture.state.insideTransaction, false);
    verifiedHashes.push(String(hash));
    if (verifiedHashes.length === 1) {
      fixture.state.account.hash_senha = "synthetic-after-reset-hash";
      return false;
    }
    return String(hash) === "synthetic-after-reset-hash";
  };

  let result;
  try {
    result = await createLoginSession(fixture.knex, {
      email: "admin@example.test",
      password: "synthetic-current-password"
    });
  } finally {
    argon2.verify = originalVerify;
  }

  assert.deepEqual(verifiedHashes, ["synthetic-before-reset-hash", "synthetic-after-reset-hash"]);
  assert.equal(result.success, true);
  assert.equal(fixture.state.snapshots, 2);
  assert.equal(fixture.state.lockedReads, 4);
  assert.equal(fixture.state.sessions.length, 1);
  assert.equal(fixture.state.updates.length, 1);
});

test("login hash-change retries stop after the bounded attempt count", async () => {
  const fixture = createLoginRaceFixture({
    id_usuario: "44",
    email_institucional: "admin@example.test",
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-racing-hash-0",
    ativado_em: new Date("2026-10-09T11:00:00.000Z"),
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  });
  const originalVerify = argon2.verify;
  const verifiedHashes = [];
  argon2.verify = async (hash) => {
    assert.equal(fixture.state.insideTransaction, false);
    verifiedHashes.push(String(hash));
    fixture.state.account.hash_senha = `synthetic-racing-hash-${verifiedHashes.length}`;
    return true;
  };

  let result;
  try {
    result = await createLoginSession(fixture.knex, {
      email: "admin@example.test",
      password: "synthetic-password"
    });
  } finally {
    argon2.verify = originalVerify;
  }

  assert.deepEqual(verifiedHashes, [
    "synthetic-racing-hash-0",
    "synthetic-racing-hash-1",
    "synthetic-racing-hash-2"
  ]);
  assert.deepEqual(result, { success: false });
  assert.equal(fixture.state.snapshots, 3);
  assert.equal(fixture.state.lockedReads, 6);
  assert.equal(fixture.state.transactionCalls, 3);
  assert.equal(fixture.state.sessions.length, 0);
  assert.equal(fixture.state.updates.length, 0);
});

test("administrator password reauthentication runs Argon2 outside transactions and reuses account lockout", async () => {
  const fixture = createLoginRaceFixture({
    id_usuario: "45",
    email_institucional: "admin@example.test",
    tipo_perfil: "administrador",
    nome_completo: "Synthetic Administrator",
    hash_senha: "synthetic-admin-hash",
    ativado_em: new Date("2026-10-09T11:00:00.000Z"),
    excluido_em: null,
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  });
  const originalVerify = argon2.verify;
  const transactionsDuringArgon = [];
  argon2.verify = async () => {
    transactionsDuringArgon.push(fixture.state.insideTransaction);
    return true;
  };

  let authenticated;
  try {
    authenticated = await reauthenticateAdministrator(fixture.knex, "45", "synthetic-valid-current-password");
  } finally {
    argon2.verify = originalVerify;
  }

  assert.equal(authenticated, true);
  assert.deepEqual(transactionsDuringArgon, [false]);
  assert.deepEqual(fixture.state.updates, [{
    falhas_login_na_janela: 0,
    inicio_janela_falhas_login: null,
    bloqueado_ate: null
  }]);

  fixture.state.account.falhas_login_na_janela = 4;
  fixture.state.account.inicio_janela_falhas_login = new Date("2026-10-09T11:59:00.000Z");
  fixture.state.account.bloqueado_ate = null;
  fixture.state.updates.length = 0;
  argon2.verify = async () => {
    assert.equal(fixture.state.insideTransaction, false);
    return false;
  };
  try {
    authenticated = await reauthenticateAdministrator(fixture.knex, "45", "synthetic-wrong-current-password");
  } finally {
    argon2.verify = originalVerify;
  }

  assert.equal(authenticated, false);
  assert.equal(fixture.state.updates.length, 1);
  assert.equal(fixture.state.updates[0].falhas_login_na_janela, 5);
  assert.equal(fixture.state.updates[0].bloqueado_ate.toISOString(), "2026-10-09T12:15:00.000Z");
  assert.equal(fixture.state.sessions.length, 0);
});

test("administrator guard sanitizes unexpected database errors for future protected handlers", async () => {
  const rawError = "postgres://private-user:private-password@db.example.test/private-db";
  const result = await requireAdminSession({
    headers: new Headers({ cookie: `notasmax_session=${"A".repeat(43)}` })
  }, () => ({
    async transaction() { throw new Error(rawError); }
  }));

  assert.equal(result.authorized, false);
  assertProblem(result.response, 500);
  assert.equal(JSON.stringify(result.response).includes(rawError), false);
});

test("unexpected database errors become sanitized RFC 9457 responses without logs", async () => {
  const privateValues = [
    "synthetic-db-password",
    "synthetic-session-secret",
    "private@example.test",
    "203.0.113.42",
    "SELECT * FROM usuario",
    "raw-driver-stack"
  ];
  const handlers = createAuthHandlers({
    getDatabase() {
      return {
        async transaction() {
          throw new Error(privateValues.join(" "));
        }
      };
    },
    allowedOrigins: [allowedOrigin]
  });
  const response = await handlers.createSession(request("POST", {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest"
  }, loginBody), noContext);

  const body = assertProblem(response, 500);
  assert.equal(body.code, undefined);
  assert.equal(body.detail, "Não foi possível concluir a solicitação.");
  const serialized = JSON.stringify(response);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});

test("administrative account mutations reject Origin and custom-header failures before body or database access", async () => {
  let databaseCalls = 0;
  const handlers = createAdminAccountHandlers({
    getDatabase() {
      databaseCalls += 1;
      throw new Error("database access must not happen before browser-request checks");
    },
    allowedOrigins: [allowedOrigin]
  });
  const mutations = [
    [handlers.createStudent, {}],
    [handlers.updateStudent, { studentId: "1" }],
    [handlers.createTeacher, {}],
    [handlers.updateTeacher, { teacherId: "1" }],
    [handlers.addClassSubjectTeacher, { classId: "1", subjectId: "1", teacherId: "1" }],
    [handlers.removeClassSubjectTeacher, { classId: "1", subjectId: "1", teacherId: "1" }],
    [handlers.createAdministrator, {}],
    [handlers.updateAdministrator, { administratorId: "1" }]
  ];

  for (const [handler, params] of mutations) {
    for (const origin of [undefined, "null", "https://attacker.example.test"]) {
      let jsonCalls = 0;
      const headers = new Headers({ "x-requested-with": "XMLHttpRequest" });
      if (origin !== undefined) headers.set("origin", origin);
      const response = await handler({
        method: "POST",
        headers,
        params,
        async json() {
          jsonCalls += 1;
          return { email: "private-value@example.test" };
        }
      }, noContext);
      assertProblem(response, 403, "ORIGIN_NOT_ALLOWED");
      assert.equal(jsonCalls, 0);
      assert.equal(JSON.stringify(response).includes("attacker.example.test"), false);
    }

    let jsonCalls = 0;
    const response = await handler({
      method: "POST",
      headers: new Headers({ origin: allowedOrigin }),
      params,
      async json() {
        jsonCalls += 1;
        return { email: "private-value@example.test" };
      }
    }, noContext);
    assertProblem(response, 403, "REQUEST_HEADER_REQUIRED");
    assert.equal(jsonCalls, 0);
  }

  assert.equal(databaseCalls, 0);
});

test("retired account DELETE routes return the same static 404 without database access", async () => {
  let databaseCalls = 0;
  const handlers = createAdminAccountHandlers({
    getDatabase() {
      databaseCalls += 1;
      throw new Error("retired DELETE paths must not access the database");
    },
    allowedOrigins: [allowedOrigin]
  });
  const deletes = [handlers.deleteStudent, handlers.deleteTeacher, handlers.deleteAdministrator];
  const responses = [];
  for (const handler of deletes) {
    for (const id of ["1", "999999", "not-an-id"]) {
      responses.push(await handler({
        method: "DELETE",
        headers: new Headers({ origin: "https://attacker.example.test" }),
        params: { studentId: id, teacherId: id, administratorId: id }
      }, noContext));
    }
  }
  for (const response of responses) assertProblem(response, 404, "RESOURCE_NOT_FOUND");
  for (const response of responses.slice(1)) assert.deepEqual(response, responses[0]);
  assert.equal(databaseCalls, 0);
});

test("teacher-association routes reject malformed IDs before database access", async () => {
  let databaseCalls = 0;
  const handlers = createAdminAccountHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const headers = {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest"
  };

  const list = await handlers.listClassSubjectTeachers({
    method: "GET",
    headers: new Headers(),
    params: { classId: "0", subjectId: "1" }
  }, noContext);
  assertProblem(list, 400, "VALIDATION_ERROR");

  for (const handler of [handlers.addClassSubjectTeacher, handlers.removeClassSubjectTeacher]) {
    const response = await handler({
      method: "PUT",
      headers: new Headers(headers),
      params: { classId: "1", subjectId: "1", teacherId: "9223372036854775808" }
    }, noContext);
    assertProblem(response, 400, "VALIDATION_ERROR");
  }
  assert.equal(databaseCalls, 0);
});

test("fake email transport requires explicit local mode and an HTTPS host and never displays messages", async () => {
  assert.throws(() => createFakeEmailAdapter({
    NODE_ENV: "production",
    NOTASMAX_EMAIL_TRANSPORT: "fake",
    NOTASMAX_WEB_BASE_URL: "https://web.example.test"
  }));
  assert.throws(() => createFakeEmailAdapter({
    NODE_ENV: "test",
    NOTASMAX_EMAIL_TRANSPORT: "fake",
    NOTASMAX_WEB_BASE_URL: "http://localhost:5173"
  }));
  assert.throws(() => createFakeEmailAdapter({
    NODE_ENV: "test",
    NOTASMAX_EMAIL_TRANSPORT: "fake",
    NOTASMAX_WEB_BASE_URL: "https://web.example.test",
    WEBSITE_SITE_NAME: "synthetic-function-app"
  }));

  const adapter = createFakeEmailAdapter({
    NODE_ENV: "test",
    NOTASMAX_EMAIL_TRANSPORT: "fake",
    NOTASMAX_WEB_BASE_URL: "https://web.example.test"
  });
  const secretToken = "synthetic-token-that-must-not-be-displayed";
  const message = {
    kind: "activation",
    recipient: "synthetic-user@example.test",
    url: accountActionUrl(adapter.webBaseUrl, "activation", secretToken)
  };
  assert.equal(await adapter.transport.send(message), undefined);
  assert.match(message.url, /^https:\/\/web\.example\.test\/ativar-conta\?token=/);
  assert.equal(JSON.stringify(adapter).includes(secretToken), false);
});

test("account lifecycle validation reuses RFC 9457 and rejects malformed or invalid input before database access", async () => {
  let databaseCalls = 0;
  const handlers = createAccountLifecycleHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin],
    emailTransport: { async send() {} },
    webBaseUrl: "https://web.example.test"
  });

  const malformed = await handlers.requestPasswordReset(
    request("POST", {}, new SyntaxError("synthetic-parser-secret")),
    noContext
  );
  assertProblem(malformed, 400, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(malformed).includes("synthetic-parser-secret"), false);

  const secretEmail = "private-invalid-email-value";
  const invalidEmail = await handlers.requestPasswordReset(
    request("POST", {}, { email: secretEmail }),
    noContext
  );
  assertProblem(invalidEmail, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidEmail).includes(secretEmail), false);

  const secretPassword = "short-secret";
  const invalidPassword = await handlers.activate(
    request("POST", {}, { token: "malformed-token", password: secretPassword }),
    noContext
  );
  assertProblem(invalidPassword, 422, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(invalidPassword).includes(secretPassword), false);
  assert.equal(databaseCalls, 0);
});

test("password-reset account states follow one database and fake-transport path without sending unreserved messages", async () => {
  const now = new Date("2026-10-09T12:00:00.000Z");
  const activeAccount = {
    id_usuario: "51",
    email_institucional: "synthetic-active@example.test",
    hash_senha: "synthetic-password-hash",
    ativado_em: new Date("2026-10-01T12:00:00.000Z"),
    excluido_em: null,
    contador_pedidos_redefinicao: 0,
    inicio_janela_redefinicao: null
  };
  const cases = [
    { name: "unknown", account: undefined, expected: "not-reserved" },
    { name: "pending", account: { ...activeAccount, ativado_em: null, hash_senha: null }, expected: "not-reserved" },
    { name: "deleted", account: { ...activeAccount, excluido_em: now }, expected: "not-reserved" },
    {
      name: "quota-exceeded",
      account: {
        ...activeAccount,
        contador_pedidos_redefinicao: 3,
        inicio_janela_redefinicao: new Date(now.getTime() - 60 * 60 * 1000)
      },
      expected: "not-reserved"
    },
    { name: "eligible", account: activeAccount, expected: "reserved" }
  ];

  const expectedOperations = ["account-read", "database-clock", "quota-update", "token-delete", "token-insert"];
  for (const scenario of cases) {
    const activity = { operations: [], accountUpdates: [], tokenConditions: [] };
    const queryFor = (table) => ({
      select() { return this; },
      where() { return this; },
      forUpdate() { return this; },
      whereRaw(_sql, bindings) { this.shouldUpdate = bindings[0]; return this; },
      async first() {
        if (table !== "usuario") return undefined;
        activity.operations.push("account-read");
        return scenario.account ? { ...scenario.account } : undefined;
      },
      async update(values) {
        activity.operations.push("quota-update");
        activity.accountUpdates.push({ shouldUpdate: this.shouldUpdate, values: { ...values } });
        return 1;
      }
    });
    const transaction = (table) => queryFor(table);
    transaction.raw = async (sql, bindings) => {
      if (/clock_timestamp\(\)/.test(sql)) {
        activity.operations.push("database-clock");
        return { rows: [{ database_now: now }] };
      }
      if (/^DELETE FROM/.test(sql)) {
        activity.operations.push("token-delete");
        activity.tokenConditions.push({ operation: "delete", shouldPersist: bindings[2] });
      } else if (/^INSERT INTO/.test(sql)) {
        activity.operations.push("token-insert");
        activity.tokenConditions.push({ operation: "insert", shouldPersist: bindings[4] });
      }
      else assert.fail("unexpected SQL operation");
      return { rows: [] };
    };
    const knex = Object.assign(() => queryFor("usuario"), {
      async transaction(callback) { return callback(transaction); }
    });

    const transportCalls = [];
    const handlers = createAccountLifecycleHandlers({
      getDatabase: () => knex,
      allowedOrigins: [allowedOrigin],
      emailTransport: { async send(message) { transportCalls.push(message); } },
      webBaseUrl: "https://web.example.test"
    });
    const response = await handlers.requestPasswordReset(
      request("POST", {}, { email: "synthetic-request@example.test" }),
      { invocationId: "synthetic-reset-test", log() {} }
    );
    const reserved = scenario.expected === "reserved";
    assert.equal(response.status, 200, scenario.name);
    assert.equal(activity.operations.length, expectedOperations.length, scenario.name);
    assert.deepEqual(activity.operations, expectedOperations, scenario.name);
    assert.equal(activity.accountUpdates.length, 1, scenario.name);
    assert.equal(activity.accountUpdates[0].shouldUpdate, reserved, scenario.name);
    assert.deepEqual(activity.tokenConditions, [
      { operation: "delete", shouldPersist: reserved },
      { operation: "insert", shouldPersist: reserved }
    ], scenario.name);
    assert.equal(transportCalls.length, 1, scenario.name);
    assert.equal(transportCalls[0] !== undefined, reserved, scenario.name);
  }
});

test("malformed activation and reset tokens return uniform sanitized RFC 9457 errors", async () => {
  const handlers = createAccountLifecycleHandlers({ getDatabase: () => ({}) });
  const activationToken = "synthetic-activation-token";
  const resetToken = "synthetic-reset-token";
  const activation = await handlers.activate(request("POST", {}, {
    token: activationToken,
    password: "synthetic-valid-password-123"
  }), noContext);
  const reset = await handlers.completePasswordReset(request("POST", {}, {
    token: resetToken,
    password: "synthetic-valid-password-123"
  }), noContext);

  assertProblem(activation, 400, "ACTIVATION_TOKEN_INVALID");
  assertProblem(reset, 400, "PASSWORD_RESET_TOKEN_INVALID");
  assert.equal(JSON.stringify([activation, reset]).includes(activationToken), false);
  assert.equal(JSON.stringify([activation, reset]).includes(resetToken), false);
});

test("administrative activation resend rejects Origin, custom-header, and malformed path before database access", async () => {
  let databaseCalls = 0;
  const handlers = createAccountLifecycleHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin],
    emailTransport: { async send() {} },
    webBaseUrl: "https://web.example.test"
  });
  const baseHeaders = { "x-requested-with": "XMLHttpRequest" };

  for (const origin of [undefined, "null", "https://attacker.example.test"]) {
    const headers = { ...baseHeaders };
    if (origin !== undefined) headers.origin = origin;
    const response = await handlers.resendActivation({
      ...request("POST", headers),
      params: { userId: "12" }
    }, noContext);
    assertProblem(response, 403, "ORIGIN_NOT_ALLOWED");
  }

  const missingHeader = await handlers.resendActivation({
    ...request("POST", { origin: allowedOrigin }),
    params: { userId: "12" }
  }, noContext);
  assertProblem(missingHeader, 403, "REQUEST_HEADER_REQUIRED");

  for (const userId of ["0", "not-an-id", "9223372036854775808"]) {
    const malformedPath = await handlers.resendActivation({
      ...request("POST", { origin: allowedOrigin, "x-requested-with": "XMLHttpRequest" }),
      params: { userId }
    }, noContext);
    assertProblem(malformedPath, 400, "VALIDATION_ERROR");
    if (userId.length > 1) assert.equal(JSON.stringify(malformedPath).includes(userId), false);
  }
  assert.equal(databaseCalls, 0);
});

test("account lifecycle database errors are sanitized from responses and logs", async () => {
  const privateValues = [
    "private@example.test",
    "synthetic-reset-token-secret",
    "synthetic-password-secret",
    "synthetic-hash-secret",
    "203.0.113.77",
    "SELECT * FROM usuario",
    "raw-postgres-stack"
  ];
  const logs = [];
  const handlers = createAccountLifecycleHandlers({
    getDatabase: () => ({ async transaction() { throw new Error(privateValues.join(" ")); } }),
    emailTransport: { async send() {} },
    webBaseUrl: "https://web.example.test"
  });
  const response = await handlers.requestPasswordReset(request("POST", {}, {
    email: "synthetic-user@example.test"
  }), {
    invocationId: "synthetic-invocation",
    log(message) { logs.push(message); }
  });

  assertProblem(response, 500);
  const publicOutput = JSON.stringify(response);
  const loggedOutput = JSON.stringify(logs);
  for (const value of privateValues) {
    assert.equal(publicOutput.includes(value), false);
    assert.equal(loggedOutput.includes(value), false);
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /password_reset_request/);
});

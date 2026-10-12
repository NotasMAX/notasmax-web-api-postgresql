"use strict";

const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");
const { URL } = require("node:url");
const { test } = require("node:test");
const argon2 = require("argon2");
const knexFactory = require("knex");
const { Client } = require("pg");
const { assertLoopbackHost } = require("../src/database/local-only.cjs");
const { configurePostgresTimeZone } = require("../dist/database/postgres-timezone.js");
const { createInitialAdmin } = require("../seed/admin.cjs");
const { createAuthHandlers, requireAdminSession } = require("../dist/auth/handler.js");
const { createAdminAccountHandlers } = require("../dist/auth/admin-account-handler.js");
const { createAdminClassHandlers } = require("../dist/auth/admin-class-handler.js");
const { createAdminEnrollmentHandlers } = require("../dist/auth/admin-enrollment-handler.js");
const { createAdminSubjectHandlers } = require("../dist/auth/admin-subject-handler.js");
const { createAccountLifecycleHandlers } = require("../dist/auth/account-lifecycle-handler.js");
const { effectiveEnrollmentPredicate } = require("../dist/auth/effective-enrollment.js");
const { updateAccount } = require("../dist/auth/admin-account-service.js");
const {
  activateAccount,
  completePasswordReset,
  deleteExpiredLifecycleTokens,
  issueActivationToken
} = require("../dist/auth/account-lifecycle-service.js");
const { hashOpaqueToken } = require("../dist/auth/token-crypto.js");

const AUTH_ORIGIN = "http://localhost:5173";
const AUTH_PASSWORD = "synthetic-valid-admin-password";

const EXPECTED_DOMAIN_TABLES = [
  "aluno",
  "foto_perfil",
  "materia",
  "matricula",
  "professor",
  "resultado",
  "sessao",
  "simulado",
  "simulado_aluno",
  "simulado_disciplina",
  "token_ativacao",
  "token_redefinicao_senha",
  "turma",
  "turma_disciplina",
  "turma_disciplina_professor",
  "usuario"
];

function connectionFromEnvironment(database) {
  const host = process.env.PGHOST || "127.0.0.1";
  assertLoopbackHost(host);
  return {
    host,
    port: Number(process.env.PGPORT || 5432),
    database,
    user: process.env.PGUSER || "notasmax",
    password: process.env.PGPASSWORD,
    application_name: "notasmax-v1-integration-test"
  };
}

function makeKnex(connection, pool = { min: 0, max: 2, acquireTimeoutMillis: 5000 }) {
  return knexFactory({
    client: "pg",
    connection,
    pool: { ...pool, afterCreate: configurePostgresTimeZone },
    migrations: { tableName: "knex_migrations", extension: "js" }
  });
}

let identityCounter = 0;
function newIdentity(prefix) {
  identityCounter += 1;
  return `${prefix}-${process.pid}-${identityCounter}@example.test`;
}

async function insertUser(transaction, {
  profile = "administrador",
  email,
  pendingEmail = null,
  name = "Synthetic User",
  activated = true
}) {
  const [row] = await transaction("usuario")
    .insert({
      tipo_perfil: profile,
      nome_completo: name,
      email_institucional: email,
      email_pendente: pendingEmail,
      ativado_em: activated ? transaction.raw("CURRENT_TIMESTAMP") : null
    })
    .returning("id_usuario");
  return row.id_usuario;
}

async function insertStudent(database, email = newIdentity("student")) {
  return database.transaction(async (transaction) => {
    const id = await insertUser(transaction, { profile: "aluno", email });
    await transaction("aluno").insert({ id_usuario: id, telefone_responsavel: "+5511999990000" });
    return id;
  });
}

async function insertProfessor(database, email = newIdentity("professor")) {
  return database.transaction(async (transaction) => {
    const id = await insertUser(transaction, { profile: "professor", email });
    await transaction("professor").insert({ id_usuario: id });
    return id;
  });
}

async function insertPendingStudent(database, email = newIdentity("pending-student")) {
  return database.transaction(async (transaction) => {
    const id = await insertUser(transaction, { profile: "aluno", email, activated: false });
    await transaction("aluno").insert({ id_usuario: id, telefone_responsavel: "+5511999990000" });
    return id;
  });
}

async function syntheticPasswordHash(password = AUTH_PASSWORD) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1
  });
}

function authRequest(method, { origin = AUTH_ORIGIN, requestedWith = "XMLHttpRequest", cookie, body, forwardedFor } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (requestedWith !== undefined) headers.set("x-requested-with", requestedWith);
  if (cookie !== undefined) headers.set("cookie", `notasmax_session=${cookie}`);
  if (forwardedFor !== undefined) headers.set("x-forwarded-for", forwardedFor);
  return { method, headers, json: async () => body };
}

function authHandlers(database) {
  return createAuthHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN]
  });
}

function accountLifecycleHandlers(database, emailTransport) {
  return createAccountLifecycleHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN],
    emailTransport,
    webBaseUrl: "https://web.example.test"
  });
}

function adminAccountHandlers(database, emailTransport) {
  const base = createAdminAccountHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN],
    emailTransport,
    webBaseUrl: "https://web.example.test"
  });
  const tagMutation = (handler) => async (request, context) => {
    if (!request.headers.get("if-match") && request.headers.get("origin") === AUTH_ORIGIN
      && request.headers.get("x-requested-with") === "XMLHttpRequest") {
      const cookie = request.headers.get("cookie")?.match(/(?:^|;)\s*notasmax_session=([^;]+)/)?.[1];
      const result = await base.listClassSubjectTeachers(accountRequest("GET", {
        cookie, params: {
          classId: request.params?.classId,
          subjectId: request.params?.subjectId
        }
      }), context);
      request.headers.set("if-match", result.headers?.etag || '""');
    }
    return handler(request, context);
  };
  return {
    ...base,
    addClassSubjectTeacher: tagMutation(base.addClassSubjectTeacher),
    removeClassSubjectTeacher: tagMutation(base.removeClassSubjectTeacher)
  };
}

function adminSubjectHandlers(database) {
  return createAdminSubjectHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN]
  });
}

function adminClassHandlers(database) {
  const base = createAdminClassHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN]
  });
  const cookieFor = (request) => request.headers.get("cookie")?.match(/(?:^|;)\s*notasmax_session=([^;]+)/)?.[1];
  const classMutation = (handler) => async (request, context) => {
    if (!request.headers.get("if-match") && request.headers.get("origin") === AUTH_ORIGIN
      && request.headers.get("x-requested-with") === "XMLHttpRequest") {
      const result = await base.getClass(accountRequest("GET", {
        cookie: cookieFor(request), params: { classId: request.params?.classId }
      }), context);
      request.headers.set("if-match", result.headers?.etag || '""');
    }
    return handler(request, context);
  };
  const subjectMutation = (handler) => async (request, context) => {
    if (!request.headers.get("if-match") && request.headers.get("origin") === AUTH_ORIGIN
      && request.headers.get("x-requested-with") === "XMLHttpRequest") {
      const result = await base.listClassSubjects(accountRequest("GET", {
        cookie: cookieFor(request), params: { classId: request.params?.classId }
      }), context);
      request.headers.set("if-match", result.headers?.etag || '""');
    }
    return handler(request, context);
  };
  return {
    ...base,
    updateClass: classMutation(base.updateClass),
    closeClass: classMutation(base.closeClass),
    addClassSubject: subjectMutation(base.addClassSubject),
    removeClassSubject: subjectMutation(base.removeClassSubject)
  };
}

function adminEnrollmentHandlers(database) {
  const base = createAdminEnrollmentHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN]
  });
  const cookieFor = (request) => request.headers.get("cookie")?.match(/(?:^|;)\s*notasmax_session=([^;]+)/)?.[1];
  return {
    ...base,
    cancelEnrollment: async (request, context) => {
      if (!request.headers.get("if-match") && request.headers.get("origin") === AUTH_ORIGIN
        && request.headers.get("x-requested-with") === "XMLHttpRequest") {
        const result = await base.getEnrollment(accountRequest("GET", {
          cookie: cookieFor(request), params: { enrollmentId: request.params?.enrollmentId }
        }), context);
        request.headers.set("if-match", result.headers?.etag || '""');
      }
      return base.cancelEnrollment(request, context);
    },
    createEnrollment: async (request, context) => {
      if (!request.headers.get("if-match") && request.headers.get("origin") === AUTH_ORIGIN
        && request.headers.get("x-requested-with") === "XMLHttpRequest") {
        const body = await request.json();
        if (body?.confirmPreviousEnrollmentId !== undefined) {
          const result = await base.getEnrollment(accountRequest("GET", {
            cookie: cookieFor(request), params: { enrollmentId: String(body.confirmPreviousEnrollmentId) }
          }), context);
          request.headers.set("if-match", result.headers?.etag || '""');
        }
      }
      return base.createEnrollment(request, context);
    }
  };
}

let academicFixtureCounter = 0;
let schoolYearFixtureCounter = 0;

function nextSchoolYear() {
  schoolYearFixtureCounter += 1;
  return 1000000 + schoolYearFixtureCounter;
}

async function insertClass(database, { series = 1, schoolYear = nextSchoolYear(), startDate } = {}) {
  const [row] = await database("turma")
    .insert({
      serie: series,
      ano_letivo: schoolYear,
      inicio_em: startDate || database.raw("CURRENT_DATE - 1")
    })
    .returning("id_turma");
  return String(row.id_turma);
}

async function insertSubject(database, name = `Phase02 Subject ${process.pid} ${academicFixtureCounter += 1}`) {
  const [row] = await database("materia")
    .insert({ nome: name, descricao: null })
    .returning("id_materia");
  return String(row.id_materia);
}

async function insertSimulation(database, classId, {
  confirmed = false,
  cancelled = false,
  date = "2000-01-01"
} = {}) {
  academicFixtureCounter += 1;
  const [row] = await database("simulado")
    .insert({
      id_turma: classId,
      numero: academicFixtureCounter,
      tipo: "objetivo",
      bimestre: 1,
      data_realizacao: date,
      instante_confirmacao_realizacao: confirmed ? database.raw("clock_timestamp()") : null,
      excluido_em: cancelled ? database.raw("clock_timestamp()") : null
    })
    .returning("id_simulado");
  return String(row.id_simulado);
}

async function insertSimulationSubject(database, simulationId, classId, subjectId) {
  await database("simulado_disciplina").insert({
    id_simulado: simulationId,
    id_turma: classId,
    id_materia: subjectId,
    total_questoes: 1,
    peso: "1"
  });
}

function accountRequest(method, {
  origin = AUTH_ORIGIN,
  requestedWith = "XMLHttpRequest",
  cookie,
  body,
  params,
  query,
  ifMatch
} = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (requestedWith !== undefined) headers.set("x-requested-with", requestedWith);
  if (cookie !== undefined) headers.set("cookie", `notasmax_session=${cookie}`);
  if (ifMatch !== undefined) headers.set("if-match", ifMatch);
  return { method, headers, params, query, json: async () => body };
}

function sessionCookie(response) {
  return response.cookies && response.cookies.find((cookie) => cookie.name === "notasmax_session");
}

async function insertAuthAdministrator(database, { email = newIdentity("auth-admin"), password = AUTH_PASSWORD, name = "Synthetic Auth Administrator" } = {}) {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1
  });
  const id = await database.transaction(async (transaction) => {
    const userId = await insertUser(transaction, { profile: "administrador", email, name });
    await transaction("usuario").where({ id_usuario: userId }).update({ hash_senha: passwordHash });
    return userId;
  });
  return { id, email, password, passwordHash };
}

async function insertAuthSession(database, idUsuario) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();
  const { rows } = await database.raw("SELECT clock_timestamp() AS database_now");
  const now = new Date(rows[0].database_now);
  await database("sessao").insert({
    id_usuario: idUsuario,
    hash_token_sha256: tokenHash,
    criada_em: now,
    ultima_atividade_em: now,
    expira_em: new Date(now.getTime() + 15 * 60 * 1000),
    expira_absoluta_em: new Date(now.getTime() + 8 * 60 * 60 * 1000)
  });
  return token;
}

function expectPgCode(promise, code) {
  return assert.rejects(promise, (error) => {
    if (!error) return false;
    return typeof code === "function" ? code(error) : error.code === code;
  });
}

async function waitForLockWait(database, applicationName) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { rows } = await database.raw(`
      SELECT 1
      FROM pg_stat_activity
      WHERE application_name = ?
        AND datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%for update%'
    `, [applicationName]);
    if (rows.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("A test connection did not reach the expected PostgreSQL row-lock wait.");
}

function assertProblemResponse(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.equal(response.jsonBody.type, "about:blank");
  assert.equal(response.jsonBody.status, status);
  assert.equal(response.jsonBody.code, code);
  return response.jsonBody;
}

test("V1 schema, admin auth/session lifecycle, concurrency, and seed use a disposable PostgreSQL database", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "1"
}, async (t) => {
  const configuredDatabase = process.env.PGDATABASE || "notasmax";
  const maintenance = connectionFromEnvironment("postgres");
  let maintenanceClient;
  let database;
  let secondConnection;
  let generatedDatabase;
  let databaseCreated = false;

  try {
    maintenanceClient = new Client(maintenance);
    await maintenanceClient.connect();
    const serverVersion = await maintenanceClient.query("SHOW server_version");
    assert.match(serverVersion.rows[0].server_version, /^18\.6(?:[ .]|$)/);

    generatedDatabase = `notasmax_it_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    if (generatedDatabase === configuredDatabase || !/^notasmax_it_[a-z0-9_]+$/.test(generatedDatabase)) {
      throw new Error("Disposable database name did not pass the safety check.");
    }
    await maintenanceClient.query(`CREATE DATABASE "${generatedDatabase}"`);
    databaseCreated = true;

    const targetConnection = connectionFromEnvironment(generatedDatabase);
    database = makeKnex(targetConnection);
    secondConnection = makeKnex(targetConnection);

    const [batch, migrations] = await database.migrate.latest({
      directory: path.resolve(__dirname, "../migrations"),
      extension: "js"
    });
    assert.equal(batch, 1);
    assert.equal(migrations.length, 6);

    for (const connection of [database, secondConnection]) {
      const timeZone = await connection.raw("SELECT current_setting('TimeZone') AS time_zone");
      assert.equal(timeZone.rows[0].time_zone, "America/Sao_Paulo");
    }
    const midnightBoundary = await database.raw(`
      SELECT
        (TIMESTAMPTZ '2026-01-01 02:59:59+00')::date::text AS before_local_midnight,
        (TIMESTAMPTZ '2026-01-01 03:00:00+00')::date::text AS after_local_midnight
    `);
    assert.deepEqual(midnightBoundary.rows[0], {
      before_local_midnight: "2025-12-31",
      after_local_midnight: "2026-01-01"
    });

    await t.test("admin login creates hash-only session, rotates it on login, and logout revokes it", async () => {
      const account = await insertAuthAdministrator(database);
      await database("usuario").where({ id_usuario: account.id }).update({
        falhas_login_na_janela: 2,
        inicio_janela_falhas_login: database.raw("clock_timestamp() - INTERVAL '1 minute'"),
        contador_pedidos_redefinicao: 2,
        inicio_janela_redefinicao: database.raw("clock_timestamp() - INTERVAL '1 hour'")
      });
      const handlers = authHandlers(database);
      const login = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password },
        forwardedFor: "203.0.113.55"
      }), {});

      assert.equal(login.status, 200);
      assert.deepEqual(login.jsonBody, {
        user: {
          id: String(account.id),
          displayName: "Synthetic Auth Administrator",
          profile: "administrador"
        }
      });
      assert.deepEqual(Object.keys(login.jsonBody.user).sort(), ["displayName", "id", "profile"]);
      assert.equal(login.headers["cache-control"], "no-store");
      const firstCookie = sessionCookie(login);
      assert.ok(firstCookie);
      assert.equal(firstCookie.httpOnly, true);
      assert.equal(firstCookie.secure, true);
      assert.equal(firstCookie.sameSite, "None");
      assert.equal(firstCookie.path, "/api/v1");
      assert.equal(firstCookie.maxAge, 8 * 60 * 60);
      assert.equal(firstCookie.domain, undefined);

      const firstSession = await database("sessao").where({ id_usuario: account.id }).first();
      const expectedHash = createHash("sha256").update(firstCookie.value).digest();
      assert.equal(Buffer.isBuffer(firstSession.hash_token_sha256), true);
      assert.equal(firstSession.hash_token_sha256.equals(expectedHash), true);
      assert.notEqual(firstSession.hash_token_sha256.toString("utf8"), firstCookie.value);
      assert.equal(new Date(firstSession.expira_em).getTime() - new Date(firstSession.criada_em).getTime(),
        15 * 60 * 1000);
      assert.equal(new Date(firstSession.expira_absoluta_em).getTime() - new Date(firstSession.criada_em).getTime(),
        8 * 60 * 60 * 1000);
      const resetAccount = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela",
        "inicio_janela_falhas_login",
        "bloqueado_ate",
        "contador_pedidos_redefinicao",
        "inicio_janela_redefinicao"
      );
      assert.equal(resetAccount.falhas_login_na_janela, 0);
      assert.equal(resetAccount.inicio_janela_falhas_login, null);
      assert.equal(resetAccount.bloqueado_ate, null);
      assert.equal(resetAccount.contador_pedidos_redefinicao, 0);
      assert.equal(resetAccount.inicio_janela_redefinicao, null);
      const loginPublic = JSON.stringify({ headers: login.headers, jsonBody: login.jsonBody });
      for (const secret of [account.email, account.password, account.passwordHash, firstCookie.value, "203.0.113.55"]) {
        assert.equal(loginPublic.includes(secret), false);
      }

      const me = await handlers.currentSession(authRequest("GET", { cookie: firstCookie.value }), {});
      assert.equal(me.status, 200);
      assert.deepEqual(me.jsonBody, login.jsonBody);
      assert.equal(me.headers["cache-control"], "no-store");
      const guard = await requireAdminSession({
        headers: new Headers({ cookie: `notasmax_session=${firstCookie.value}` })
      }, () => database);
      assert.equal(guard.authorized, true);
      assert.deepEqual(guard.user, login.jsonBody.user);
      const rotated = await handlers.createSession(authRequest("POST", {
        cookie: firstCookie.value,
        body: { email: account.email, password: account.password }
      }), {});
      assert.equal(rotated.status, 200);
      const secondCookie = sessionCookie(rotated);
      assert.ok(secondCookie);
      assert.notEqual(secondCookie.value, firstCookie.value);
      const firstAfterRotation = await database("sessao").where({ id_sessao: firstSession.id_sessao }).first();
      assert.notEqual(firstAfterRotation.revogada_em, null);

      const logout = await handlers.deleteCurrentSession(authRequest("DELETE", {
        cookie: secondCookie.value
      }), {});
      assert.equal(logout.status, 204);
      assert.equal(logout.headers["cache-control"], "no-store");
      assert.deepEqual(sessionCookie(logout), {
        name: "notasmax_session",
        value: "",
        path: "/api/v1",
        httpOnly: true,
        secure: true,
        sameSite: "None",
        maxAge: 0
      });
      const secondHash = createHash("sha256").update(secondCookie.value).digest();
      const secondSession = await database("sessao").where({ hash_token_sha256: secondHash }).first();
      assert.notEqual(secondSession.revogada_em, null);
      const afterLogout = await handlers.currentSession(authRequest("GET", { cookie: secondCookie.value }), {});
      assert.equal(afterLogout.status, 401);
      assert.equal(afterLogout.headers["www-authenticate"], "NotasMAX-Session");
      assert.equal(afterLogout.headers["cache-control"], "no-store");
    });

    await t.test("login failures are generic for unknown, invalid, inactive, deleted, and locked accounts", async () => {
      const handlers = authHandlers(database);
      const wrongPassword = "synthetic-wrong-admin-password";
      const active = await insertAuthAdministrator(database, { email: newIdentity("auth-wrong") });
      const inactive = await insertAuthAdministrator(database, { email: newIdentity("auth-inactive") });
      const deleted = await insertAuthAdministrator(database, { email: newIdentity("auth-deleted") });
      const locked = await insertAuthAdministrator(database, { email: newIdentity("auth-locked") });
      const malformedHash = await insertAuthAdministrator(database, { email: newIdentity("auth-malformed-hash") });
      await database("usuario").where({ id_usuario: inactive.id }).update({ ativado_em: null });
      await database("usuario").where({ id_usuario: deleted.id }).update({ excluido_em: database.raw("clock_timestamp()") });
      await database("usuario").where({ id_usuario: locked.id }).update({
        bloqueado_ate: database.raw("clock_timestamp() + INTERVAL '15 minutes'")
      });
      await database("usuario").where({ id_usuario: malformedHash.id }).update({
        hash_senha: "synthetic-malformed-password-hash"
      });

      const publicFailures = [];
      publicFailures.push(await handlers.createSession(authRequest("POST", {
        body: { email: active.email, password: wrongPassword }
      }), {}));

      const originalVerify = argon2.verify;
      const dummyVerifications = [];
      argon2.verify = async (hash, password, ...rest) => {
        dummyVerifications.push(String(hash));
        return originalVerify(hash, password, ...rest);
      };
      try {
        publicFailures.push(await handlers.createSession(authRequest("POST", {
          body: { email: newIdentity("auth-unknown"), password: AUTH_PASSWORD }
        }), {}));
      } finally {
        argon2.verify = originalVerify;
      }
      assert.equal(dummyVerifications.length, 1);
      assert.match(dummyVerifications[0], /^\$argon2id\$v=19\$m=19456,(?:p=1,t=2|t=2,p=1)\$/);
      assert.notEqual(dummyVerifications[0], active.passwordHash);

      for (const account of [inactive, deleted, locked, malformedHash]) {
        publicFailures.push(await handlers.createSession(authRequest("POST", {
          body: { email: account.email, password: account.password }
        }), {}));
      }
      assert.equal(publicFailures.length, 6);
      for (const response of publicFailures) {
        assert.equal(response.status, 401);
        assert.equal(response.headers["content-type"], "application/problem+json");
        assert.equal(response.headers["www-authenticate"], "NotasMAX-Session");
        assert.equal(response.headers["cache-control"], "no-store");
        assert.deepEqual(response.jsonBody, publicFailures[0].jsonBody);
        assert.equal(response.cookies, undefined);
      }
      const serialized = JSON.stringify(publicFailures);
      for (const privateValue of [
        active.email, inactive.email, deleted.email, locked.email,
        active.password, wrongPassword, active.passwordHash, "203.0.113.55", "synthetic-malformed-password-hash"
      ]) assert.equal(serialized.includes(privateValue), false);
    });

    await t.test("account lockout enforces the fifth failure, window boundary, expiry, and success reset", async () => {
      const account = await insertAuthAdministrator(database, { email: newIdentity("auth-lockout") });
      const handlers = authHandlers(database);
      const invalidLogin = () => handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: "synthetic-wrong-admin-password" }
      }), {});

      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal((await invalidLogin()).status, 401);
      }
      let stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 4);
      assert.equal(stored.bloqueado_ate, null);

      assert.equal((await invalidLogin()).status, 401);
      stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 5);
      const lockCheck = await database.raw(
        "SELECT bloqueado_ate > clock_timestamp() AS active FROM usuario WHERE id_usuario = ?",
        [account.id]
      );
      assert.equal(lockCheck.rows[0].active, true);
      assert.equal((await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {})).status, 401);
      stored = await database("usuario").where({ id_usuario: account.id }).first("falhas_login_na_janela");
      assert.equal(stored.falhas_login_na_janela, 5);

      await database.raw(`
        UPDATE usuario
        SET bloqueado_ate = clock_timestamp() - INTERVAL '1 second',
            inicio_janela_falhas_login = clock_timestamp() - INTERVAL '15 minutes'
        WHERE id_usuario = ?
      `, [account.id]);
      assert.equal((await invalidLogin()).status, 401);
      stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 1);
      assert.equal(stored.bloqueado_ate, null);

      await database("usuario").where({ id_usuario: account.id }).update({
        falhas_login_na_janela: 3,
        inicio_janela_falhas_login: database.raw("clock_timestamp() - INTERVAL '1 minute'"),
        bloqueado_ate: null
      });
      const success = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {});
      assert.equal(success.status, 200);
      stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 0);
      assert.equal(stored.inicio_janela_falhas_login, null);
      assert.equal(stored.bloqueado_ate, null);
    });

    await t.test("shared administrator guard distinguishes active non-admin sessions and avoids cache", async () => {
      const studentId = await insertStudent(database, newIdentity("auth-student"));
      const studentToken = await insertAuthSession(database, studentId);
      const result = await requireAdminSession({
        headers: new Headers({ cookie: `notasmax_session=${studentToken}` })
      }, () => database);
      assert.equal(result.authorized, false);
      assert.equal(result.response.status, 404);
      assert.equal(result.response.jsonBody.code, "RESOURCE_NOT_FOUND");
      assert.equal(result.response.headers["cache-control"], "no-store");
      assert.equal(JSON.stringify(result.response).includes(studentToken), false);

      const handlers = authHandlers(database);
      const response = await handlers.currentSession(authRequest("GET", { cookie: studentToken }), {});
      assert.equal(response.status, 404);
      assert.equal(response.jsonBody.code, "RESOURCE_NOT_FOUND");
      assert.equal(response.headers["cache-control"], "no-store");
    });

    await t.test("idle and absolute expiry invalidate sessions and sliding activity never exceeds the absolute limit", async () => {
      const account = await insertAuthAdministrator(database, { email: newIdentity("auth-expiry") });
      const handlers = authHandlers(database);
      const firstLogin = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {});
      const firstToken = sessionCookie(firstLogin).value;
      const firstHash = createHash("sha256").update(firstToken).digest();
      let firstSession = await database("sessao").where({ hash_token_sha256: firstHash }).first();
      await database.raw(`
        UPDATE sessao
        SET expira_em = clock_timestamp() - INTERVAL '1 second',
            expira_absoluta_em = clock_timestamp() + INTERVAL '1 hour'
        WHERE id_sessao = ?
      `, [firstSession.id_sessao]);
      const idleExpired = await handlers.currentSession(authRequest("GET", { cookie: firstToken }), {});
      assert.equal(idleExpired.status, 401);
      firstSession = await database("sessao").where({ id_sessao: firstSession.id_sessao }).first();
      assert.notEqual(firstSession.revogada_em, null);

      const secondLogin = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {});
      const secondToken = sessionCookie(secondLogin).value;
      const secondHash = createHash("sha256").update(secondToken).digest();
      const secondSession = await database("sessao").where({ hash_token_sha256: secondHash }).first();
      await database.raw(`
        UPDATE sessao
        SET ultima_atividade_em = clock_timestamp() - INTERVAL '5 minutes',
            expira_em = clock_timestamp() + INTERVAL '4 minutes',
            expira_absoluta_em = clock_timestamp() + INTERVAL '5 minutes'
        WHERE id_sessao = ?
      `, [secondSession.id_sessao]);
      const active = await handlers.currentSession(authRequest("GET", { cookie: secondToken }), {});
      assert.equal(active.status, 200);
      const cappedSession = await database("sessao").where({ id_sessao: secondSession.id_sessao }).first();
      assert.equal(new Date(cappedSession.expira_em).getTime(), new Date(cappedSession.expira_absoluta_em).getTime());
      assert.ok(new Date(cappedSession.ultima_atividade_em).getTime() > new Date(secondSession.ultima_atividade_em).getTime());

      await database.raw(`
        UPDATE sessao
        SET expira_em = clock_timestamp() - INTERVAL '2 seconds',
            expira_absoluta_em = clock_timestamp() - INTERVAL '1 second'
        WHERE id_sessao = ?
      `, [secondSession.id_sessao]);
      const absoluteExpired = await handlers.currentSession(authRequest("GET", { cookie: secondToken }), {});
      assert.equal(absoluteExpired.status, 401);
      const expiredRow = await database("sessao").where({ id_sessao: secondSession.id_sessao }).first();
      assert.notEqual(expiredRow.revogada_em, null);
    });

    await t.test("separate PostgreSQL connections serialize concurrent lockout, session activity, and revocation", async () => {
      const backendPids = await Promise.all([
        database.raw("SELECT pg_backend_pid() AS pid"),
        secondConnection.raw("SELECT pg_backend_pid() AS pid")
      ]);
      assert.notEqual(backendPids[0].rows[0].pid, backendPids[1].rows[0].pid);

      const lockoutAccount = await insertAuthAdministrator(database, { email: newIdentity("auth-concurrent-lockout") });
      const firstHandlers = authHandlers(database);
      const secondHandlers = authHandlers(secondConnection);
      const concurrentFailures = await Promise.all([
        firstHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        secondHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        firstHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        secondHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        firstHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {})
      ]);
      assert.ok(concurrentFailures.every((response) => response.status === 401));
      const lockoutState = await database("usuario").where({ id_usuario: lockoutAccount.id }).first(
        "falhas_login_na_janela", "bloqueado_ate"
      );
      assert.equal(lockoutState.falhas_login_na_janela, 5);
      const lockCheck = await database.raw(
        "SELECT bloqueado_ate > clock_timestamp() AS active FROM usuario WHERE id_usuario = ?",
        [lockoutAccount.id]
      );
      assert.equal(lockCheck.rows[0].active, true);

      const sessionAccount = await insertAuthAdministrator(database, { email: newIdentity("auth-concurrent-session") });
      const login = await firstHandlers.createSession(authRequest("POST", {
        body: { email: sessionAccount.email, password: sessionAccount.password }
      }), {});
      const token = sessionCookie(login).value;
      const rotated = await Promise.all([
        firstHandlers.createSession(authRequest("POST", {
          cookie: token,
          body: { email: sessionAccount.email, password: sessionAccount.password }
        }), {}),
        secondHandlers.createSession(authRequest("POST", {
          cookie: token,
          body: { email: sessionAccount.email, password: sessionAccount.password }
        }), {})
      ]);
      assert.ok(rotated.every((response) => response.status === 200));
      const rotatedTokens = rotated.map((response) => sessionCookie(response).value);
      assert.notEqual(rotatedTokens[0], token);
      assert.notEqual(rotatedTokens[1], token);
      assert.notEqual(rotatedTokens[0], rotatedTokens[1]);
      const originalHash = createHash("sha256").update(token).digest();
      const originalSession = await database("sessao").where({ hash_token_sha256: originalHash }).first();
      assert.notEqual(originalSession.revogada_em, null);

      const activity = await Promise.all([
        firstHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {}),
        secondHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {})
      ]);
      assert.ok(activity.every((response) => response.status === 200));

      const transition = await Promise.all([
        firstHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {}),
        secondHandlers.deleteCurrentSession(authRequest("DELETE", { cookie: rotatedTokens[0] }), {})
      ]);
      assert.ok([200, 401].includes(transition[0].status));
      assert.equal(transition[1].status, 204);
      const tokenHash = createHash("sha256").update(rotatedTokens[0]).digest();
      const revoked = await database("sessao").where({ hash_token_sha256: tokenHash }).first();
      assert.notEqual(revoked.revogada_em, null);
      assert.equal((await secondHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {})).status, 401);
      assert.equal((await secondHandlers.deleteCurrentSession(authRequest("DELETE", {
        cookie: rotatedTokens[1]
      }), {})).status, 204);
    });

    await t.test("password reset is generic, enforces the fixed account quota, and reopens after 24 hours", async () => {
      const activeEmail = newIdentity("reset-quota-active");
      const activeId = await insertStudent(database, activeEmail);
      const passwordHash = await syntheticPasswordHash();
      await database("usuario").where({ id_usuario: activeId }).update({ hash_senha: passwordHash });
      const pendingEmail = newIdentity("reset-quota-pending");
      const pendingId = await insertPendingStudent(database, pendingEmail);
      const deletedEmail = newIdentity("reset-quota-deleted");
      const deletedId = await insertStudent(database, deletedEmail);
      await database("usuario").where({ id_usuario: deletedId }).update({
        excluido_em: database.raw("clock_timestamp()")
      });
      const sent = [];
      const transportCalls = [];
      const logs = [];
      const handlers = accountLifecycleHandlers(database, {
        async send(message) {
          transportCalls.push(message);
          if (message) sent.push(message);
        }
      });
      const context = { invocationId: "synthetic-reset-invocation", log(message) { logs.push(message); } };
      const requestReset = (email) => handlers.requestPasswordReset(accountRequest("POST", {
        body: { email }
      }), context);
      const unknown = await requestReset(newIdentity("unknown-reset"));
      const pending = await requestReset(pendingEmail);
      const deleted = await requestReset(deletedEmail);
      const expectedBody = {
        message: "Se houver uma conta ativa associada a este e-mail, enviaremos um link para redefinir sua senha."
      };
      for (const response of [unknown, pending, deleted]) {
        assert.equal(response.status, 200);
        assert.deepEqual(response.jsonBody, expectedBody);
        assert.equal(response.headers["cache-control"], "no-store");
      }
      assert.equal(transportCalls.length, 3);
      assert.equal(sent.length, 0);
      for (const id of [pendingId, deletedId]) {
        const account = await database("usuario").where({ id_usuario: id }).first(
          "contador_pedidos_redefinicao", "inicio_janela_redefinicao"
        );
        assert.equal(account.contador_pedidos_redefinicao, 0);
        assert.equal(account.inicio_janela_redefinicao, null);
        assert.equal(await database("token_redefinicao_senha").where({ id_usuario: id }).first(), undefined);
      }

      const activeResponses = [];
      for (let index = 0; index < 3; index += 1) activeResponses.push(await requestReset(activeEmail));
      for (const response of activeResponses) {
        assert.equal(response.status, 200);
        assert.deepEqual(response.jsonBody, expectedBody);
      }
      assert.equal(transportCalls.length, 6);
      assert.equal(sent.length, 3);
      const firstToken = new URL(sent[0].url).searchParams.get("token");
      const thirdToken = new URL(sent[2].url).searchParams.get("token");
      const currentToken = await database("token_redefinicao_senha").where({ id_usuario: activeId }).first();
      assert.equal(currentToken.hash_token_sha256.equals(hashOpaqueToken(thirdToken)), true);
      assert.equal(currentToken.hash_token_sha256.equals(Buffer.from(thirdToken)), false);
      const resetLifetime = new Date(currentToken.expira_em).getTime() - Date.now();
      assert.ok(resetLifetime <= 60 * 60 * 1000);
      assert.ok(resetLifetime > 60 * 60 * 1000 - 10_000);
      assert.equal(await completePasswordReset(database, firstToken, "synthetic-replacement-password-123"), false);

      const overQuota = await requestReset(activeEmail);
      assert.equal(overQuota.status, 200);
      assert.deepEqual(overQuota.jsonBody, expectedBody);
      assert.equal(transportCalls.length, 7);
      assert.equal(transportCalls[6], undefined);
      assert.equal(sent.length, 3);
      const tokenAfterQuota = await database("token_redefinicao_senha").where({ id_usuario: activeId }).first();
      assert.equal(tokenAfterQuota.id_token, currentToken.id_token);
      assert.equal(tokenAfterQuota.hash_token_sha256.equals(currentToken.hash_token_sha256), true);
      let quota = await database("usuario").where({ id_usuario: activeId }).first(
        "contador_pedidos_redefinicao", "inicio_janela_redefinicao"
      );
      assert.equal(quota.contador_pedidos_redefinicao, 3);
      assert.ok(quota.inicio_janela_redefinicao);

      await database("usuario").where({ id_usuario: activeId }).update({
        contador_pedidos_redefinicao: 3,
        inicio_janela_redefinicao: database.raw("clock_timestamp() - INTERVAL '24 hours'")
      });
      const afterWindow = await requestReset(activeEmail);
      assert.deepEqual(afterWindow.jsonBody, expectedBody);
      assert.equal(transportCalls.length, 8);
      assert.equal(sent.length, 4);
      quota = await database("usuario").where({ id_usuario: activeId }).first(
        "contador_pedidos_redefinicao", "inicio_janela_redefinicao"
      );
      assert.equal(quota.contador_pedidos_redefinicao, 1);
      assert.ok(new Date(quota.inicio_janela_redefinicao).getTime() > Date.now() - 10_000);

      const failureEmail = newIdentity("reset-delivery-failure");
      const failureId = await insertStudent(database, failureEmail);
      await database("usuario").where({ id_usuario: failureId }).update({ hash_senha: passwordHash });
      let failedAttempts = 0;
      const failedHandlers = accountLifecycleHandlers(database, {
        async send() {
          failedAttempts += 1;
          throw new Error("synthetic-provider-secret");
        }
      });
      const failedLogs = [];
      const failedResponse = await failedHandlers.requestPasswordReset(accountRequest("POST", {
        body: { email: failureEmail }
      }), { invocationId: "synthetic-failure-invocation", log(message) { failedLogs.push(message); } });
      assert.equal(failedResponse.status, 200);
      assert.deepEqual(failedResponse.jsonBody, expectedBody);
      assert.equal(failedAttempts, 1);
      assert.equal(JSON.stringify(failedLogs).includes("synthetic-provider-secret"), false);
      const failedQuota = await database("usuario").where({ id_usuario: failureId }).first(
        "contador_pedidos_redefinicao"
      );
      assert.equal(failedQuota.contador_pedidos_redefinicao, 1);

      const publicAndLogged = JSON.stringify([
        unknown, pending, deleted, ...activeResponses, overQuota, afterWindow, failedResponse, logs, failedLogs
      ]);
      for (const secret of [activeEmail, pendingEmail, deletedEmail, failureEmail, firstToken, thirdToken, passwordHash,
        "synthetic-provider-secret"]) {
        assert.equal(publicAndLogged.includes(secret), false);
      }
    });

    await t.test("separate connections reserve no more than three concurrent reset requests", async () => {
      const email = newIdentity("concurrent-reset-quota");
      const userId = await insertStudent(database, email);
      await database("usuario").where({ id_usuario: userId }).update({ hash_senha: await syntheticPasswordHash() });
      const sent = [];
      let transportCalls = 0;
      const transport = {
        async send(message) {
          transportCalls += 1;
          if (message) sent.push(message);
        }
      };
      const handlers = [accountLifecycleHandlers(database, transport), accountLifecycleHandlers(secondConnection, transport)];
      const context = { invocationId: "synthetic-concurrent-reset", log() {} };
      const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => handlers[index % 2]
        .requestPasswordReset(accountRequest("POST", { body: { email } }), context)));

      assert.ok(responses.every((response) => response.status === 200));
      assert.ok(responses.every((response) => response.jsonBody.message === responses[0].jsonBody.message));
      assert.equal(transportCalls, 8);
      assert.equal(sent.length, 3);
      const account = await database("usuario").where({ id_usuario: userId }).first(
        "contador_pedidos_redefinicao", "inicio_janela_redefinicao"
      );
      assert.equal(account.contador_pedidos_redefinicao, 3);
      assert.ok(account.inicio_janela_redefinicao);
      const tokenCount = await database("token_redefinicao_senha")
        .where({ id_usuario: userId }).count({ count: "*" }).first();
      assert.equal(Number(tokenCount.count), 1);
      assert.equal(JSON.stringify(responses).includes(email), false);
    });

    await t.test("activation tokens are hash-only, expire, supersede, and consume once under concurrency", async () => {
      const pendingId = await insertPendingStudent(database);
      const first = await issueActivationToken(database, String(pendingId));
      const firstPersisted = await database("token_ativacao").where({ id_usuario: pendingId }).first();
      const second = await issueActivationToken(database, String(pendingId));
      assert.equal(first.status, "issued");
      assert.equal(second.status, "issued");
      assert.notEqual(first.token, second.token);
      const persisted = await database("token_ativacao").where({ id_usuario: pendingId }).first();
      assert.equal(persisted.hash_token_sha256.equals(hashOpaqueToken(second.token)), true);
      assert.notEqual(persisted.id_token, firstPersisted.id_token);
      const activationLifetime = new Date(persisted.expira_em).getTime() - Date.now();
      assert.ok(activationLifetime <= 72 * 60 * 60 * 1000);
      assert.ok(activationLifetime > 72 * 60 * 60 * 1000 - 10_000);
      assert.equal(await activateAccount(database, first.token, "synthetic-activation-password-123"), false);

      const activationPasswordA = "synthetic-activation-password-a-123";
      const activationPasswordB = "synthetic-activation-password-b-123";
      const activationResults = await Promise.all([
        activateAccount(database, second.token, activationPasswordA),
        activateAccount(database, second.token, activationPasswordB)
      ]);
      assert.equal(activationResults.filter(Boolean).length, 1);
      const activated = await database("usuario").where({ id_usuario: pendingId }).first(
        "ativado_em", "hash_senha", "excluido_em"
      );
      assert.ok(activated.ativado_em);
      assert.equal(activated.excluido_em, null);
      assert.equal(await argon2.verify(activated.hash_senha, activationPasswordA)
        || await argon2.verify(activated.hash_senha, activationPasswordB), true);
      assert.equal(await activateAccount(database, second.token, activationPasswordA), false);
      assert.equal(await database("token_ativacao").where({ id_usuario: pendingId }).first(), undefined);

      const expiredId = await insertPendingStudent(database);
      const expired = await issueActivationToken(database, String(expiredId));
      assert.equal(expired.status, "issued");
      const expiredActivationRow = await database("token_ativacao").where({ id_usuario: expiredId }).first();
      await database("token_ativacao").where({ id_usuario: expiredId }).update({
        expira_em: database.raw("clock_timestamp() - INTERVAL '1 second'")
      });
      assert.equal(await activateAccount(database, expired.token, "synthetic-expired-activation-password"), false);
      const stillPending = await database("usuario").where({ id_usuario: expiredId }).first("ativado_em");
      assert.equal(stillPending.ativado_em, null);

      const handlerId = await insertPendingStudent(database);
      const handlerIssue = await issueActivationToken(database, String(handlerId));
      const handlerPassword = "synthetic-http-activation-password-123";
      const expiryLogs = [];
      const expiryHandlers = accountLifecycleHandlers(database, { async send() {} });
      const expiredResponse = await expiryHandlers.activate(accountRequest("POST", {
        body: { token: expired.token, password: "synthetic-expired-activation-password" }
      }), { invocationId: "synthetic-expired-activation", log(message) { expiryLogs.push(message); } });
      assert.equal(expiredResponse.status, 400);
      assert.equal(expiredResponse.jsonBody.code, "ACTIVATION_TOKEN_INVALID");
      assert.equal(JSON.stringify(expiredResponse).includes(expired.token), false);
      assert.equal(JSON.stringify(expiredResponse).includes(expiredActivationRow.hash_token_sha256.toString()), false);
      assert.equal(JSON.stringify(expiryLogs).includes(expired.token), false);
      assert.equal(JSON.stringify(expiryLogs).includes(expiredActivationRow.hash_token_sha256.toString()), false);
      const handlers = accountLifecycleHandlers(database, { async send() {} });
      const activationLogs = [];
      const response = await handlers.activate(accountRequest("POST", {
        body: { token: handlerIssue.token, password: handlerPassword }
      }), { invocationId: "synthetic-activation", log(message) { activationLogs.push(message); } });
      assert.equal(response.status, 200);
      const persistedHandlerAccount = await database("usuario").where({ id_usuario: handlerId }).first("hash_senha");
      for (const secret of [handlerIssue.token, handlerPassword, persistedHandlerAccount.hash_senha, second.recipient]) {
        assert.equal(JSON.stringify(response).includes(secret), false);
        assert.equal(JSON.stringify(activationLogs).includes(secret), false);
      }
    });

    await t.test("password reset supersedes tokens, revokes sessions, resets quota, and consumes once concurrently", async () => {
      const email = newIdentity("reset-token-lifecycle");
      const userId = await insertStudent(database, email);
      const oldPassword = "synthetic-old-password-123";
      const oldHash = await syntheticPasswordHash(oldPassword);
      await database("usuario").where({ id_usuario: userId }).update({
        hash_senha: oldHash,
        contador_pedidos_redefinicao: 1,
        inicio_janela_redefinicao: database.raw("clock_timestamp() - INTERVAL '1 hour'")
      });
      const session = await insertAuthSession(database, userId);
      const outbox = [];
      const handlers = accountLifecycleHandlers(database, { async send(message) { outbox.push(message); } });
      const resetLogs = [];
      const context = { invocationId: "synthetic-reset-complete", log(message) { resetLogs.push(message); } };
      await handlers.requestPasswordReset(accountRequest("POST", { body: { email } }), context);
      const firstToken = new URL(outbox[0].url).searchParams.get("token");
      const firstPersisted = await database("token_redefinicao_senha").where({ id_usuario: userId }).first();
      await handlers.requestPasswordReset(accountRequest("POST", { body: { email } }), context);
      const secondToken = new URL(outbox[1].url).searchParams.get("token");
      assert.notEqual(firstToken, secondToken);
      const secondPersisted = await database("token_redefinicao_senha").where({ id_usuario: userId }).first();
      assert.notEqual(secondPersisted.id_token, firstPersisted.id_token);
      assert.equal(await completePasswordReset(database, firstToken, "synthetic-stale-reset-password"), false);
      const staleResponse = await handlers.completePasswordReset(accountRequest("POST", {
        body: { token: firstToken, password: "synthetic-stale-reset-password" }
      }), context);
      assert.equal(staleResponse.status, 400);
      assert.equal(staleResponse.jsonBody.code, "PASSWORD_RESET_TOKEN_INVALID");

      const newPassword = "synthetic-new-password-123";
      const response = await handlers.completePasswordReset(accountRequest("POST", {
        body: { token: secondToken, password: newPassword }
      }), context);
      assert.equal(response.status, 200);
      const updated = await database("usuario").where({ id_usuario: userId }).first(
        "hash_senha", "contador_pedidos_redefinicao", "inicio_janela_redefinicao"
      );
      assert.equal(await argon2.verify(updated.hash_senha, newPassword), true);
      assert.equal(updated.contador_pedidos_redefinicao, 0);
      assert.equal(updated.inicio_janela_redefinicao, null);
      const revokedSession = await database("sessao").where({ hash_token_sha256: hashOpaqueToken(session) }).first();
      assert.ok(revokedSession.revogada_em);
      assert.equal(await completePasswordReset(database, secondToken, "synthetic-repeat-reset-password"), false);
      const replayResponse = await handlers.completePasswordReset(accountRequest("POST", {
        body: { token: secondToken, password: "synthetic-repeat-reset-password" }
      }), context);
      assert.deepEqual(replayResponse.jsonBody, staleResponse.jsonBody);
      for (const secret of [email, firstToken, secondToken, newPassword, updated.hash_senha, session]) {
        assert.equal(JSON.stringify(response).includes(secret), false);
        assert.equal(JSON.stringify(resetLogs).includes(secret), false);
      }

      const concurrentEmail = newIdentity("concurrent-reset-consume");
      const concurrentId = await insertStudent(database, concurrentEmail);
      await database("usuario").where({ id_usuario: concurrentId }).update({ hash_senha: oldHash });
      await handlers.requestPasswordReset(accountRequest("POST", { body: { email: concurrentEmail } }), context);
      const concurrentToken = new URL(outbox.at(-1).url).searchParams.get("token");
      const passwordA = "synthetic-concurrent-reset-password-a";
      const passwordB = "synthetic-concurrent-reset-password-b";
      const outcomes = await Promise.all([
        completePasswordReset(database, concurrentToken, passwordA),
        completePasswordReset(secondConnection, concurrentToken, passwordB)
      ]);
      assert.equal(outcomes.filter(Boolean).length, 1);
      const finalHash = (await database("usuario").where({ id_usuario: concurrentId }).first("hash_senha")).hash_senha;
      assert.equal(await argon2.verify(finalHash, passwordA) || await argon2.verify(finalHash, passwordB), true);

      const expiredEmail = newIdentity("expired-reset-token");
      const expiredId = await insertStudent(database, expiredEmail);
      await database("usuario").where({ id_usuario: expiredId }).update({ hash_senha: oldHash });
      await handlers.requestPasswordReset(accountRequest("POST", { body: { email: expiredEmail } }), context);
      const expiredToken = new URL(outbox.at(-1).url).searchParams.get("token");
      await database("token_redefinicao_senha").where({ id_usuario: expiredId }).update({
        expira_em: database.raw("clock_timestamp() - INTERVAL '1 second'")
      });
      assert.equal(await completePasswordReset(database, expiredToken, "synthetic-expired-reset-password"), false);
      const expiredResponse = await handlers.completePasswordReset(accountRequest("POST", {
        body: { token: expiredToken, password: "synthetic-expired-reset-password" }
      }), context);
      assert.deepEqual(expiredResponse.jsonBody, staleResponse.jsonBody);
      assert.ok(await database("token_redefinicao_senha").where({ id_usuario: expiredId }).first());
      const validCleanupId = await insertPendingStudent(database);
      const validCleanupToken = await issueActivationToken(database, String(validCleanupId));
      assert.equal(validCleanupToken.status, "issued");
      await deleteExpiredLifecycleTokens(database);
      assert.equal(await database("token_redefinicao_senha").where({ id_usuario: expiredId }).first(), undefined);
      assert.ok(await database("token_ativacao").where({ id_usuario: validCleanupId }).first());
    });

    await t.test("administrative account creation and updates work while retired DELETEs are static 404s", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("account-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const sent = [];
      const handlers = adminAccountHandlers(database, { async send(message) { sent.push(message); } });
      const logs = [];
      const context = { invocationId: "synthetic-account-management", log(message) { logs.push(message); } };

      const studentEmail = newIdentity("managed-student");
      const created = await handlers.createStudent(accountRequest("POST", {
        cookie: adminToken,
        body: {
          name: "Synthetic Managed Student",
          email: studentEmail,
          guardianPhone: "+5511999990000"
        }
      }), context);
      assert.equal(created.status, 201);
      assert.deepEqual(created.jsonBody, { activationEmailStatus: "sent" });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].kind, "activation");
      assert.equal(sent[0].recipient, studentEmail);
      const student = await database("usuario").where({
        tipo_perfil: "aluno", email_institucional: studentEmail
      }).first();
      assert.ok(student);
      assert.equal(student.ativado_em, null);
      assert.ok(await database("aluno").where({ id_usuario: student.id_usuario }).first());

      const detail = await handlers.getStudent(accountRequest("GET", {
        cookie: adminToken, params: { studentId: String(student.id_usuario) }
      }), context);
      assert.equal(detail.status, 200);
      assert.equal(detail.jsonBody.guardianPhone, "+5511999990000");
      const updated = await handlers.updateStudent(accountRequest("PATCH", {
        cookie: adminToken,
        params: { studentId: String(student.id_usuario) },
        body: { name: "Synthetic Updated Student", contactPhone: "+5511988880000", guardianPhone: "+5511977770000" }
      }), context);
      assert.equal(updated.status, 200);
      assert.equal(updated.jsonBody.name, "Synthetic Updated Student");
      assert.equal(updated.jsonBody.contactPhone, "+5511988880000");
      assert.equal(updated.jsonBody.guardianPhone, "+5511977770000");

      const teacherId = await insertProfessor(database);
      const accountEventsBeforeDeletes = [...logs];
      const beforeUsers = await database("usuario").select("id_usuario", "tipo_perfil", "excluido_em").orderBy("id_usuario");
      const beforeSessions = await database("sessao").select("id_sessao", "id_usuario", "revogada_em").orderBy("id_sessao");
      const beforeEnrollments = await database("matricula").count({ count: "id_matricula" }).first();
      const queries = [];
      const listener = (query) => queries.push(query.sql);
      database.on("query", listener);
      let responses;
      try {
        responses = await Promise.all([
          handlers.deleteStudent(accountRequest("DELETE", {
            origin: "https://attacker.example.test", params: { studentId: String(student.id_usuario) }
          }), context),
          handlers.deleteStudent(accountRequest("DELETE", {
            params: { studentId: "9223372036854775807" }
          }), context),
          handlers.deleteTeacher(accountRequest("DELETE", {
            params: { teacherId: String(teacherId) }
          }), context),
          handlers.deleteTeacher(accountRequest("DELETE", {
            params: { teacherId: "0" }
          }), context),
          handlers.deleteAdministrator(accountRequest("DELETE", {
            params: { administratorId: String(administrator.id) }
          }), context),
          handlers.deleteAdministrator(accountRequest("DELETE", {
            params: { administratorId: "999999" }
          }), context)
        ]);
      } finally {
        database.removeListener("query", listener);
      }
      for (const response of responses) assertProblemResponse(response, 404, "RESOURCE_NOT_FOUND");
      for (const response of responses.slice(1)) assert.deepEqual(response, responses[0]);
      assert.deepEqual(queries, []);
      assert.deepEqual(await database("usuario").select("id_usuario", "tipo_perfil", "excluido_em").orderBy("id_usuario"), beforeUsers);
      assert.deepEqual(await database("sessao").select("id_sessao", "id_usuario", "revogada_em").orderBy("id_sessao"), beforeSessions);
      assert.equal(Number((await database("matricula").count({ count: "id_matricula" }).first()).count),
        Number(beforeEnrollments.count));
      assert.deepEqual(logs, accountEventsBeforeDeletes);
    });
    await t.test("teacher associations are authorized, scoped, idempotent, and preserve teacher accounts", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("association-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const classId = await insertClass(database, { series: 1, schoolYear: 2091 });
      const otherClassId = await insertClass(database, { series: 2, schoolYear: 2091 });
      const subjectId = (await database("materia").insert({ nome: newIdentity("association-subject") })
        .returning("id_materia"))[0].id_materia;
      const offerId = (await database("turma_disciplina").insert({
        id_turma: classId,
        id_materia: subjectId
      }).returning("id_turma_disciplina"))[0].id_turma_disciplina;
      const firstTeacherId = await insertProfessor(database, newIdentity("association-first-teacher"));
      const secondTeacherId = await insertProfessor(database, newIdentity("association-second-teacher"));
      const pendingTeacherId = await database.transaction(async (transaction) => {
        const id = await insertUser(transaction, {
          profile: "professor",
          email: newIdentity("association-pending-teacher"),
          activated: false
        });
        await transaction("professor").insert({ id_usuario: id });
        return id;
      });
      const handlers = adminAccountHandlers(database, { async send() {} });
      const context = { invocationId: "synthetic-association", log(message) { logs.push(message); } };
      const logs = [];
      const route = (teacherId) => ({
        classId: String(classId), subjectId: String(subjectId), teacherId: String(teacherId)
      });

      const empty = await handlers.listClassSubjectTeachers(accountRequest("GET", {
        cookie: adminToken,
        params: { classId: String(classId), subjectId: String(subjectId) }
      }), context);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.jsonBody, { items: [] });

      const nonAdminId = await insertStudent(database, newIdentity("association-non-admin"));
      const nonAdminToken = await insertAuthSession(database, nonAdminId);
      const associationQueries = [];
      const queryListener = ({ sql }) => associationQueries.push(sql.toLowerCase());
      database.on("query", queryListener);
      let hiddenForStudent;
      try {
        hiddenForStudent = await handlers.listClassSubjectTeachers(accountRequest("GET", {
          cookie: nonAdminToken,
          params: { classId: String(classId), subjectId: String(subjectId) }
        }), context);
      } finally {
        database.removeListener("query", queryListener);
      }
      assertProblemResponse(hiddenForStudent, 404, "RESOURCE_NOT_FOUND");
      assert.equal(associationQueries.some((sql) => sql.includes("turma_disciplina_professor")), false);

      const mismatchedOffer = await handlers.listClassSubjectTeachers(accountRequest("GET", {
        cookie: adminToken,
        params: { classId: String(otherClassId), subjectId: String(subjectId) }
      }), context);
      assertProblemResponse(mismatchedOffer, 404, "RESOURCE_NOT_FOUND");
      const missingOffer = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken,
        params: { ...route(firstTeacherId), classId: "9223372036854775807" }
      }), context);
      assertProblemResponse(missingOffer, 404, "RESOURCE_NOT_FOUND");
      const incompatibleAdd = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken,
        params: { ...route(firstTeacherId), classId: String(otherClassId) }
      }), context);
      assertProblemResponse(incompatibleAdd, 404, "RESOURCE_NOT_FOUND");
      const incompatibleRemove = await handlers.removeClassSubjectTeacher(accountRequest("DELETE", {
        cookie: adminToken,
        params: { ...route(firstTeacherId), subjectId: "9223372036854775807" }
      }), context);
      assertProblemResponse(incompatibleRemove, 404, "RESOURCE_NOT_FOUND");
      const missingTeacher = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken,
        params: { ...route("9223372036854775807") }
      }), context);
      assertProblemResponse(missingTeacher, 404, "RESOURCE_NOT_FOUND");
      const studentAsTeacher = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken,
        params: route(nonAdminId)
      }), context);
      assertProblemResponse(studentAsTeacher, 404, "RESOURCE_NOT_FOUND");

      const firstAdd = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken, params: route(firstTeacherId)
      }), context);
      const repeatedAdd = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken, params: route(firstTeacherId)
      }), context);
      const secondAdd = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken, params: route(secondTeacherId)
      }), context);
      const pendingAdd = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken, params: route(pendingTeacherId)
      }), context);
      for (const response of [firstAdd, repeatedAdd, secondAdd, pendingAdd]) assert.equal(response.status, 204);

      const multiple = await handlers.listClassSubjectTeachers(accountRequest("GET", {
        cookie: adminToken,
        params: { classId: String(classId), subjectId: String(subjectId) }
      }), context);
      assert.equal(multiple.status, 200);
      assert.deepEqual(multiple.jsonBody.items.map((item) => item.teacherId).sort((a, b) => Number(a) - Number(b)),
        [String(firstTeacherId), String(secondTeacherId), String(pendingTeacherId)].sort((a, b) => Number(a) - Number(b)));
      assert.deepEqual(Object.keys(multiple.jsonBody.items[0]).sort(), [
        "activationStatus", "email", "name", "teacherId"
      ]);
      assert.equal(multiple.jsonBody.items.find((item) => item.teacherId === String(pendingTeacherId)).activationStatus,
        "pending");
      assert.equal(await database("turma_disciplina_professor").where({ id_turma_disciplina: offerId })
        .count().first().then((row) => Number(row.count)), 3);

      const linkedDelete = await handlers.deleteTeacher(accountRequest("DELETE", {
        cookie: adminToken, params: { teacherId: String(firstTeacherId) }
      }), context);
      assertProblemResponse(linkedDelete, 404, "RESOURCE_NOT_FOUND");

      const removeOne = await handlers.removeClassSubjectTeacher(accountRequest("DELETE", {
        cookie: adminToken, params: route(firstTeacherId)
      }), context);
      const repeatRemove = await handlers.removeClassSubjectTeacher(accountRequest("DELETE", {
        cookie: adminToken, params: route(firstTeacherId)
      }), context);
      assert.equal(removeOne.status, 204);
      assert.equal(repeatRemove.status, 204);
      assert.equal(await database("turma_disciplina_professor").where({
        id_turma_disciplina: offerId,
        id_usuario_professor: firstTeacherId
      }).first(), undefined);
      assert.ok(await database("professor").where({ id_usuario: firstTeacherId }).first());
      assertProblemResponse(await handlers.deleteTeacher(accountRequest("DELETE", {
        cookie: adminToken, params: { teacherId: String(firstTeacherId) }
      }), context), 404, "RESOURCE_NOT_FOUND");

      const deletedTeacherAdd = await handlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken, params: route(firstTeacherId)
      }), context);
      assert.equal(deletedTeacherAdd.status, 204);
      const remaining = await handlers.listClassSubjectTeachers(accountRequest("GET", {
        cookie: adminToken,
        params: { classId: String(classId), subjectId: String(subjectId) }
      }), context);
      assert.deepEqual(remaining.jsonBody.items.map((item) => item.teacherId).sort((a, b) => Number(a) - Number(b)),
        [String(firstTeacherId), String(secondTeacherId), String(pendingTeacherId)].sort((a, b) => Number(a) - Number(b)));

      const logsParsed = logs.map((line) => JSON.parse(line));
      assert.ok(logsParsed.some((entry) => entry.event === "admin_teacher_association_add"));
      assert.ok(logsParsed.some((entry) => entry.event === "admin_teacher_association_remove"));
      for (const entry of logsParsed) {
        assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "event", "invocationId", "result"]);
        assert.equal(JSON.stringify(entry).includes("association-first-teacher"), false);
      }

      await expectPgCode(database("turma_disciplina_professor").insert({
        id_turma_disciplina: offerId,
        id_usuario_professor: "9223372036854775807"
      }), "23503");
    });

    await t.test("revocation wins over a teacher association waiting on the affected identity", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("association-race-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const classId = await insertClass(database, { series: 3, schoolYear: 2092 });
      const subjectId = (await database("materia").insert({ nome: newIdentity("association-race-subject") })
        .returning("id_materia"))[0].id_materia;
      await database("turma_disciplina").insert({ id_turma: classId, id_materia: subjectId });
      const teacherId = await insertProfessor(database, newIdentity("association-race-teacher"));
      const teacherToken = await insertAuthSession(database, teacherId);
      const testConnection = connectionFromEnvironment(generatedDatabase);
      const associationApplication = `nm-association-put-${process.pid}`;
      const associationConnection = makeKnex({ ...testConnection, application_name: associationApplication }, {
        min: 1, max: 1, acquireTimeoutMillis: 5000
      });
      const blocker = await database.transaction();
      let addPromise;

      try {
        await associationConnection.raw("SELECT 1");
        await blocker("usuario").select("id_usuario").where({ id_usuario: teacherId }).forUpdate().first();

        const associationHandlers = adminAccountHandlers(associationConnection, { async send() {} });
        addPromise = associationHandlers.addClassSubjectTeacher(accountRequest("PUT", {
          cookie: adminToken,
          params: { classId: String(classId), subjectId: String(subjectId), teacherId: String(teacherId) }
        }), {});
        await waitForLockWait(database, associationApplication);

        await database("sessao")
          .where({ hash_token_sha256: hashOpaqueToken(adminToken) })
          .update({ revogada_em: database.raw("clock_timestamp()") });
        await blocker.commit();
        const associated = await addPromise;
        assertProblemResponse(associated, 401, "AUTHENTICATION_REQUIRED");
        assert.equal(await database("turma_disciplina_professor").where({
          id_usuario_professor: teacherId
        }).first(), undefined);
        assert.equal((await database("usuario").where({ id_usuario: teacherId }).first()).excluido_em, null);
        assert.equal((await database("sessao").where({ hash_token_sha256: hashOpaqueToken(teacherToken) }).first())
          .revogada_em, null);
      } finally {
        if (!blocker.isCompleted()) await blocker.rollback();
        await Promise.allSettled([addPromise].filter(Boolean));
        await associationConnection.destroy();
      }
    });

    await t.test("administrative account email changes are constrained by the shared address uniqueness rules", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("email-uniqueness-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const currentEmail = newIdentity("email-uniqueness-current");
      const targetId = await insertStudent(database, currentEmail);
      const desiredEmail = newIdentity("email-uniqueness-conflict");
      await insertProfessor(database, desiredEmail);
      const handlers = adminAccountHandlers(database, { async send() {} });

      const response = await handlers.updateStudent(accountRequest("PATCH", {
        cookie: adminToken,
        params: { studentId: String(targetId) },
        body: { email: desiredEmail, currentPassword: administrator.password }
      }), {});
      assertProblemResponse(response, 409, "EMAIL_ALREADY_IN_USE");
      const target = await database("usuario").where({ id_usuario: targetId }).first();
      assert.equal(target.email_institucional, currentEmail);
      assert.equal(target.email_pendente, null);
      assert.notEqual(target.ativado_em, null);
    });

    await t.test("email change serializes activation and invalidates a pre-change token atomically", async () => {
      const oldEmail = newIdentity("activation-race-current");
      const pendingEmail = newIdentity("activation-race-pending");
      const userId = await insertPendingStudent(database, oldEmail);
      const oldActivation = await issueActivationToken(database, String(userId));
      assert.equal(oldActivation.status, "issued");

      const updateApplication = `nm-email-update-${process.pid}`;
      const activationApplication = `nm-activation-${process.pid}`;
      const testConnection = connectionFromEnvironment(generatedDatabase);
      const updateConnection = makeKnex({ ...testConnection, application_name: updateApplication }, {
        min: 1,
        max: 1,
        acquireTimeoutMillis: 5000
      });
      const activationConnection = makeKnex({ ...testConnection, application_name: activationApplication }, {
        min: 1,
        max: 1,
        acquireTimeoutMillis: 5000
      });
      const blocker = await database.transaction();
      let updatePromise;
      let activationPromise;

      try {
        await updateConnection.raw("SELECT 1");
        await activationConnection.raw("SELECT 1");
        await blocker("usuario").select("id_usuario").where({ id_usuario: userId }).forUpdate().first();

        updatePromise = updateAccount(
          updateConnection,
          "aluno",
          String(userId),
          oldEmail,
          { email: pendingEmail }
        );
        await waitForLockWait(database, updateApplication);

        activationPromise = activateAccount(
          activationConnection,
          oldActivation.token,
          "synthetic-activation-race-password"
        );
        await waitForLockWait(database, activationApplication);

        await blocker.commit();
        const [updated, activatedWithOldToken] = await Promise.all([updatePromise, activationPromise]);
        assert.equal(updated.status, "updated");
        assert.equal(updated.previousEmail, oldEmail);
        assert.equal(activatedWithOldToken, false);

        const account = await database("usuario").where({ id_usuario: userId }).first();
        assert.equal(account.email_institucional, oldEmail);
        assert.equal(account.email_pendente, pendingEmail);
        assert.equal(account.ativado_em, null);
        assert.equal(await database("token_ativacao").where({ id_usuario: userId }).count().first()
          .then((row) => Number(row.count)), 0);

        const replacement = await issueActivationToken(database, String(userId));
        assert.equal(replacement.status, "issued");
        assert.equal(replacement.recipient, pendingEmail);
        const replacementRow = await database("token_ativacao").where({ id_usuario: userId }).first();
        assert.equal(replacementRow.hash_token_sha256.equals(hashOpaqueToken(replacement.token)), true);
      } finally {
        if (!blocker.isCompleted()) await blocker.rollback();
        await Promise.allSettled([updatePromise, activationPromise].filter(Boolean));
        await Promise.all([updateConnection.destroy(), activationConnection.destroy()]);
      }
    });

    await t.test("an administrator cannot change their own email or lose administrative access", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("self-email-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const activationToken = randomBytes(32).toString("base64url");
      const activationHash = hashOpaqueToken(activationToken);
      await database("token_ativacao").insert({
        id_usuario: administrator.id,
        hash_token_sha256: activationHash,
        expira_em: database.raw("clock_timestamp() + INTERVAL '1 hour'")
      });
      const beforeAccount = await database("usuario")
        .select("email_institucional", "email_pendente", "ativado_em", "hash_senha")
        .where({ id_usuario: administrator.id })
        .first();
      const beforeTokens = await database("token_ativacao")
        .select("hash_token_sha256", "expira_em")
        .where({ id_usuario: administrator.id });
      const handlers = adminAccountHandlers(database, { async send() { assert.fail("Self-email change must not send mail."); } });

      const response = await handlers.updateAdministrator(accountRequest("PATCH", {
        cookie: adminToken,
        params: { administratorId: String(administrator.id) },
        body: {
          email: newIdentity("self-email-rejected"),
          currentPassword: administrator.password
        }
      }), {});

      assertProblemResponse(response, 422, "VALIDATION_ERROR");
      assert.equal(response.jsonBody.errors[0].code, "INVALID_VALUE");
      assert.deepEqual(response.jsonBody.errors[0].source, { in: "body", pointer: "/email" });
      for (const secret of [administrator.email, administrator.password]) {
        assert.equal(JSON.stringify(response).includes(secret), false);
      }
      const afterAccount = await database("usuario")
        .select("email_institucional", "email_pendente", "ativado_em", "hash_senha")
        .where({ id_usuario: administrator.id })
        .first();
      const afterTokens = await database("token_ativacao")
        .select("hash_token_sha256", "expira_em")
        .where({ id_usuario: administrator.id });
      assert.deepEqual(afterAccount, beforeAccount);
      assert.deepEqual(afterTokens, beforeTokens);
      const current = await authHandlers(database).currentSession(authRequest("GET", { cookie: adminToken }), {});
      assert.equal(current.status, 200);
      assert.equal(current.jsonBody.user.id, String(administrator.id));
      assert.equal((await database("sessao")
        .where({ hash_token_sha256: createHash("sha256").update(adminToken).digest() })
        .first()).revogada_em, null);
    });

    await t.test("administrative mutations and reauthentication emit minimal events, tolerating logger failures", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("event-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const studentEmail = newIdentity("event-student");
      const studentId = await insertStudent(database, studentEmail);
      const teacherEmail = newIdentity("event-teacher");
      const teacherId = await insertProfessor(database, teacherEmail);
      const newEmail = newIdentity("event-pending-email");
      const messages = [];
      const privateTransportFailure = "synthetic-private-provider-exception";
      const handlers = adminAccountHandlers(database, {
        async send(message) {
          messages.push(message);
          throw new Error(privateTransportFailure);
        }
      });
      const logMessages = [];
      const context = {
        invocationId: "synthetic-admin-account-invocation",
        log(message) { logMessages.push(message); }
      };

      const created = await handlers.createStudent(accountRequest("POST", {
        cookie: adminToken,
        body: { name: "Synthetic Event Student", email: newIdentity("event-created-student"), guardianPhone: "+5511999990000" }
      }), context);
      assert.equal(created.status, 201);
      assert.deepEqual(created.jsonBody, { activationEmailStatus: "failed" });

      const updated = await handlers.updateStudent(accountRequest("PATCH", {
        cookie: adminToken,
        params: { studentId: String(studentId) },
        body: { email: newEmail, currentPassword: administrator.password }
      }), context);
      assert.equal(updated.status, 200);

      const rejectedReauthentication = await handlers.updateTeacher(accountRequest("PATCH", {
        cookie: adminToken,
        params: { teacherId: String(teacherId) },
        body: { email: newIdentity("event-rejected-email"), currentPassword: "synthetic-invalid-password" }
      }), context);
      assertProblemResponse(rejectedReauthentication, 401, "AUTHENTICATION_FAILED");

      const retiredDelete = await handlers.deleteTeacher(accountRequest("DELETE", {
        cookie: adminToken,
        params: { teacherId: String(teacherId) }
      }), context);
      assertProblemResponse(retiredDelete, 404, "RESOURCE_NOT_FOUND");
      const missingRetiredDelete = await handlers.deleteTeacher(accountRequest("DELETE", {
        cookie: adminToken,
        params: { teacherId: "9223372036854775807" }
      }), context);
      assert.deepEqual(missingRetiredDelete, retiredDelete);

      const loggerFailure = await handlers.updateStudent(accountRequest("PATCH", {
        cookie: adminToken,
        params: { studentId: String(studentId) },
        body: { name: "Synthetic Logger Failure Student" }
      }), {
        invocationId: "synthetic-throwing-logger",
        log() { throw new Error("synthetic-private-log-sink-failure"); }
      });
      assert.equal(loggerFailure.status, 200);

      const records = logMessages.map((message) => JSON.parse(message));
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
        assert.equal(typeof record.event, "string");
        assert.equal(record.invocationId, context.invocationId);
        assert.equal(typeof record.result, "string");
        assert.equal(typeof record.durationMs, "number");
        assert.ok(record.durationMs >= 0);
      }
      assert.ok(records.some((record) => record.event === "admin_account_create" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_account_update" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_account_update" && record.result === "rejected"));
      assert.equal(records.some((record) => record.event === "admin_account_delete"), false);
      assert.ok(records.some((record) => record.event === "admin_account_reauthentication" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_account_reauthentication" && record.result === "rejected"));

      const logSensitiveValues = [
        administrator.email,
        administrator.password,
        administrator.passwordHash,
        adminToken,
        studentEmail,
        teacherEmail,
        newEmail,
        "+5511999990000",
        privateTransportFailure,
        "synthetic-private-log-sink-failure",
        ...messages.flatMap((message) => [message.recipient, message.url])
      ].filter((value) => typeof value === "string");
      const loggedStringValues = records.flatMap((record) =>
        [record.event, record.invocationId, record.result].filter((value) => typeof value === "string"));
      for (const secret of logSensitiveValues) {
        assert.equal(loggedStringValues.some((value) => value.includes(secret)), false);
      }
      const serializedResponses = JSON.stringify([
        created, updated, rejectedReauthentication, retiredDelete, missingRetiredDelete, loggerFailure
      ]);
      const responseSecrets = [
        administrator.password,
        administrator.passwordHash,
        adminToken,
        privateTransportFailure,
        "synthetic-private-log-sink-failure",
        ...messages.map((message) => message.url)
      ].filter((value) => typeof value === "string");
      for (const secret of responseSecrets) assert.equal(serializedResponses.includes(secret), false);

      const genericErrorResponse = JSON.stringify(rejectedReauthentication);
      for (const privateValue of logSensitiveValues) {
        assert.equal(genericErrorResponse.includes(privateValue), false);
      }
    });

    await t.test("admin activation resend authorizes, rotates hash-only tokens, and sanitizes transport failure", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("resend-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const pendingId = await insertPendingStudent(database);
      const messages = [];
      const logs = [];
      const handlers = accountLifecycleHandlers(database, { async send(message) { messages.push(message); } });
      const context = { invocationId: "synthetic-resend", log(message) { logs.push(message); } };
      const resend = () => handlers.resendActivation(accountRequest("POST", {
        cookie: adminToken,
        params: { userId: String(pendingId) }
      }), context);

      const firstResponse = await resend();
      assert.equal(firstResponse.status, 200);
      assert.deepEqual(firstResponse.jsonBody, { activationEmailStatus: "sent" });
      const firstToken = new URL(messages[0].url).searchParams.get("token");
      const firstPersisted = await database("token_ativacao").where({ id_usuario: pendingId }).first();
      const secondResponse = await resend();
      assert.deepEqual(secondResponse.jsonBody, { activationEmailStatus: "sent" });
      const secondToken = new URL(messages[1].url).searchParams.get("token");
      assert.notEqual(firstToken, secondToken);
      const persisted = await database("token_ativacao").where({ id_usuario: pendingId }).first();
      assert.equal(persisted.hash_token_sha256.equals(hashOpaqueToken(secondToken)), true);
      assert.notEqual(persisted.id_token, firstPersisted.id_token);
      assert.equal(persisted.hash_token_sha256.equals(Buffer.from(secondToken)), false);

      let failedAttempts = 0;
      const failedHandlers = accountLifecycleHandlers(database, {
        async send() {
          failedAttempts += 1;
          throw new Error("synthetic-provider-stack-private");
        }
      });
      const failed = await failedHandlers.resendActivation(accountRequest("POST", {
        cookie: adminToken,
        params: { userId: String(pendingId) }
      }), context);
      assert.equal(failed.status, 200);
      assert.deepEqual(failed.jsonBody, { activationEmailStatus: "failed" });
      assert.equal(failedAttempts, 1);
      assert.equal(JSON.stringify(failed).includes("synthetic-provider-stack-private"), false);
      assert.equal(JSON.stringify(logs).includes("synthetic-provider-stack-private"), false);
      for (const secret of [administrator.email, administrator.password, administrator.passwordHash,
        adminToken, firstToken, secondToken, messages[0].recipient, messages[0].url, messages[1].url]) {
        assert.equal(JSON.stringify(logs).includes(secret), false);
      }
      for (const response of [firstResponse, secondResponse, failed]) {
        for (const secret of [administrator.email, administrator.password, administrator.passwordHash,
          adminToken, firstToken, secondToken, "+5511999990000"]) {
          assert.equal(JSON.stringify(response).includes(secret), false);
        }
      }

      const activated = await handlers.resendActivation(accountRequest("POST", {
        cookie: adminToken,
        params: { userId: String(administrator.id) }
      }), context);
      assert.equal(activated.status, 409);
      assert.equal(activated.jsonBody.code, "ACCOUNT_ALREADY_ACTIVATED");
      const missing = await handlers.resendActivation(accountRequest("POST", {
        cookie: adminToken,
        params: { userId: "9223372036854775807" }
      }), context);
      assert.equal(missing.status, 404);
      assert.equal(missing.jsonBody.code, "RESOURCE_NOT_FOUND");

      const nonAdminId = await insertStudent(database);
      const nonAdminToken = await insertAuthSession(database, nonAdminId);
      const nonAdminResponse = await handlers.resendActivation(accountRequest("POST", {
        cookie: nonAdminToken,
        params: { userId: String(pendingId) }
      }), context);
      assert.equal(nonAdminResponse.status, 404);
      assert.equal(messages.length, 2);
    });

    await t.test("administrative subject CRUD preserves contracts, uniqueness, authorization, and sanitized events", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("subject-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const handlers = adminSubjectHandlers(database);
      const logMessages = [];
      const context = { invocationId: "synthetic-subject-invocation", log(message) { logMessages.push(message); } };
      const prefix = `SubjectCRUD${process.pid}`;
      const originalName = `${prefix} Matemática`;

      const created = await handlers.createSubject(accountRequest("POST", {
        cookie: adminToken,
        body: { name: `  ${originalName}  `, description: "Descrição inicial" }
      }), context);
      assert.equal(created.status, 201);
      assert.match(String(created.jsonBody.subjectId), /^[1-9]\d*$/);
      assert.deepEqual(created.jsonBody, {
        subjectId: created.jsonBody.subjectId,
        name: originalName,
        description: "Descrição inicial"
      });
      const subjectId = created.jsonBody.subjectId;
      assert.equal((await database("materia").where({ id_materia: subjectId }).first()).nome, originalName);

      const second = await handlers.createSubject(accountRequest("POST", {
        cookie: adminToken,
        body: { name: `${prefix} Beta` }
      }), context);
      const third = await handlers.createSubject(accountRequest("POST", {
        cookie: adminToken,
        body: { name: `${prefix} Alpha`, description: "Descrição opcional" }
      }), context);
      assert.equal(second.status, 201);
      assert.equal(second.jsonBody.description, null);
      assert.equal(third.status, 201);

      const firstPage = await handlers.listSubjects(accountRequest("GET", {
        cookie: adminToken,
        query: new URLSearchParams(`search=${encodeURIComponent(prefix.toLowerCase())}&page=1&pageSize=2`)
      }), context);
      assert.equal(firstPage.status, 200);
      assert.deepEqual(firstPage.jsonBody.pagination, { page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
      assert.deepEqual(firstPage.jsonBody.items.map((item) => item.name), [
        `${prefix} Alpha`, `${prefix} Beta`
      ]);
      const secondPage = await handlers.listSubjects(accountRequest("GET", {
        cookie: adminToken,
        query: new URLSearchParams(`search=${encodeURIComponent(prefix)}&page=2&pageSize=2`)
      }), context);
      assert.equal(secondPage.jsonBody.items.length, 1);

      const renamed = `${prefix} Ciências`;
      const updateName = await handlers.updateSubject(accountRequest("PATCH", {
        cookie: adminToken,
        params: { subjectId },
        body: { name: ` ${renamed} ` }
      }), context);
      assert.equal(updateName.status, 200);
      assert.deepEqual(updateName.jsonBody, {
        subjectId,
        name: renamed,
        description: "Descrição inicial"
      });
      const clearDescription = await handlers.updateSubject(accountRequest("PATCH", {
        cookie: adminToken,
        params: { subjectId },
        body: { description: null }
      }), context);
      assert.equal(clearDescription.status, 200);
      assert.equal(clearDescription.jsonBody.name, renamed);
      assert.equal(clearDescription.jsonBody.description, null);

      const duplicateCreate = await handlers.createSubject(accountRequest("POST", {
        cookie: adminToken,
        body: { name: ` ${renamed.toLocaleLowerCase("pt-BR")} ` }
      }), context);
      assertProblemResponse(duplicateCreate, 409, "SUBJECT_ALREADY_EXISTS");
      const duplicateUpdate = await handlers.updateSubject(accountRequest("PATCH", {
        cookie: adminToken,
        params: { subjectId: second.jsonBody.subjectId },
        body: { name: renamed }
      }), context);
      assertProblemResponse(duplicateUpdate, 409, "SUBJECT_ALREADY_EXISTS");
      const unchangedDuplicateTarget = await database("materia")
        .where({ id_materia: second.jsonBody.subjectId }).first("nome");
      assert.equal(unchangedDuplicateTarget.nome, `${prefix} Beta`);

      const classId = await insertClass(database, { series: 1, schoolYear: 2500 + (process.pid % 1000) });
      await database("turma_disciplina").insert({
        id_turma: classId,
        id_materia: second.jsonBody.subjectId
      });
      const linkedDelete = await handlers.deleteSubject(accountRequest("DELETE", {
        cookie: adminToken,
        params: { subjectId: second.jsonBody.subjectId }
      }), context);
      assertProblemResponse(linkedDelete, 409, "SUBJECT_HAS_CLASS_LINKS");
      assert.equal((await database("materia").where({ id_materia: second.jsonBody.subjectId }).first()).excluido_em, null);

      const missingDelete = await handlers.deleteSubject(accountRequest("DELETE", {
        cookie: adminToken,
        params: { subjectId: "9223372036854775807" }
      }), context);
      assertProblemResponse(missingDelete, 404, "SUBJECT_NOT_FOUND");
      const deleted = await handlers.deleteSubject(accountRequest("DELETE", {
        cookie: adminToken,
        params: { subjectId }
      }), context);
      assert.equal(deleted.status, 204);
      assert.ok((await database("materia").where({ id_materia: subjectId }).first()).excluido_em);
      const repeatedDelete = await handlers.deleteSubject(accountRequest("DELETE", {
        cookie: adminToken,
        params: { subjectId }
      }), context);
      assert.equal(repeatedDelete.status, 204);
      const reusedName = await handlers.createSubject(accountRequest("POST", {
        cookie: adminToken,
        body: { name: renamed }
      }), context);
      assert.equal(reusedName.status, 201);
      assert.notEqual(reusedName.jsonBody.subjectId, subjectId);
      const activeAfterReuse = await handlers.listSubjects(accountRequest("GET", {
        cookie: adminToken,
        query: new URLSearchParams(`search=${encodeURIComponent(renamed)}`)
      }), context);
      assert.deepEqual(activeAfterReuse.jsonBody.items.map((item) => item.subjectId), [reusedName.jsonBody.subjectId]);

      const missingUpdate = await handlers.updateSubject(accountRequest("PATCH", {
        cookie: adminToken,
        params: { subjectId: "9223372036854775807" },
        body: { description: null }
      }), context);
      assertProblemResponse(missingUpdate, 404, "SUBJECT_NOT_FOUND");

      const concurrentName = `${prefix} Concurrent`;
      const secondHandlers = adminSubjectHandlers(secondConnection);
      const concurrent = await Promise.all([
        handlers.createSubject(accountRequest("POST", {
          cookie: adminToken, body: { name: concurrentName }
        }), context),
        secondHandlers.createSubject(accountRequest("POST", {
          cookie: adminToken, body: { name: concurrentName }
        }), context)
      ]);
      assert.equal(concurrent.filter((response) => response.status === 201).length, 1);
      assert.equal(concurrent.filter((response) => response.status === 409).length, 1);
      assert.equal(concurrent.find((response) => response.status === 409).jsonBody.code, "SUBJECT_ALREADY_EXISTS");

      const studentId = await insertStudent(database, newIdentity("subject-non-admin"));
      const studentToken = await insertAuthSession(database, studentId);
      const queries = [];
      const queryListener = (query) => queries.push(query.sql);
      database.on("query", queryListener);
      try {
        const denied = await Promise.all([
          handlers.listSubjects(accountRequest("GET", {
            cookie: studentToken, query: new URLSearchParams()
          }), context),
          handlers.createSubject(accountRequest("POST", {
            cookie: studentToken, body: { name: `${prefix} denied` }
          }), context),
          handlers.updateSubject(accountRequest("PATCH", {
            cookie: studentToken,
            params: { subjectId: reusedName.jsonBody.subjectId },
            body: { name: `${prefix} denied update` }
          }), context),
          handlers.deleteSubject(accountRequest("DELETE", {
            cookie: studentToken, params: { subjectId: reusedName.jsonBody.subjectId }
          }), context)
        ]);
        for (const response of denied) assertProblemResponse(response, 404, "RESOURCE_NOT_FOUND");
      } finally {
        database.removeListener("query", queryListener);
      }
      assert.ok(queries.length >= 4);
      assert.equal(queries.some((sql) => /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+"?materia\b/i.test(sql)), false);
      assert.equal(queries.some((sql) => /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+"?turma_disciplina\b/i.test(sql)), false);

      const records = logMessages.map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.event === "admin_subject_create" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_subject_update" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_subject_delete" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_subject_delete" && record.result === "rejected"));
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
      }
      const serializedLogs = JSON.stringify(records);
      for (const sensitiveValue of [prefix, "Descrição inicial", "Descrição opcional", concurrentName]) {
        assert.equal(serializedLogs.includes(sensitiveValue), false);
      }
    });

    await t.test("class lifecycle, ETags, atomic selected closures, and session revocation follow the approved contract", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("class-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const handlers = adminClassHandlers(database);
      const logs = [];
      const context = { invocationId: "synthetic-class-lifecycle", log(message) { logs.push(message); } };
      const dates = await database.raw("SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS calendar_year, CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday, (CURRENT_DATE + 1)::text AS tomorrow");
      const { calendar_year: calendarYear, today, yesterday, tomorrow } = dates.rows[0];
      const latestStoredYear = await database("turma").max({ school_year: "ano_letivo" }).first();
      const currentYear = Math.max(calendarYear, Number(latestStoredYear.school_year || 0) + 2);

      const first = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken, body: { series: 2, schoolYear: currentYear, startDate: today }
      }), context);
      const future = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken, body: { series: 3, schoolYear: currentYear, startDate: tomorrow }
      }), context);
      const older = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken, body: { series: 1, schoolYear: currentYear - 1, startDate: yesterday }
      }), context);
      for (const response of [first, future, older]) assert.equal(response.status, 201);
      assert.deepEqual(Object.keys(first.jsonBody).sort(), ["classId", "schoolYear", "series", "startDate"]);
      assert.equal(first.jsonBody.startDate, today);
      assert.match(first.headers.etag, /^"[A-Za-z0-9_-]+"$/);

      const duplicate = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken, body: { series: 3, schoolYear: currentYear, startDate: today }
      }), context);
      assertProblemResponse(duplicate, 409, "CLASS_ALREADY_EXISTS");

      const defaultPage = await handlers.listClasses(accountRequest("GET", {
        cookie: adminToken, query: new URLSearchParams()
      }), context);
      assert.deepEqual(defaultPage.jsonBody.pagination, {
        page: 1, pageSize: 20, totalItems: 2, totalPages: 1
      });
      assert.deepEqual(defaultPage.jsonBody.items.map((item) => item.series), [2, 3]);
      assert.equal(defaultPage.jsonBody.items.every((item) => item.schoolYear === currentYear), true);
      const filtered = await handlers.listClasses(accountRequest("GET", {
        cookie: adminToken,
        query: new URLSearchParams("schoolYear=" + (currentYear - 1) + "&page=1&pageSize=1")
      }), context);
      assert.deepEqual(filtered.jsonBody.items, [older.jsonBody]);

      const detail = await handlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: first.jsonBody.classId }
      }), context);
      assert.deepEqual(detail.jsonBody, first.jsonBody);
      assert.match(detail.headers.etag, /^"[A-Za-z0-9_-]+"$/);
      const classRow = () => database("turma").where({ id_turma: first.jsonBody.classId }).first();

      const noOp = await handlers.updateClass(accountRequest("PATCH", {
        cookie: adminToken, params: { classId: first.jsonBody.classId },
        ifMatch: detail.headers.etag, body: { series: 2 }
      }), context);
      assert.equal(noOp.status, 200);
      assert.equal(noOp.headers.etag, detail.headers.etag);
      assert.equal(Number((await classRow()).version), 1);

      const duplicateUpdate = await handlers.updateClass(accountRequest("PATCH", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }, body: { series: 2 }
      }), context);
      assertProblemResponse(duplicateUpdate, 409, "CLASS_ALREADY_EXISTS");

      const updated = await handlers.updateClass(accountRequest("PATCH", {
        cookie: adminToken, params: { classId: first.jsonBody.classId }, body: { series: 1 }
      }), context);
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.jsonBody, {
        classId: first.jsonBody.classId, series: 1, schoolYear: currentYear, startDate: today
      });
      assert.notEqual(updated.headers.etag, detail.headers.etag);
      const staleUpdate = await handlers.updateClass(accountRequest("PATCH", {
        cookie: adminToken, params: { classId: first.jsonBody.classId },
        ifMatch: detail.headers.etag, body: { series: 2 }
      }), context);
      assert.equal(staleUpdate.status, 412);

      const rawHandlers = createAdminClassHandlers({ getDatabase: () => database, allowedOrigins: [AUTH_ORIGIN] });
      const missingIfMatch = await rawHandlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }
      }), context);
      assert.equal(missingIfMatch.status, 428);
      for (const invalidTag of ["*", "W/\"weak\"", "\"one\", \"two\""]) {
        const invalid = await rawHandlers.closeClass(accountRequest("POST", {
          cookie: adminToken, params: { classId: future.jsonBody.classId }, ifMatch: invalidTag
        }), context);
        assert.equal(invalid.status, 400);
      }

      const futureTag = (await handlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }
      }), context)).headers.etag;
      const futureClose = await handlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }, ifMatch: futureTag
      }), context);
      assert.equal(futureClose.status, 204, "closing before start is allowed");
      const closedFutureRepresentation = await handlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }
      }), context);
      assert.equal(futureClose.headers.etag, closedFutureRepresentation.headers.etag);
      assert.notEqual(futureClose.headers.etag, futureTag);
      const closedFuture = await database("turma").where({ id_turma: future.jsonBody.classId }).first();
      assert.ok(closedFuture.fechada_em);
      assert.equal(Number(closedFuture.version), 2);
      assert.equal((await handlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }, ifMatch: futureTag
      }), context)).status, 412);
      const currentFutureTag = (await handlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }
      }), context)).headers.etag;
      const alreadyClosed = await handlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: future.jsonBody.classId }, ifMatch: currentFutureTag
      }), context);
      assert.equal(alreadyClosed.status, 204);
      assert.equal(alreadyClosed.headers.etag, currentFutureTag);
      assert.equal(Number((await database("turma").where({ id_turma: future.jsonBody.classId }).first()).version), 2);

      const selectedSourceId = await insertClass(database, {
        series: 2, schoolYear: currentYear + 100, startDate: yesterday
      });
      const selectedStudentId = await insertStudent(database);
      const selectedStudentToken = await insertAuthSession(database, selectedStudentId);
      await database("matricula").insert({
        id_usuario_aluno: selectedStudentId, id_turma: selectedSourceId,
        inicio_vigencia: yesterday, fim_vigencia: null, cancelada_em: null
      });
      const selected = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken,
        body: {
          series: 2,
          schoolYear: currentYear + 101,
          startDate: today,
          closeClassIds: [{ classId: selectedSourceId, expectedVersion: 1 }]
        }
      }), context);
      assert.equal(selected.status, 201);
      assert.equal(selected.jsonBody.schoolYear, currentYear + 101);
      const closedSource = await database("turma").where({ id_turma: selectedSourceId }).first();
      assert.ok(closedSource.fechada_em);
      assert.equal(Number(closedSource.version), 2);
      const selectedStudentSession = await database("sessao")
        .where({ id_usuario: selectedStudentId }).first();
      assert.ok(selectedStudentSession.revogada_em);
      assert.ok(selectedStudentToken);

      const rollbackSourceId = await insertClass(database, {
        series: 1, schoolYear: currentYear + 300, startDate: today
      });
      const classCountBefore = Number((await database("turma").count({ count: "id_turma" }).first()).count);
      const selectionError = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken,
        body: {
          series: 1,
          schoolYear: currentYear + 301,
          startDate: today,
          closeClassIds: [
            { classId: rollbackSourceId, expectedVersion: 1 },
            { classId: "9223372036854775807", expectedVersion: 1 }
          ]
        }
      }), context);
      const selectionProblem = assertProblemResponse(selectionError, 409, "CLASS_SELECTION_INVALID");
      assert.deepEqual(selectionProblem.errors[0].source, { in: "body", pointer: "/closeClassIds" });
      assert.equal(Number((await database("turma").count({ count: "id_turma" }).first()).count), classCountBefore);
      assert.equal((await database("turma").where({ id_turma: rollbackSourceId }).first()).fechada_em, null);

      const staleSelection = await handlers.createClass(accountRequest("POST", {
        cookie: adminToken,
        body: {
          series: 2,
          schoolYear: currentYear + 101,
          startDate: today,
          closeClassIds: [{ classId: selectedSourceId, expectedVersion: 1 }]
        }
      }), context);
      assertProblemResponse(staleSelection, 409, "CLASS_SELECTION_INVALID");

      const linkedClassId = await insertClass(database);
      const linkedSubjectId = await insertSubject(database);
      const [linkedOffer] = await database("turma_disciplina")
        .insert({ id_turma: linkedClassId, id_materia: linkedSubjectId })
        .returning("id_turma_disciplina");
      const linkedEdit = await handlers.updateClass(accountRequest("PATCH", {
        cookie: adminToken, params: { classId: linkedClassId }, body: { schoolYear: nextSchoolYear() }
      }), context);
      assertProblemResponse(linkedEdit, 409, "CLASS_HAS_LINKED_DATA");
      const linkedTag = (await handlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: linkedClassId }
      }), context)).headers.etag;
      assert.equal((await handlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: linkedClassId }, ifMatch: linkedTag
      }), context)).status, 204);
      assert.equal(await database("turma_disciplina")
        .where({ id_turma_disciplina: linkedOffer.id_turma_disciplina }).first() !== undefined, true);

      const concurrentYear = currentYear + 400;
      const concurrentCreates = await Promise.all([
        handlers.createClass(accountRequest("POST", {
          cookie: adminToken, body: { series: 1, schoolYear: concurrentYear, startDate: today }
        }), context),
        adminClassHandlers(secondConnection).createClass(accountRequest("POST", {
          cookie: adminToken, body: { series: 1, schoolYear: concurrentYear, startDate: today }
        }), context)
      ]);
      assert.equal(concurrentCreates.filter((response) => response.status === 201).length, 1);
      assert.equal(concurrentCreates.filter((response) => response.status === 409).length, 1);

      const nonAdminId = await insertStudent(database, newIdentity("class-non-admin"));
      const nonAdminToken = await insertAuthSession(database, nonAdminId);
      const queries = [];
      const listener = (query) => queries.push(query.sql);
      database.on("query", listener);
      try {
        const denied = await Promise.all([
          handlers.listClasses(accountRequest("GET", { cookie: nonAdminToken, query: new URLSearchParams() }), context),
          handlers.listClassYears(accountRequest("GET", { cookie: nonAdminToken }), context),
          handlers.getClass(accountRequest("GET", {
            cookie: nonAdminToken, params: { classId: first.jsonBody.classId }
          }), context),
          handlers.createClass(accountRequest("POST", {
            cookie: nonAdminToken,
            body: { series: 1, schoolYear: currentYear + 500, startDate: today }
          }), context),
          handlers.updateClass(accountRequest("PATCH", {
            cookie: nonAdminToken, params: { classId: first.jsonBody.classId }, body: { series: 2 }
          }), context),
          handlers.closeClass(accountRequest("POST", {
            cookie: nonAdminToken, params: { classId: first.jsonBody.classId }
          }), context),
          handlers.addClassSubject(accountRequest("PUT", {
            cookie: nonAdminToken, params: { classId: linkedClassId, subjectId: linkedSubjectId }
          }), context),
          handlers.removeClassSubject(accountRequest("DELETE", {
            cookie: nonAdminToken, params: { classId: linkedClassId, subjectId: linkedSubjectId }
          }), context)
        ]);
        for (const response of denied) assertProblemResponse(response, 404, "RESOURCE_NOT_FOUND");
      } finally {
        database.removeListener("query", listener);
      }
      assert.equal(queries.some((sql) => /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+"?(?:turma|turma_disciplina|materia|matricula|simulado)\b/i.test(sql)), false);
      assert.equal(handlers.deleteClass, undefined);
      const records = logs.map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.event === "admin_class_create" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_class_update" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_class_close" && record.result === "completed"));
    });
    await t.test("student status derives eligibility from half-open dates and open classes", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("enrollment-view-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const accountHandlers = adminAccountHandlers(database, { async send() {} });
      const classHandlers = adminClassHandlers(database);
      const dates = await database.raw("SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday, (CURRENT_DATE + 1)::text AS tomorrow");
      const { today, yesterday, tomorrow } = dates.rows[0];
      const context = { invocationId: "synthetic-enrollment-view", log() {} };

      const futureClassId = await insertClass(database);
      const futureStudentId = await insertStudent(database);
      const [futureEnrollment] = await database("matricula").insert({
        id_usuario_aluno: futureStudentId,
        id_turma: futureClassId,
        inicio_vigencia: tomorrow,
        fim_vigencia: null,
        cancelada_em: null
      }).returning("id_matricula");
      const futureList = await accountHandlers.listStudents(accountRequest("GET", {
        cookie: adminToken,
        query: new URLSearchParams("classId=" + futureClassId + "&enrollmentStatus=active")
      }), context);
      assert.equal(futureList.jsonBody.pagination.totalItems, 0);
      const futureDetail = await accountHandlers.getStudent(accountRequest("GET", {
        cookie: adminToken, params: { studentId: String(futureStudentId) }
      }), context);
      assert.equal(futureDetail.jsonBody.enrollmentStatus, "no_active_enrollment");
      assert.equal(futureDetail.jsonBody.currentClass, null);
      assert.equal(futureDetail.jsonBody.enrollments[0].enrollmentId, String(futureEnrollment.id_matricula));

      const futureTag = (await classHandlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: futureClassId }
      }), context)).headers.etag;
      assert.equal((await classHandlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: futureClassId }, ifMatch: futureTag
      }), context)).status, 204);
      assert.equal((await database("matricula").where({ id_matricula: futureEnrollment.id_matricula }).first()).fim_vigencia, null);
      assert.equal((await accountHandlers.getStudent(accountRequest("GET", {
        cookie: adminToken, params: { studentId: String(futureStudentId) }
      }), context)).jsonBody.enrollmentStatus, "no_active_enrollment");

      const scheduledClassId = await insertClass(database);
      const scheduledStudentId = await insertStudent(database);
      const [scheduledEnrollment] = await database("matricula").insert({
        id_usuario_aluno: scheduledStudentId,
        id_turma: scheduledClassId,
        inicio_vigencia: yesterday,
        fim_vigencia: tomorrow,
        cancelada_em: database.raw("clock_timestamp()")
      }).returning("id_matricula");
      const scheduledList = await accountHandlers.listStudents(accountRequest("GET", {
        cookie: adminToken,
        query: new URLSearchParams("classId=" + scheduledClassId + "&enrollmentStatus=active")
      }), context);
      assert.equal(scheduledList.jsonBody.pagination.totalItems, 1);
      assert.equal(scheduledList.jsonBody.items[0].enrollmentId, String(scheduledEnrollment.id_matricula));
      const scheduledTag = (await classHandlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: scheduledClassId }
      }), context)).headers.etag;
      assert.equal((await classHandlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: scheduledClassId }, ifMatch: scheduledTag
      }), context)).status, 204);
      const scheduledDetail = await accountHandlers.getStudent(accountRequest("GET", {
        cookie: adminToken, params: { studentId: String(scheduledStudentId) }
      }), context);
      assert.equal(scheduledDetail.jsonBody.enrollmentStatus, "no_active_enrollment");
      assert.equal(scheduledDetail.jsonBody.enrollments[0].cancellationDate, tomorrow);

      const boundaryClassId = await insertClass(database);
      const boundaryStudentId = await insertStudent(database);
      const [boundaryEnrollment] = await database("matricula").insert({
        id_usuario_aluno: boundaryStudentId,
        id_turma: boundaryClassId,
        inicio_vigencia: yesterday,
        fim_vigencia: today,
        cancelada_em: null
      }).returning("id_matricula");
      const effectiveYesterday = await database("matricula as m")
        .select("m.id_matricula")
        .where("m.id_matricula", boundaryEnrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m", "?::date"), [yesterday, yesterday])
        .first();
      const effectiveOnEndDate = await database("matricula as m")
        .select("m.id_matricula")
        .where("m.id_matricula", boundaryEnrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m", "?::date"), [today, today])
        .first();
      assert.ok(effectiveYesterday);
      assert.equal(effectiveOnEndDate, undefined);
      const boundaryTag = (await classHandlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: boundaryClassId }
      }), context)).headers.etag;
      assert.equal((await classHandlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: boundaryClassId }, ifMatch: boundaryTag
      }), context)).status, 204);
      assert.equal(await database("matricula").where({ id_matricula: boundaryEnrollment.id_matricula }).first() !== undefined, true);
    });
    await t.test("enrollment creation and renewal validate, serialize, and roll back atomically", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("enrollment-create-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const handlers = adminEnrollmentHandlers(database);
      const secondHandlers = adminEnrollmentHandlers(secondConnection);
      const dates = await database.raw(`
        SELECT CURRENT_DATE::text AS today,
          (CURRENT_DATE - 1)::text AS yesterday,
          (CURRENT_DATE + 1)::text AS tomorrow,
          (CURRENT_DATE + 2)::text AS day_after_tomorrow
      `);
      const { today, yesterday, tomorrow, day_after_tomorrow: dayAfterTomorrow } = dates.rows[0];
      const logs = [];
      const context = { invocationId: "synthetic-enrollment-create", log(message) { logs.push(message); } };
      const createFor = (studentId, classId, startDate, confirmPreviousEnrollmentId, targetHandlers = handlers) => {
        const body = { studentId: String(studentId), startDate };
        if (confirmPreviousEnrollmentId !== undefined) {
          body.confirmPreviousEnrollmentId = String(confirmPreviousEnrollmentId);
        }
        return targetHandlers.createEnrollment(accountRequest("POST", {
          cookie: adminToken,
          params: { classId: String(classId) },
          body
        }), context);
      };
      const countStudentEnrollments = async (studentId) => {
        const row = await database("matricula").where({ id_usuario_aluno: studentId })
          .count({ count: "id_matricula" }).first();
        return Number(row.count);
      };

      const pendingStudent = await insertPendingStudent(database);
      const futureClass = await insertClass(database, { schoolYear: 1900000000 });
      const pastDate = await createFor(pendingStudent, futureClass, yesterday);
      assertProblemResponse(pastDate, 422, "VALIDATION_ERROR");
      assert.equal(await countStudentEnrollments(pendingStudent), 0);

      const created = await createFor(pendingStudent, futureClass, tomorrow);
      assert.equal(created.status, 201);
      assert.deepEqual(Object.keys(created.jsonBody), ["enrollmentId"]);
      assert.match(created.jsonBody.enrollmentId, /^[1-9]\d*$/);
      const createdRow = await database("matricula")
        .select("id_turma", database.raw("inicio_vigencia::text AS inicio_vigencia"), "fim_vigencia")
        .where({ id_matricula: created.jsonBody.enrollmentId, id_usuario_aluno: pendingStudent }).first();
      assert.equal(String(createdRow.id_turma), futureClass);
      assert.equal(createdRow.inicio_vigencia, tomorrow);
      assert.equal(createdRow.fim_vigencia, null);
      assert.equal(await database("matricula as m")
        .where("m.id_matricula", created.jsonBody.enrollmentId)
        .whereRaw(effectiveEnrollmentPredicate("m"))
        .first(), undefined, "a future enrollment is not effective today");
      assert.ok(await database("matricula as m")
        .where("m.id_matricula", created.jsonBody.enrollmentId)
        .whereRaw(effectiveEnrollmentPredicate("m", "?::date"), [tomorrow, tomorrow])
        .first(), "the enrollment becomes effective on its start date");
      assertProblemResponse(await createFor(pendingStudent, futureClass, tomorrow), 409, "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(pendingStudent), 1, "a repeated POST does not create a duplicate");

      const sameYearStudent = await insertStudent(database);
      const sameYearSourceClass = await insertClass(database, { series: 1, schoolYear: 1900000010 });
      const sameYearTargetClass = await insertClass(database, { series: 2, schoolYear: 1900000010 });
      await database("matricula").insert({
        id_usuario_aluno: sameYearStudent,
        id_turma: sameYearSourceClass,
        inicio_vigencia: yesterday
      });
      assertProblemResponse(await createFor(sameYearStudent, sameYearTargetClass, today),
        409, "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(sameYearStudent), 1);

      const otherYearStudent = await insertStudent(database);
      const otherYearSourceClass = await insertClass(database, { schoolYear: 1900000018 });
      const otherYearTargetClass = await insertClass(database, { schoolYear: 1900000020 });
      await database("matricula").insert({
        id_usuario_aluno: otherYearStudent,
        id_turma: otherYearSourceClass,
        inicio_vigencia: yesterday
      });
      assertProblemResponse(await createFor(otherYearStudent, otherYearTargetClass, today),
        409, "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(otherYearStudent), 1);

      const deletedStudent = await insertStudent(database);
      const deletedStudentClass = await insertClass(database, { schoolYear: 1900000030 });
      await database("usuario").where({ id_usuario: deletedStudent }).update({
        excluido_em: database.raw("clock_timestamp()")
      });
      assertProblemResponse(await createFor(deletedStudent, deletedStudentClass, today),
        404, "STUDENT_NOT_FOUND");
      const missingClassStudent = await insertStudent(database);
      assertProblemResponse(await createFor(missingClassStudent, "9223372036854775807", today), 404, "CLASS_NOT_FOUND");

      const renewalStudent = await insertPendingStudent(database);
      const renewalYear = 1900000040;
      const previousClass = await insertClass(database, { schoolYear: renewalYear - 1 });
      const renewalClass = await insertClass(database, { schoolYear: renewalYear });
      const [previousEnrollment] = await database("matricula").insert({
        id_usuario_aluno: renewalStudent,
        id_turma: previousClass,
        inicio_vigencia: tomorrow
      }).returning("id_matricula");
      assert.equal(await database("matricula as m")
        .where("m.id_matricula", previousEnrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m"))
        .first(), undefined, "the preceding-year enrollment is not active today");

      const firstRenewal = await createFor(renewalStudent, renewalClass, dayAfterTomorrow);
      assertProblemResponse(firstRenewal, 409, "PREVIOUS_YEAR_ENROLLMENT_CONFIRMATION_REQUIRED");
      assert.equal(firstRenewal.jsonBody.previousEnrollmentId, String(previousEnrollment.id_matricula));
      assert.equal(await countStudentEnrollments(renewalStudent), 1);
      assert.equal((await database("matricula").where({ id_matricula: previousEnrollment.id_matricula }).first()).fim_vigencia,
        null, "the first request makes no writes");

      const confirmedRenewal = await createFor(renewalStudent, renewalClass, dayAfterTomorrow,
        previousEnrollment.id_matricula);
      assert.equal(confirmedRenewal.status, 201);
      assert.deepEqual(Object.keys(confirmedRenewal.jsonBody), ["enrollmentId"]);
      assert.match(confirmedRenewal.jsonBody.enrollmentId, /^[1-9]\d*$/);
      const renewedPrevious = await database("matricula")
        .select(database.raw("fim_vigencia::text AS fim_vigencia"), "cancelada_em")
        .where({ id_matricula: previousEnrollment.id_matricula }).first();
      assert.equal(renewedPrevious.fim_vigencia, dayAfterTomorrow);
      assert.equal(renewedPrevious.cancelada_em, null);
      const newRenewal = await database("matricula")
        .select("id_turma", database.raw("inicio_vigencia::text AS inicio_vigencia"))
        .where({ id_matricula: confirmedRenewal.jsonBody.enrollmentId }).first();
      assert.equal(String(newRenewal.id_turma), renewalClass);
      assert.equal(newRenewal.inicio_vigencia, dayAfterTomorrow);
      assert.equal(await countStudentEnrollments(renewalStudent), 2);
      const retroactiveResults = await database("resultado").where({ id_turma: renewalClass })
        .count("* as count").first();
      assert.equal(Number(retroactiveResults.count), 0, "renewal does not create retroactive results");
      assertProblemResponse(await createFor(renewalStudent, renewalClass, dayAfterTomorrow,
        previousEnrollment.id_matricula), 409, "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(renewalStudent), 2,
        "retrying a completed confirmation does not create another enrollment");

      const exactStartStudent = await insertStudent(database);
      const [exactStartPrevious] = await database("matricula").insert({
        id_usuario_aluno: exactStartStudent,
        id_turma: previousClass,
        inicio_vigencia: tomorrow
      }).returning("id_matricula");
      const exactStartFirstRequest = await createFor(exactStartStudent, renewalClass, tomorrow);
      assertProblemResponse(exactStartFirstRequest, 409, "PREVIOUS_YEAR_ENROLLMENT_CANNOT_BE_RENEWED");
      assert.equal(Object.hasOwn(exactStartFirstRequest.jsonBody, "previousEnrollmentId"), false,
        "the blocked exact boundary does not request confirmation");
      const exactStartConfirmedRequest = await createFor(
        exactStartStudent, renewalClass, tomorrow, exactStartPrevious.id_matricula
      );
      assertProblemResponse(exactStartConfirmedRequest, 409, "PREVIOUS_YEAR_ENROLLMENT_CANNOT_BE_RENEWED");
      assert.equal(await countStudentEnrollments(exactStartStudent), 1,
        "neither request changes the exact-start enrollment set");
      const unchangedExactStart = await database("matricula")
        .select(database.raw("inicio_vigencia::text AS inicio_vigencia"), "fim_vigencia", "cancelada_em")
        .where({ id_matricula: exactStartPrevious.id_matricula }).first();
      assert.equal(unchangedExactStart.inicio_vigencia, tomorrow);
      assert.equal(unchangedExactStart.fim_vigencia, null);
      assert.equal(unchangedExactStart.cancelada_em, null);

      const previousDayStudent = await insertStudent(database);
      const [previousDayEnrollment] = await database("matricula").insert({
        id_usuario_aluno: previousDayStudent,
        id_turma: previousClass,
        inicio_vigencia: today
      }).returning("id_matricula");
      const previousDayRequest = await createFor(previousDayStudent, renewalClass, tomorrow);
      assertProblemResponse(previousDayRequest, 409, "PREVIOUS_YEAR_ENROLLMENT_CONFIRMATION_REQUIRED");
      assert.equal(previousDayRequest.jsonBody.previousEnrollmentId, String(previousDayEnrollment.id_matricula));
      const previousDayConfirmed = await createFor(
        previousDayStudent, renewalClass, tomorrow, previousDayEnrollment.id_matricula
      );
      assert.equal(previousDayConfirmed.status, 201,
        "a prior enrollment beginning one day earlier remains renewable");
      assert.equal(await countStudentEnrollments(previousDayStudent), 2);

      const followingDayStudent = await insertStudent(database);
      await database("matricula").insert({
        id_usuario_aluno: followingDayStudent,
        id_turma: previousClass,
        inicio_vigencia: dayAfterTomorrow
      }).returning("id_matricula");
      assertProblemResponse(await createFor(followingDayStudent, renewalClass, tomorrow),
        409, "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(followingDayStudent), 1,
        "a prior enrollment starting one day later is not treated as effective at startDate");

      const staleStudent = await insertStudent(database);
      const staleClass = await insertClass(database, { schoolYear: 1900000050 });
      const stalePreviousClass = await insertClass(database, { schoolYear: 1900000049 });
      const [stalePrevious] = await database("matricula").insert({
        id_usuario_aluno: staleStudent,
        id_turma: stalePreviousClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const stalePrompt = await createFor(staleStudent, staleClass, tomorrow);
      assertProblemResponse(stalePrompt, 409, "PREVIOUS_YEAR_ENROLLMENT_CONFIRMATION_REQUIRED");
      await database("matricula").where({ id_matricula: stalePrevious.id_matricula }).update({ fim_vigencia: today });
      const staleConfirmation = await createFor(staleStudent, staleClass, tomorrow, stalePrevious.id_matricula);
      assertProblemResponse(staleConfirmation, 409, "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(staleStudent), 1);
      const unchangedStalePrevious = await database("matricula")
        .select(database.raw("fim_vigencia::text AS fim_vigencia"))
        .where({ id_matricula: stalePrevious.id_matricula }).first();
      assert.equal(unchangedStalePrevious.fim_vigencia, today);

      const replacementStudent = await insertStudent(database);
      const replacementYear = 1900000060;
      const replacementTargetClass = await insertClass(database, { schoolYear: replacementYear });
      const originalPriorClass = await insertClass(database, { series: 1, schoolYear: replacementYear - 1 });
      const currentPriorClass = await insertClass(database, { series: 2, schoolYear: replacementYear - 1 });
      const [originalPrior] = await database("matricula").insert({
        id_usuario_aluno: replacementStudent,
        id_turma: originalPriorClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const replacementPrompt = await createFor(replacementStudent, replacementTargetClass, tomorrow);
      assertProblemResponse(replacementPrompt, 409, "PREVIOUS_YEAR_ENROLLMENT_CONFIRMATION_REQUIRED");
      await database("matricula").where({ id_matricula: originalPrior.id_matricula }).update({ fim_vigencia: today });
      const [currentPrior] = await database("matricula").insert({
        id_usuario_aluno: replacementStudent,
        id_turma: currentPriorClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const staleButReconfirmable = await createFor(replacementStudent, replacementTargetClass, tomorrow,
        originalPrior.id_matricula);
      assertProblemResponse(staleButReconfirmable, 409, "PREVIOUS_YEAR_ENROLLMENT_CONFIRMATION_REQUIRED");
      assert.equal(staleButReconfirmable.jsonBody.previousEnrollmentId, String(currentPrior.id_matricula));
      assert.equal((await database("matricula").where({ id_matricula: currentPrior.id_matricula }).first()).fim_vigencia,
        null, "a mismatched confirmation does not close the currently eligible enrollment");
      const reconfirmed = await createFor(replacementStudent, replacementTargetClass, tomorrow,
        currentPrior.id_matricula);
      assert.equal(reconfirmed.status, 201);
      assert.equal(await countStudentEnrollments(replacementStudent), 3);

      const rollbackStudent = await insertStudent(database);
      const rollbackYear = 1900000070;
      const rollbackTargetClass = await insertClass(database, { schoolYear: rollbackYear });
      const rollbackPreviousClass = await insertClass(database, { schoolYear: rollbackYear - 1 });
      const [rollbackPrevious] = await database("matricula").insert({
        id_usuario_aluno: rollbackStudent,
        id_turma: rollbackPreviousClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const suffix = String(process.pid) + "_" + randomBytes(4).toString("hex");
      const triggerName = "enrollment_create_fail_insert_" + suffix;
      const functionName = "enrollment_create_fail_insert_" + suffix;
      await database.raw([
        "CREATE FUNCTION " + functionName + "() RETURNS trigger",
        "LANGUAGE plpgsql AS $$",
        "BEGIN",
        "  RAISE EXCEPTION 'synthetic-sensitive-enrollment-insert-error';",
        "END;",
        "$$;",
        "CREATE TRIGGER " + triggerName + " BEFORE INSERT ON matricula",
        "FOR EACH ROW EXECUTE FUNCTION " + functionName + "();"
      ].join("\n"));
      let failedRenewal;
      try {
        failedRenewal = await createFor(rollbackStudent, rollbackTargetClass, today, rollbackPrevious.id_matricula);
      } finally {
        await database.raw("DROP TRIGGER IF EXISTS " + triggerName + " ON matricula");
        await database.raw("DROP FUNCTION IF EXISTS " + functionName + "()");
      }
      assert.equal(failedRenewal.status, 500);
      assert.equal(JSON.stringify(failedRenewal).includes("synthetic-sensitive-enrollment-insert-error"), false);
      assert.equal(await countStudentEnrollments(rollbackStudent), 1);
      assert.equal((await database("matricula").where({ id_matricula: rollbackPrevious.id_matricula }).first()).fim_vigencia,
        null, "the old interval update rolls back when insertion fails");

      const concurrentStudent = await insertStudent(database);
      const concurrentYear = 1900000080;
      const concurrentTargetClass = await insertClass(database, { schoolYear: concurrentYear });
      const concurrentPreviousClass = await insertClass(database, { schoolYear: concurrentYear - 1 });
      const [concurrentPrevious] = await database("matricula").insert({
        id_usuario_aluno: concurrentStudent,
        id_turma: concurrentPreviousClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const concurrentResults = await Promise.all([
        createFor(concurrentStudent, concurrentTargetClass, today, concurrentPrevious.id_matricula, handlers),
        createFor(concurrentStudent, concurrentTargetClass, today, concurrentPrevious.id_matricula, secondHandlers)
      ]);
      assert.equal(concurrentResults.filter((response) => response.status === 201).length, 1);
      assert.equal(concurrentResults.filter((response) => response.status === 409).length, 1);
      assert.equal(concurrentResults.find((response) => response.status === 409).jsonBody.code,
        "ENROLLMENT_ALREADY_ACTIVE");
      assert.equal(await countStudentEnrollments(concurrentStudent), 2);
      const concurrentOld = await database("matricula")
        .select(database.raw("fim_vigencia::text AS fim_vigencia"))
        .where({ id_matricula: concurrentPrevious.id_matricula }).first();
      assert.equal(concurrentOld.fim_vigencia, today);

      const records = logs.map((line) => JSON.parse(line));
      assert.ok(records.every((record) => record.event === "admin_enrollment_create"));
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
        assert.equal(record.invocationId, "synthetic-enrollment-create");
      }
      const serializedLogText = records.flatMap((record) => [record.event, record.invocationId, record.result]).join(" ");
      for (const sensitiveValue of [
        String(pendingStudent), String(renewalStudent), String(previousEnrollment.id_matricula),
        "synthetic-sensitive-enrollment-insert-error"
      ]) assert.equal(serializedLogText.includes(sensitiveValue), false);
    });

    await t.test("enrollment cancellation validates effective dates, serializes, and sanitizes failures", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("enrollment-cancel-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const handlers = adminEnrollmentHandlers(database);
      const secondHandlers = adminEnrollmentHandlers(secondConnection);
      const dates = await database.raw(`
        SELECT CURRENT_DATE::text AS today,
          (CURRENT_DATE - 1)::text AS yesterday,
          (CURRENT_DATE + 1)::text AS tomorrow
      `);
      const { today, yesterday, tomorrow } = dates.rows[0];
      const logs = [];
      const context = { invocationId: "synthetic-enrollment-cancel", log(message) { logs.push(message); } };

      const studentId = await insertStudent(database);
      const classId = await insertClass(database);
      const [enrollment] = await database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const yesterdayResponse = await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(enrollment.id_matricula) },
        body: { cancellationDate: yesterday }
      }), context);
      assertProblemResponse(yesterdayResponse, 422, "VALIDATION_ERROR");
      const unchangedAfterPastDate = await database("matricula").where({ id_matricula: enrollment.id_matricula }).first();
      assert.equal(unchangedAfterPastDate.fim_vigencia, null);
      assert.equal(unchangedAfterPastDate.cancelada_em, null);

      const cancelledToday = await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(enrollment.id_matricula) },
        body: { cancellationDate: today }
      }), context);
      assert.equal(cancelledToday.status, 204);
      const cancelledRow = await database("matricula")
        .select(database.raw("fim_vigencia::text AS fim_vigencia"), "cancelada_em")
        .where({ id_matricula: enrollment.id_matricula }).first();
      assert.equal(cancelledRow.fim_vigencia, today);
      assert.ok(cancelledRow.cancelada_em);
      const effectiveBeforeCancellation = await database("matricula as m")
        .select("m.id_matricula")
        .where("m.id_matricula", enrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m", "?::date"), [yesterday, yesterday])
        .first();
      const effectiveOnCancellationDate = await database("matricula as m")
        .select("m.id_matricula")
        .where("m.id_matricula", enrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m", "?::date"), [today, today])
        .first();
      assert.ok(effectiveBeforeCancellation);
      assert.equal(effectiveOnCancellationDate, undefined);
      assertProblemResponse(await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(enrollment.id_matricula) },
        body: { cancellationDate: tomorrow }
      }), context), 409, "ENROLLMENT_ALREADY_CANCELLED");

      const immediateStartStudent = await insertStudent(database);
      const immediateStartClass = await insertClass(database);
      const [immediateStartEnrollment] = await database("matricula").insert({
        id_usuario_aluno: immediateStartStudent,
        id_turma: immediateStartClass,
        inicio_vigencia: today
      }).returning("id_matricula");
      assertProblemResponse(await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(immediateStartEnrollment.id_matricula) },
        body: { cancellationDate: today }
      }), context), 422, "VALIDATION_ERROR");
      const immediateStartUnchanged = await database("matricula")
        .where({ id_matricula: immediateStartEnrollment.id_matricula }).first();
      assert.equal(immediateStartUnchanged.fim_vigencia, null);
      assert.equal(immediateStartUnchanged.cancelada_em, null);

      const scheduledStudent = await insertStudent(database);
      const scheduledClass = await insertClass(database);
      const [scheduledEnrollment] = await database("matricula").insert({
        id_usuario_aluno: scheduledStudent,
        id_turma: scheduledClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      assert.equal((await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(scheduledEnrollment.id_matricula) },
        body: { cancellationDate: tomorrow }
      }), context)).status, 204);
      const futureCancelledRow = await database("matricula")
        .select(database.raw("fim_vigencia::text AS fim_vigencia"), "cancelada_em")
        .where({ id_matricula: scheduledEnrollment.id_matricula }).first();
      assert.equal(futureCancelledRow.fim_vigencia, tomorrow);
      assert.ok(futureCancelledRow.cancelada_em);
      assert.ok(await database("matricula as m")
        .select("m.id_matricula")
        .where("m.id_matricula", scheduledEnrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m"))
        .first(), "a future effective end does not cancel the enrollment immediately");
      assert.equal(await database("matricula as m")
        .select("m.id_matricula")
        .where("m.id_matricula", scheduledEnrollment.id_matricula)
        .whereRaw(effectiveEnrollmentPredicate("m", "?::date"), [tomorrow, tomorrow])
        .first(), undefined);
      assertProblemResponse(await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(scheduledEnrollment.id_matricula) },
        body: { cancellationDate: tomorrow }
      }), context), 409, "ENROLLMENT_ALREADY_CANCELLED");

      assertProblemResponse(await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: "9223372036854775807" },
        body: { cancellationDate: today }
      }), context), 404, "ENROLLMENT_NOT_FOUND");
      const deletedStudent = await insertStudent(database);
      const closedClass = await insertClass(database);
      const [deletedStudentEnrollment] = await database("matricula").insert({
        id_usuario_aluno: deletedStudent,
        id_turma: closedClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      await database("usuario").where({ id_usuario: deletedStudent }).update({
        excluido_em: database.raw("clock_timestamp()")
      });
      assertProblemResponse(await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(deletedStudentEnrollment.id_matricula) },
        body: { cancellationDate: today }
      }), context), 404, "ENROLLMENT_NOT_FOUND");

      const closedStudent = await insertStudent(database);
      const [closedEnrollment] = await database("matricula").insert({
        id_usuario_aluno: closedStudent,
        id_turma: closedClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const classHandlers = adminClassHandlers(database);
      const classTag = (await classHandlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: closedClass }
      }), context)).headers.etag;
      assert.equal((await classHandlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: closedClass }, ifMatch: classTag
      }), context)).status, 204);
      assertProblemResponse(await handlers.cancelEnrollment(accountRequest("POST", {
        cookie: adminToken,
        params: { enrollmentId: String(closedEnrollment.id_matricula) },
        body: { cancellationDate: today }
      }), context), 409, "CLASS_CLOSED");

      const failingStudent = await insertStudent(database);
      const failingClass = await insertClass(database);
      const [failingEnrollment] = await database("matricula").insert({
        id_usuario_aluno: failingStudent,
        id_turma: failingClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
      const triggerName = `enrollment_test_fail_update_${suffix}`;
      const functionName = `enrollment_test_fail_update_${suffix}`;
      await database.raw(`
        CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'synthetic-sensitive-enrollment-database-error';
        END;
        $$;
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF fim_vigencia, cancelada_em ON matricula
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);
      let failedCancellation;
      try {
        failedCancellation = await handlers.cancelEnrollment(accountRequest("POST", {
          cookie: adminToken,
          params: { enrollmentId: String(failingEnrollment.id_matricula) },
          body: { cancellationDate: today }
        }), context);
      } finally {
        await database.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON matricula;`);
        await database.raw(`DROP FUNCTION IF EXISTS ${functionName}();`);
      }
      assert.equal(failedCancellation.status, 500);
      assert.equal(JSON.stringify(failedCancellation).includes("synthetic-sensitive-enrollment-database-error"), false);
      const failedRow = await database("matricula").where({ id_matricula: failingEnrollment.id_matricula }).first();
      assert.equal(failedRow.fim_vigencia, null);
      assert.equal(failedRow.cancelada_em, null);
      const failureLogs = logs.map((line) => JSON.parse(line));
      assert.equal(JSON.stringify(failureLogs).includes("synthetic-sensitive-enrollment-database-error"), false);

      const concurrentStudent = await insertStudent(database);
      const concurrentClass = await insertClass(database);
      const [concurrentEnrollment] = await database("matricula").insert({
        id_usuario_aluno: concurrentStudent,
        id_turma: concurrentClass,
        inicio_vigencia: yesterday
      }).returning("id_matricula");
      const concurrentEnrollmentTag = (await handlers.getEnrollment(accountRequest("GET", {
        cookie: adminToken, params: { enrollmentId: String(concurrentEnrollment.id_matricula) }
      }), context)).headers.etag;
      const concurrentResults = await Promise.all([
        handlers.cancelEnrollment(accountRequest("POST", {
          cookie: adminToken,
          params: { enrollmentId: String(concurrentEnrollment.id_matricula) },
          ifMatch: concurrentEnrollmentTag,
          body: { cancellationDate: today }
        }), context),
        secondHandlers.cancelEnrollment(accountRequest("POST", {
          cookie: adminToken,
          params: { enrollmentId: String(concurrentEnrollment.id_matricula) },
          ifMatch: concurrentEnrollmentTag,
          body: { cancellationDate: today }
        }), context)
      ]);
      assert.equal(concurrentResults.filter((response) => response.status === 204).length, 1);
      assert.equal(concurrentResults.filter((response) => response.status === 412).length, 1);

      const records = logs.map((line) => JSON.parse(line));
      assert.ok(records.every((record) => record.event === "admin_enrollment_cancel"
        || record.event === "admin_class_close"));
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
        assert.equal(record.invocationId, "synthetic-enrollment-cancel");
      }
      const serializedLogText = records.flatMap((record) => [record.event, record.invocationId, record.result]).join(" ");
      for (const sensitiveValue of [
        String(studentId), String(enrollment.id_matricula), String(scheduledStudent),
        "synthetic-sensitive-enrollment-database-error"
      ]) assert.equal(serializedLogText.includes(sensitiveValue), false);
    });

    await t.test("subject offers are idempotent, preserve results, and remove related state atomically", async () => {
      const administrator = await insertAuthAdministrator(database, { email: newIdentity("offer-admin") });
      const adminToken = await insertAuthSession(database, administrator.id);
      const handlers = adminClassHandlers(database);
      const accountHandlers = adminAccountHandlers(database, { async send() {} });
      const logs = [];
      const context = { invocationId: "synthetic-offer-invocation", log(message) { logs.push(message); } };

      const classId = await insertClass(database);
      const subjectZ = await insertSubject(database, `Phase02 Offer Z ${process.pid}`);
      const subjectA = await insertSubject(database, `Phase02 Offer A ${process.pid}`);
      const empty = await handlers.listClassSubjects(accountRequest("GET", {
        cookie: adminToken, params: { classId }
      }), context);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.jsonBody, { items: [] });

      for (const subjectId of [subjectZ, subjectA]) {
        const added = await handlers.addClassSubject(accountRequest("PUT", {
          cookie: adminToken, params: { classId, subjectId }
        }), context);
        assert.equal(added.status, 204);
        const repeated = await handlers.addClassSubject(accountRequest("PUT", {
          cookie: adminToken, params: { classId, subjectId }
        }), context);
        assert.equal(repeated.status, 204);
      }
      const offered = await handlers.listClassSubjects(accountRequest("GET", {
        cookie: adminToken, params: { classId }
      }), context);
      assert.deepEqual(offered.jsonBody.items.map((item) => item.subjectId), [subjectA, subjectZ]);
      assert.deepEqual(offered.jsonBody.items.map((item) => item.name), [
        `Phase02 Offer A ${process.pid}`, `Phase02 Offer Z ${process.pid}`
      ]);

      const deletedSubject = await insertSubject(database);
      await database("materia").where({ id_materia: deletedSubject }).update({
        excluido_em: database.raw("clock_timestamp()")
      });
      for (const params of [
        { classId: "9223372036854775807", subjectId: subjectZ },
        { classId, subjectId: "9223372036854775807" },
        { classId, subjectId: deletedSubject }
      ]) {
        const incompatible = await handlers.addClassSubject(accountRequest("PUT", {
          cookie: adminToken, params
        }), context);
        assertProblemResponse(incompatible, 404, "RESOURCE_NOT_FOUND");
      }
      const deletedClassId = await insertClass(database);
      assert.equal((await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: deletedClassId, subjectId: subjectZ }
      }), context)).status, 204);
      const deletedClassTag = (await handlers.getClass(accountRequest("GET", {
        cookie: adminToken, params: { classId: deletedClassId }
      }), context)).headers.etag;
      assert.equal((await handlers.closeClass(accountRequest("POST", {
        cookie: adminToken, params: { classId: deletedClassId }, ifMatch: deletedClassTag
      }), context)).status, 204);
      const closedSubjects = await handlers.listClassSubjects(accountRequest("GET", {
        cookie: adminToken, params: { classId: deletedClassId }
      }), context);
      assert.equal(closedSubjects.status, 200);
      assert.deepEqual(closedSubjects.jsonBody.items.map((item) => item.subjectId), [subjectZ]);
      assertProblemResponse(await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: deletedClassId, subjectId: subjectZ }
      }), context), 409, "CLASS_CLOSED");
      assertProblemResponse(await handlers.listClassSubjects(accountRequest("GET", {
        cookie: adminToken, params: { classId: "9223372036854775807" }
      }), context), 404, "RESOURCE_NOT_FOUND");
      assertProblemResponse(await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: deletedClassId, subjectId: subjectZ }
      }), context), 409, "CLASS_CLOSED");
      assertProblemResponse(await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId, subjectId: "9223372036854775807" }
      }), context), 404, "RESOURCE_NOT_FOUND");
      assert.equal((await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId, subjectId: deletedSubject }
      }), context)).status, 404);

      const missingOfferDelete = await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId, subjectId: deletedSubject }
      }), context);
      assertProblemResponse(missingOfferDelete, 404, "RESOURCE_NOT_FOUND");
      const absentValidOfferDelete = await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId, subjectId: await insertSubject(database) }
      }), context);
      assert.equal(absentValidOfferDelete.status, 204);

      const activeClass = await insertClass(database);
      const activeSubject = await insertSubject(database);
      assert.equal((await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context)).status, 204);
      const [activeOffer] = await database("turma_disciplina")
        .where({ id_turma: activeClass, id_materia: activeSubject }).select("id_turma_disciplina");
      const teacherId = await insertProfessor(database);
      await database("turma_disciplina_professor").insert({
        id_turma_disciplina: activeOffer.id_turma_disciplina,
        id_usuario_professor: teacherId
      });
      const unconfirmed = await insertSimulation(database, activeClass, { date: "1999-01-01" });
      await insertSimulationSubject(database, unconfirmed, activeClass, activeSubject);
      const removed = await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context);
      assert.equal(removed.status, 204);
      assert.equal(await database("turma_disciplina").where({ id_turma: activeClass, id_materia: activeSubject }).first(), undefined);
      assert.equal(await database("simulado_disciplina").where({ id_simulado: unconfirmed }).first(), undefined);
      assert.equal(await database("turma_disciplina_professor").where({
        id_turma_disciplina: activeOffer.id_turma_disciplina
      }).first(), undefined);
      assert.equal(await database("professor").where({ id_usuario: teacherId }).first() !== undefined, true);
      assert.equal(await database("simulado").where({ id_simulado: unconfirmed }).first() !== undefined, true);
      assert.equal((await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context)).status, 204);
      const [readdedOffer] = await database("turma_disciplina")
        .where({ id_turma: activeClass, id_materia: activeSubject }).select("id_turma_disciplina");
      assert.equal(await database("turma_disciplina_professor").where({
        id_turma_disciplina: readdedOffer.id_turma_disciplina,
        id_usuario_professor: teacherId
      }).first(), undefined);
      assert.equal((await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context)).status, 204);
      assert.equal((await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context)).status, 204);

      const cancelledClass = await insertClass(database);
      const cancelledSubject = await insertSubject(database);
      await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: cancelledClass, subjectId: cancelledSubject }
      }), context);
      const cancelledSimulation = await insertSimulation(database, cancelledClass, { cancelled: true });
      await insertSimulationSubject(database, cancelledSimulation, cancelledClass, cancelledSubject);
      assert.equal((await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: cancelledClass, subjectId: cancelledSubject }
      }), context)).status, 204);
      assert.equal(await database("simulado").where({ id_simulado: cancelledSimulation }).first() !== undefined, true);
      assert.equal(await database("simulado_disciplina").where({ id_simulado: cancelledSimulation }).first(), undefined);

      const completedClass = await insertClass(database);
      const completedSubject = await insertSubject(database);
      await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: completedClass, subjectId: completedSubject }
      }), context);
      const completedSimulation = await insertSimulation(database, completedClass, {
        confirmed: true, cancelled: true, date: "2099-12-31"
      });
      await insertSimulationSubject(database, completedSimulation, completedClass, completedSubject);
      const completedBlocked = await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: completedClass, subjectId: completedSubject }
      }), context);
      assertProblemResponse(completedBlocked, 409, "SUBJECT_HAS_COMPLETED_SIMULATIONS");
      assert.equal(await database("turma_disciplina").where({
        id_turma: completedClass, id_materia: completedSubject
      }).first() !== undefined, true);
      assert.equal(await database("simulado_disciplina").where({ id_simulado: completedSimulation }).first() !== undefined, true);

      const resultClass = await insertClass(database);
      const resultSubject = await insertSubject(database);
      await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: resultClass, subjectId: resultSubject }
      }), context);
      const resultSimulation = await insertSimulation(database, resultClass, { date: "1999-01-01" });
      await insertSimulationSubject(database, resultSimulation, resultClass, resultSubject);
      const resultStudentId = await insertStudent(database);
      await database("simulado_aluno").insert({
        id_simulado: resultSimulation,
        id_usuario_aluno: resultStudentId
      });
      await database("resultado").insert({
        id_simulado: resultSimulation,
        id_usuario_aluno: resultStudentId,
        id_turma: resultClass,
        id_materia: resultSubject,
        estado: "pendente",
        acertos: null
      });
      const resultBlocked = await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: resultClass, subjectId: resultSubject }
      }), context);
      assertProblemResponse(resultBlocked, 409, "SUBJECT_HAS_SIMULATION_RESULTS");
      assert.equal(await database("resultado").where({ id_simulado: resultSimulation }).first() !== undefined, true);
      assert.equal(await database("simulado_disciplina").where({ id_simulado: resultSimulation }).first() !== undefined, true);
      assert.equal(await database("turma_disciplina").where({
        id_turma: resultClass, id_materia: resultSubject
      }).first() !== undefined, true);

      const rollbackClass = await insertClass(database);
      const rollbackSubject = await insertSubject(database);
      await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: rollbackClass, subjectId: rollbackSubject }
      }), context);
      const rollbackOffer = await database("turma_disciplina")
        .where({ id_turma: rollbackClass, id_materia: rollbackSubject }).first("id_turma_disciplina");
      const rollbackTeacher = await insertProfessor(database);
      await database("turma_disciplina_professor").insert({
        id_turma_disciplina: rollbackOffer.id_turma_disciplina,
        id_usuario_professor: rollbackTeacher
      });
      const rollbackSimulation = await insertSimulation(database, rollbackClass);
      await insertSimulationSubject(database, rollbackSimulation, rollbackClass, rollbackSubject);
      await database.raw(`
        CREATE FUNCTION phase02_fail_offer_delete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'synthetic phase02 private failure';
        END;
        $$;
        CREATE TRIGGER phase02_fail_offer_delete_trg
          BEFORE DELETE ON turma_disciplina
          FOR EACH ROW EXECUTE FUNCTION phase02_fail_offer_delete();
      `);
      let rollbackResponse;
      try {
        rollbackResponse = await handlers.removeClassSubject(accountRequest("DELETE", {
          cookie: adminToken, params: { classId: rollbackClass, subjectId: rollbackSubject }
        }), context);
      } finally {
        await database.raw("DROP TRIGGER phase02_fail_offer_delete_trg ON turma_disciplina");
        await database.raw("DROP FUNCTION phase02_fail_offer_delete()");
      }
      assertProblemResponse(rollbackResponse, 500, undefined);
      assert.equal(JSON.stringify(rollbackResponse).includes("synthetic phase02 private failure"), false);
      assert.equal(await database("turma_disciplina").where({
        id_turma: rollbackClass, id_materia: rollbackSubject
      }).first() !== undefined, true);
      assert.equal(await database("simulado_disciplina").where({ id_simulado: rollbackSimulation }).first() !== undefined, true);
      assert.equal(await database("turma_disciplina_professor").where({
        id_turma_disciplina: rollbackOffer.id_turma_disciplina,
        id_usuario_professor: rollbackTeacher
      }).first() !== undefined, true);

      const raceClass = await insertClass(database);
      const raceSubject = await insertSubject(database);
      await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: raceClass, subjectId: raceSubject }
      }), context);
      const raceSimulation = await insertSimulation(database, raceClass);
      await insertSimulationSubject(database, raceSimulation, raceClass, raceSubject);
      const raceStudentId = await insertStudent(database);
      await database("simulado_aluno").insert({ id_simulado: raceSimulation, id_usuario_aluno: raceStudentId });
      const workerApplication = `phase02-offer-worker-${process.pid}`;
      const blocker = makeKnex({
        ...connectionFromEnvironment(generatedDatabase),
        application_name: `phase02-offer-blocker-${process.pid}`
      });
      const worker = makeKnex({ ...targetConnection, application_name: workerApplication });
      let releaseBlocker;
      let signalLocked;
      const locked = new Promise((resolve) => { signalLocked = resolve; });
      const continueBlocker = new Promise((resolve) => { releaseBlocker = resolve; });
      const blockerTransaction = database.transaction(async (transaction) => {
        await transaction("simulado").where({ id_simulado: raceSimulation }).forUpdate().first();
        await transaction("simulado_disciplina")
          .where({ id_simulado: raceSimulation, id_turma: raceClass, id_materia: raceSubject })
          .forUpdate()
          .first();
        signalLocked();
        await continueBlocker;
        await transaction("resultado").insert({
          id_simulado: raceSimulation,
          id_usuario_aluno: raceStudentId,
          id_turma: raceClass,
          id_materia: raceSubject,
          estado: "pendente",
          acertos: null
        });
      });
      try {
        await locked;
        const workerHandlers = adminClassHandlers(worker);
        const pendingRemoval = workerHandlers.removeClassSubject(accountRequest("DELETE", {
          cookie: adminToken, params: { classId: raceClass, subjectId: raceSubject }
        }), context);
        await waitForLockWait(blocker, workerApplication);
        releaseBlocker();
        await blockerTransaction;
        const racedRemoval = await pendingRemoval;
        assertProblemResponse(racedRemoval, 409, "SUBJECT_HAS_SIMULATION_RESULTS");
        assert.equal(await database("resultado").where({ id_simulado: raceSimulation }).first() !== undefined, true);
        assert.equal(await database("turma_disciplina").where({
          id_turma: raceClass, id_materia: raceSubject
        }).first() !== undefined, true);
      } finally {
        releaseBlocker();
        await blockerTransaction.catch(() => undefined);
        await Promise.all([blocker.destroy(), worker.destroy()]);
      }

      const records = logs.map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.event === "admin_class_subject_add" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_class_subject_remove" && record.result === "completed"));
      assert.ok(records.some((record) => record.event === "admin_class_subject_remove" && record.result === "failed"));
      assert.ok(records.some((record) => record.event === "admin_class_subject_remove" && record.result === "rejected"));
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), ["durationMs", "event", "invocationId", "result"]);
      }
      assert.equal(JSON.stringify(records).includes("synthetic phase02 private failure"), false);
      assert.equal(JSON.stringify(records).includes(`Phase02 Offer ${process.pid}`), false);
      assert.equal((await handlers.addClassSubject(accountRequest("PUT", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context)).status, 204);
      const [teacherOffer] = await database("turma_disciplina")
        .where({ id_turma: activeClass, id_materia: activeSubject }).select("id_turma_disciplina");
      assert.equal((await accountHandlers.addClassSubjectTeacher(accountRequest("PUT", {
        cookie: adminToken,
        params: { classId: activeClass, subjectId: activeSubject, teacherId }
      }), context)).status, 204);
      assert.equal((await handlers.removeClassSubject(accountRequest("DELETE", {
        cookie: adminToken, params: { classId: activeClass, subjectId: activeSubject }
      }), context)).status, 204);
      assert.equal(await database("turma_disciplina_professor").where({
        id_turma_disciplina: teacherOffer.id_turma_disciplina
      }).first(), undefined);
      assert.equal(await database("professor").where({ id_usuario: teacherId }).first() !== undefined, true);
    });

    await t.test("class lifecycle migration is forward-only and fails closed when class rows exist", async () => {
      const columns = await database.raw(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'turma'
          AND column_name IN ('excluido_em', 'inicio_em', 'fechada_em', 'version', 'subjects_version')
        ORDER BY column_name
      `);
      assert.deepEqual(columns.rows, [
        {
          column_name: "fechada_em",
          data_type: "timestamp with time zone",
          is_nullable: "YES",
          column_default: null
        },
        {
          column_name: "inicio_em",
          data_type: "date",
          is_nullable: "NO",
          column_default: null
        },
        {
          column_name: "subjects_version",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "1"
        },
        {
          column_name: "version",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "1"
        }
      ]);

      const teacherVersion = await database.raw(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'turma_disciplina'
          AND column_name = 'teachers_version'
      `);
      assert.deepEqual(teacherVersion.rows, [{
        data_type: "integer", is_nullable: "NO", column_default: "1"
      }]);

      const classUnique = await database.raw(`
        SELECT pg_get_constraintdef(oid, true) AS definition
        FROM pg_constraint
        WHERE conrelid = 'turma'::regclass AND conname = 'turma_serie_ano_uk'
      `);
      assert.equal(classUnique.rows.length, 1);
      assert.match(classUnique.rows[0].definition, /UNIQUE \(serie, ano_letivo\)/i);
      const oldIndex = await database.raw(`
        SELECT 1 FROM pg_class WHERE relname = 'turma_serie_ano_ativa_uk'
      `);
      assert.equal(oldIndex.rows.length, 0);

      const migration = require("../migrations/202610120001_class_lifecycle_and_versions.js");
      await database.transaction(async (transaction) => {
        await transaction.raw(`
          CREATE TEMP TABLE turma (
            id_turma BIGINT,
            serie INTEGER,
            ano_letivo INTEGER,
            excluido_em TIMESTAMPTZ
          ) ON COMMIT DROP
        `);
        await transaction.raw("INSERT INTO turma VALUES (7, 1, 2026, NULL)");
        await assert.rejects(migration.up(transaction), /requires an empty turma table/);
        const preserved = await transaction("turma").first();
        assert.equal(String(preserved.id_turma), "7");
        assert.equal(preserved.excluido_em, null);
        const startColumn = await transaction.raw(`
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = (
            SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()
          ) AND table_name = 'turma' AND column_name = 'inicio_em'
        `);
        assert.equal(startColumn.rows.length, 0);
      });
      await assert.rejects(migration.down(), /forward-only/);
    });
    await t.test("creates precisely the 16 approved domain tables", async () => {
      const result = await database.raw(`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')
        ORDER BY tablename
      `);
      assert.deepEqual(result.rows.map((row) => row.tablename), EXPECTED_DOMAIN_TABLES);
    });

    await t.test("reset-quota migration adds the approved columns and nonnegative counter constraint", async () => {
      const columns = await database.raw(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'usuario'
          AND column_name IN ('contador_pedidos_redefinicao', 'inicio_janela_redefinicao')
        ORDER BY column_name
      `);
      assert.deepEqual(columns.rows, [
        {
          column_name: "contador_pedidos_redefinicao",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "0"
        },
        {
          column_name: "inicio_janela_redefinicao",
          data_type: "timestamp with time zone",
          is_nullable: "YES",
          column_default: null
        }
      ]);

      const constraintName = "usuario_contador_pedidos_redefinicao_ck";
      const constraints = await database.raw(`
        SELECT attribute.attname AS column_name,
               pg_get_constraintdef(constraint_row.oid, true) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
        JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
        JOIN LATERAL unnest(constraint_row.conkey) AS constrained_column(attnum) ON true
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = table_row.oid
         AND attribute.attnum = constrained_column.attnum
        WHERE schema_row.nspname = current_schema()
          AND table_row.relname = 'usuario'
          AND constraint_row.contype = 'c'
          AND constraint_row.conname = ?
        ORDER BY attribute.attnum
      `, [constraintName]);
      assert.equal(constraints.rows.length, 1);
      assert.equal(constraints.rows[0].column_name, "contador_pedidos_redefinicao");
      assert.match(
        constraints.rows[0].definition,
        /^CHECK \(\(?contador_pedidos_redefinicao >= 0\)?\)$/
      );

      let fixtureId;
      try {
        fixtureId = await insertUser(database, {
          profile: "administrador",
          email: newIdentity("negative-reset-counter")
        });
        await assert.rejects(
          database("usuario")
            .where({ id_usuario: fixtureId })
            .update({ contador_pedidos_redefinicao: -1 }),
          (error) => error.code === "23514" && error.constraint === constraintName
        );
        const fixture = await database("usuario")
          .where({ id_usuario: fixtureId })
          .first("contador_pedidos_redefinicao");
        assert.equal(fixture.contador_pedidos_redefinicao, 0);
      } finally {
        if (fixtureId !== undefined) {
          const deleted = await database("usuario").where({ id_usuario: fixtureId }).delete();
          assert.equal(deleted, 1);
        }
      }
    });

    await t.test("serializes concurrent initial-admin seed attempts and stores only a password hash", async () => {
      const firstPassword = "synthetic-first-password";
      const secondPassword = "synthetic-second-password";
      const raceEmails = [newIdentity("initial-admin-one"), newIdentity("initial-admin-two")];
      const previousActiveAdmins = await database("usuario")
        .select("id_usuario", "ativado_em")
        .where({ tipo_perfil: "administrador" })
        .whereNotNull("ativado_em")
        .whereNull("excluido_em");

      try {
        if (previousActiveAdmins.length > 0) {
          await database("usuario")
            .whereIn("id_usuario", previousActiveAdmins.map((administrator) => administrator.id_usuario))
            .update({ ativado_em: null });
        }
        const activeAdminsBeforeRace = await database("usuario")
          .select("id_usuario")
          .where({ tipo_perfil: "administrador" })
          .whereNotNull("ativado_em")
          .whereNull("excluido_em");
        assert.equal(activeAdminsBeforeRace.length, 0);

        const pids = await Promise.all([
          database.raw("SELECT pg_backend_pid() AS pid"),
          secondConnection.raw("SELECT pg_backend_pid() AS pid")
        ]);
        assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid);

        const outcomes = await Promise.allSettled([
          createInitialAdmin({
            knex: database,
            name: "Synthetic Administrator One",
            email: raceEmails[0],
            password: firstPassword
          }),
          createInitialAdmin({
            knex: secondConnection,
            name: "Synthetic Administrator Two",
            email: raceEmails[1],
            password: secondPassword
          })
        ]);

        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
        const rejected = outcomes.find((result) => result.status === "rejected");
        assert.equal(rejected.reason.code, "ACTIVE_ADMIN_EXISTS");
        assert.equal(outcomes.find((result) => result.status === "fulfilled").value, undefined);
        const administrators = await database("usuario")
          .select("email_institucional", "hash_senha")
          .where({ tipo_perfil: "administrador" })
          .whereNotNull("ativado_em")
          .whereNull("excluido_em");
        assert.equal(administrators.length, 1);
        assert.ok(raceEmails.includes(administrators[0].email_institucional));
        const persistedRaceAttempts = await database("usuario")
          .select("email_institucional", "hash_senha")
          .whereIn("email_institucional", raceEmails);
        assert.equal(persistedRaceAttempts.length, 1);
        assert.deepEqual(persistedRaceAttempts[0], administrators[0]);
        assert.notEqual(administrators[0].hash_senha, firstPassword);
        assert.notEqual(administrators[0].hash_senha, secondPassword);
        assert.equal(
          await argon2.verify(administrators[0].hash_senha, firstPassword)
          || await argon2.verify(administrators[0].hash_senha, secondPassword),
          true
        );

        await assert.rejects(
          createInitialAdmin({
            knex: database,
            name: "Synthetic Duplicate Administrator",
            email: newIdentity("duplicate-admin"),
            password: "synthetic-not-persisted"
          }),
          (error) => error && error.code === "ACTIVE_ADMIN_EXISTS"
        );
        await assert.rejects(
          createInitialAdmin({ knex: database, name: " ", email: "invalid", password: "x" }),
          /name is invalid/
        );
      } finally {
        await database("usuario").whereIn("email_institucional", raceEmails).del();
        for (const administrator of previousActiveAdmins) {
          await database("usuario").where({ id_usuario: administrator.id_usuario }).update({
            ativado_em: administrator.ativado_em
          });
        }
      }
    });

    await t.test("enforces deferred profile consistency and physical constraints", async () => {
      const studentId = await insertStudent(database);
      const professorId = await insertProfessor(database);
      const classId = await insertClass(database, { series: 1, schoolYear: 2026 });
      const subjectId = (await database("materia").insert({ nome: "Matemática" }).returning("id_materia"))[0].id_materia;
      const offerId = (await database("turma_disciplina").insert({ id_turma: classId, id_materia: subjectId }).returning("id_turma_disciplina"))[0].id_turma_disciplina;

      await database("turma_disciplina_professor").insert({
        id_turma_disciplina: offerId,
        id_usuario_professor: professorId
      });
      await database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: "2026-01-01"
      });

      await expectPgCode(database("turma").insert({
        serie: 4, ano_letivo: 2026, inicio_em: database.raw("CURRENT_DATE - 1")
      }), "23514");
      await expectPgCode(database("turma").insert({
        serie: 1, ano_letivo: 2026, inicio_em: database.raw("CURRENT_DATE - 1")
      }), "23505");
      await expectPgCode(database("materia").insert({ nome: "  matemática " }), "23505");
      await expectPgCode(database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: "2026-02-01"
      }), "23505");
      await expectPgCode(database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: "2026-03-01",
        fim_vigencia: "2026-03-01"
      }), "23514");

      await expectPgCode(database("usuario").insert({
        tipo_perfil: "aluno",
        nome_completo: "Synthetic Missing Profile",
        email_institucional: newIdentity("missing-profile")
      }), "23514");
      await expectPgCode(database.transaction(async (transaction) => {
        const id = await insertUser(transaction, {
          profile: "professor",
          email: newIdentity("mismatched-profile")
        });
        await transaction("aluno").insert({ id_usuario: id, telefone_responsavel: "+5511999990000" });
      }), (error) => ["23503", "23514"].includes(error.code));

      const transferSourceId = await insertStudent(database, newIdentity("transfer-source"));
      const transferTargetId = await database.transaction((transaction) => insertUser(transaction, {
        profile: "administrador",
        email: newIdentity("transfer-target")
      }));
      await expectPgCode(database.transaction(async (transaction) => {
        await transaction("usuario").where({ id_usuario: transferTargetId }).update({ tipo_perfil: "aluno" });
        await transaction("aluno").where({ id_usuario: transferSourceId }).update({ id_usuario: transferTargetId });
      }), (error) => error.code === "23514" && error.constraint === "usuario_profile_integrity_ck");
      const sourceProfile = await database("usuario")
        .where({ id_usuario: transferSourceId })
        .first("tipo_perfil");
      const sourceExtension = await database("aluno")
        .where({ id_usuario: transferSourceId })
        .first("id_usuario");
      assert.equal(sourceProfile.tipo_perfil, "aluno");
      assert.equal(sourceExtension.id_usuario, transferSourceId);

      await expectPgCode(database("aluno").insert({
        id_usuario: studentId,
        telefone_responsavel: "   "
      }), "23514");
      await expectPgCode(database("turma_disciplina_professor").insert({
        id_turma_disciplina: offerId,
        id_usuario_professor: professorId
      }), "23505");

      await expectPgCode(database("sessao").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(31),
        expira_em: "2026-01-01T00:00:00Z",
        expira_absoluta_em: "2026-02-01T00:00:00Z"
      }), "23514");
      await expectPgCode(database("foto_perfil").insert({
        id_usuario: studentId,
        chave_objeto: "synthetic-key",
        tipo_midia: "image/gif",
        tamanho_bytes: 10
      }), "23514");
      await expectPgCode(database("foto_perfil").insert({
        id_usuario: studentId,
        chave_objeto: "synthetic-key-too-large",
        tipo_midia: "image/png",
        tamanho_bytes: 5242881
      }), "23514");
      await database("foto_perfil").insert({
        id_usuario: studentId,
        chave_objeto: "synthetic-photo-key",
        tipo_midia: "image/jpeg",
        tamanho_bytes: 2048
      });
      await database("foto_perfil").where({ id_usuario: studentId }).update({
        chave_objeto: "synthetic-photo-key-replaced",
        atualizada_em: "2000-01-01T00:00:00Z"
      });
      const updatedPhoto = await database("foto_perfil").where({ id_usuario: studentId }).first("atualizada_em");
      assert.notEqual(new Date(updatedPhoto.atualizada_em).toISOString(), "2000-01-01T00:00:00.000Z");

      const activationHash = Buffer.alloc(32, 1);
      await database("token_ativacao").insert({
        id_usuario: studentId,
        hash_token_sha256: activationHash,
        expira_em: "2026-12-01T00:00:00Z"
      });
      await expectPgCode(database("token_ativacao").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(32, 2),
        expira_em: "2026-12-02T00:00:00Z"
      }), "23505");
      await expectPgCode(database("token_redefinicao_senha").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(31, 3),
        expira_em: "2026-12-01T00:00:00Z"
      }), "23514");

      await expectPgCode(database("sessao").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(32, 4),
        expira_em: "2026-03-01T00:00:00Z",
        expira_absoluta_em: "2026-02-01T00:00:00Z"
      }), "23514");
    });

    await t.test("enforces email uniqueness across all current and pending write paths", async () => {
      const currentEmail = newIdentity("email-current");
      const pendingEmail = newIdentity("email-pending");
      const existingId = await database.transaction((transaction) => insertUser(transaction, {
        email: currentEmail,
        pendingEmail
      }));

      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Duplicate Current",
        email_institucional: currentEmail
      }), "23505");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Current Matches Pending",
        email_institucional: pendingEmail
      }), "23505");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Pending Matches Current",
        email_institucional: newIdentity("other-current-a"),
        email_pendente: currentEmail
      }), "23505");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Pending Matches Pending",
        email_institucional: newIdentity("other-current-b"),
        email_pendente: pendingEmail
      }), "23505");
      const sameRowEmail = newIdentity("same-row");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Same Row Address Conflict",
        email_institucional: sameRowEmail,
        email_pendente: sameRowEmail
      }), "23505");

      const currentUpdateId = await database.transaction((transaction) => insertUser(transaction, {
        email: newIdentity("current-update")
      }));
      await expectPgCode(database("usuario").where({ id_usuario: currentUpdateId }).update({
        email_institucional: pendingEmail
      }), "23505");

      const pendingUpdateId = await database.transaction((transaction) => insertUser(transaction, {
        email: newIdentity("pending-update-current"),
        pendingEmail: newIdentity("pending-update")
      }));
      await expectPgCode(database("usuario").where({ id_usuario: pendingUpdateId }).update({
        email_pendente: currentEmail
      }), "23505");

      await expectPgCode(database("usuario").where({ id_usuario: existingId }).update({
        email_pendente: currentEmail
      }), "23505");
    });

    await t.test("rejects racing current-versus-pending email writes on separate connections", async () => {
      let readyCount = 0;
      let releaseGate;
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      const backendPids = [];
      const raceEmail = newIdentity("concurrent-email");

      const runInsert = (connection, values) => connection.transaction(async (transaction) => {
        const backend = await transaction.raw("SELECT pg_backend_pid() AS pid");
        backendPids.push(backend.rows[0].pid);
        readyCount += 1;
        if (readyCount === 2) releaseGate();
        await gate;
        await transaction("usuario").insert({
          tipo_perfil: "administrador",
          nome_completo: "Synthetic Concurrent Writer",
          ...values
        });
      });

      const outcomes = await Promise.allSettled([
        runInsert(database, { email_institucional: raceEmail }),
        runInsert(secondConnection, {
          email_institucional: newIdentity("concurrent-other"),
          email_pendente: raceEmail
        })
      ]);
      assert.equal(new Set(backendPids).size, 2);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
      assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "23505");
    });

    await t.test("enforces simulation and result constraints and composite references", async () => {
      const studentId = await insertStudent(database);
      const classId = await insertClass(database, { series: 2, schoolYear: 2027 });
      const subjectId = (await database("materia").insert({ nome: "Ciências" }).returning("id_materia"))[0].id_materia;
      await database("turma_disciplina").insert({ id_turma: classId, id_materia: subjectId });
      const simulationId = (await database("simulado").insert({
        id_turma: classId,
        numero: 1,
        tipo: "objetivo",
        bimestre: 1,
        data_realizacao: "2026-04-15"
      }).returning("id_simulado"))[0].id_simulado;
      await database("simulado_disciplina").insert({
        id_simulado: simulationId,
        id_turma: classId,
        id_materia: subjectId,
        total_questoes: 10,
        peso: "0.5000"
      });
      await expectPgCode(database("simulado").insert({
        id_turma: classId,
        numero: 1,
        tipo: "objetivo",
        bimestre: 1,
        data_realizacao: "2026-04-20"
      }), "23505");
      await expectPgCode(database("simulado").insert({
        id_turma: classId,
        numero: 2,
        tipo: "invalido",
        bimestre: 1,
        data_realizacao: "2026-04-20"
      }), "23514");
      await database("simulado_aluno").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId
      });
      await expectPgCode(database("simulado_aluno").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId
      }), "23505");

      await expectPgCode(database("simulado_disciplina").insert({
        id_simulado: simulationId,
        id_turma: classId,
        id_materia: subjectId,
        total_questoes: 0,
        peso: "0.5000"
      }), "23514");
      await expectPgCode(database("simulado_disciplina").insert({
        id_simulado: simulationId,
        id_turma: classId,
        id_materia: subjectId,
        total_questoes: 10,
        peso: "1.0001"
      }), "23514");
      await expectPgCode(database("simulado_aluno").insert({
        id_simulado: simulationId,
        id_usuario_aluno: "9223372036854775807"
      }), "23503");

      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "avaliado"
      }), "23514");
      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "ausente",
        acertos: 0
      }), "23514");
      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "avaliado",
        acertos: -1
      }), "23514");
      await database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "avaliado",
        acertos: 0
      });
      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: "9223372036854775807"
      }), "23503");
    });

  } finally {
    if (secondConnection) {
      await secondConnection.destroy().catch(() => {});
    }
    if (database) {
      await database.destroy().catch(() => {});
    }
    if (maintenanceClient && databaseCreated && generatedDatabase) {
      await maintenanceClient.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [generatedDatabase]
      ).catch(() => {});
      await maintenanceClient.query(`DROP DATABASE "${generatedDatabase}"`).catch(() => {});
    }
    if (maintenanceClient) {
      await maintenanceClient.end().catch(() => {});
    }
  }
});

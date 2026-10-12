"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { PassThrough, Writable } = require("node:stream");
const path = require("node:path");
const { test } = require("node:test");
const argon2 = require("argon2");
const { isLoopbackHost } = require("../src/database/local-only.cjs");
const {
  ADMIN_EMAIL_PROMPT,
  ADMIN_PASSWORD_PROMPT,
  createInitialAdmin,
  normalizeAdminInput,
  runSeedCommand
} = require("../seed/admin.cjs");

const repository = path.resolve(__dirname, "..");

function makeInteractiveTerminal(responses) {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModeChanges = [];
  input.setRawMode = (enabled) => {
    input.rawModeChanges.push(enabled);
    return input;
  };

  const stdout = [];
  const stderr = [];
  const prompts = [
    "Administrator full name: ",
    ADMIN_EMAIL_PROMPT,
    ADMIN_PASSWORD_PROMPT
  ];
  const answered = new Set();
  let outputSoFar = "";
  const output = new Writable({
    write(chunk, encoding, callback) {
      const text = chunk.toString();
      stdout.push(text);
      outputSoFar += text;
      for (const prompt of prompts) {
        if (!answered.has(prompt) && outputSoFar.includes(prompt)) {
          answered.add(prompt);
          setImmediate(() => responses[prompt](input));
        }
      }
      callback();
    }
  });
  output.isTTY = true;

  const errorOutput = new Writable({
    write(chunk, encoding, callback) {
      stderr.push(chunk.toString());
      callback();
    }
  });

  return { input, output, errorOutput, stdout, stderr };
}

function makeSyntheticKnex() {
  let inserted;
  let transactionCalls = 0;
  const query = {
    select() { return this; },
    where() { return this; },
    whereNotNull() { return this; },
    whereNull() { return this; },
    async first() { return null; },
    async insert(row) { inserted = row; }
  };
  const transaction = Object.assign((table) => {
    assert.equal(table, "usuario");
    return query;
  }, { raw: async () => undefined });

  return {
    client: { config: { connection: { host: "127.0.0.1" } } },
    transaction: async (callback) => {
      transactionCalls += 1;
      return callback(transaction);
    },
    get inserted() { return inserted; },
    get transactionCalls() { return transactionCalls; }
  };
}

function assertNoSecretOutput(terminal, secrets) {
  const stdout = terminal.stdout.join("");
  const stderr = terminal.stderr.join("");
  const commandMessages = [...terminal.stdout, ...terminal.stderr];
  for (const secret of secrets.filter(Boolean)) {
    assert.equal(stdout.includes(secret), false, "secret appeared in stdout");
    assert.equal(stderr.includes(secret), false, "secret appeared in stderr");
    assert.equal(commandMessages.some((message) => message.includes(secret)), false,
      "secret appeared in a command message");
  }
}

test("local database commands accept loopback hosts and reject remote hosts", () => {
  for (const host of ["127.0.0.1", "127.42.0.9", "::1", "[::1]", "0:0:0:0:0:0:0:1", "localhost", "localhost."]) {
    assert.equal(isLoopbackHost(host), true, `${host} should be accepted`);
  }
  for (const host of ["192.168.1.10", "10.0.0.5", "db.example.test", "localhost.example.test", "", null]) {
    assert.equal(isLoopbackHost(host), false, `${host} should be rejected`);
  }

  const result = spawnSync(process.execPath, ["-e", "require('./knexfile.cjs')"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PGHOST: "db.example.test" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loopback PostgreSQL hosts/);
});

test("each Knex down handler fails before performing schema changes", async () => {
  const migrations = [
    require("../migrations/202610080001_accounts_and_identity.js"),
    require("../migrations/202610080002_academic_domain.js"),
    require("../migrations/202610080003_assessments_and_results.js")
  ];

  for (const migration of migrations) {
    await assert.rejects(migration.down(), /forward-only/);
  }
});

test("migration and seed entry points reject non-loopback hosts before database writes", async () => {
  const migrationPaths = [
    "../migrations/202610080001_accounts_and_identity.js",
    "../migrations/202610080002_academic_domain.js",
    "../migrations/202610080003_assessments_and_results.js"
  ];
  for (const migrationPath of migrationPaths) {
    const migration = require(migrationPath);
    let rawCalled = false;
    await assert.rejects(migration.up({
      client: { config: { connection: { host: "db.example.test" } } },
      raw: async () => { rawCalled = true; }
    }), /loopback PostgreSQL hosts/);
    assert.equal(rawCalled, false);
  }

  let transactionCalled = false;
  await assert.rejects(createInitialAdmin({
    knex: {
      client: { config: { connection: { host: "db.example.test" } } },
      transaction: async () => { transactionCalled = true; }
    },
    name: "Synthetic Administrator",
    email: "admin@example.test",
    password: "synthetic-only-test-password"
  }), /loopback PostgreSQL hosts/);
  assert.equal(transactionCalled, false);
});

test("seed email and password limits match the existing API policy", () => {
  const email254 = `a@${"x".repeat(63)}.${"y".repeat(63)}.${"z".repeat(63)}.${"w".repeat(60)}`;
  const email255 = `a@${"x".repeat(63)}.${"y".repeat(63)}.${"z".repeat(63)}.${"w".repeat(61)}`;
  assert.equal(email254.length, 254);
  assert.equal(email255.length, 255);

  const normalized = normalizeAdminInput({
    name: " Synthetic Administrator ",
    email: ` ${email254.toUpperCase()} `,
    password: " ".repeat(15)
  });
  assert.equal(normalized.name, "Synthetic Administrator");
  assert.equal(normalized.email, email254.toLowerCase());
  assert.equal(normalized.password.length, 15);
  assert.equal(normalizeAdminInput({
    name: "Synthetic Administrator",
    email: " Seed.User@Example.Test ",
    password: "☃".repeat(1024)
  }).password.length, 1024);

  for (const invalidEmail of [email255, "not-an-email"]) {
    assert.throws(() => normalizeAdminInput({
      name: "Synthetic Administrator",
      email: invalidEmail,
      password: "synthetic-valid-password"
    }), /email is invalid/);
  }
  for (const invalidPassword of ["x".repeat(14), "x".repeat(1025)]) {
    assert.throws(() => normalizeAdminInput({
      name: "Synthetic Administrator",
      email: "admin@example.test",
      password: invalidPassword
    }), /password is invalid/);
  }
});

test("invalid seed inputs are rejected before password hashing or database transaction", async () => {
  const database = makeSyntheticKnex();
  const originalHash = argon2.hash;
  let hashCalls = 0;
  argon2.hash = async (...arguments_) => {
    hashCalls += 1;
    return originalHash(...arguments_);
  };

  try {
    await assert.rejects(createInitialAdmin({
      knex: database,
      name: "Synthetic Administrator",
      email: "invalid-email",
      password: "synthetic-valid-password"
    }), /email is invalid/);
    await assert.rejects(createInitialAdmin({
      knex: database,
      name: "Synthetic Administrator",
      email: "admin@example.test",
      password: "too-short"
    }), /password is invalid/);
  } finally {
    argon2.hash = originalHash;
  }

  assert.equal(hashCalls, 0);
  assert.equal(database.transactionCalls, 0);
  assert.equal(database.inserted, undefined);
});

test("interactive seed command keeps password and hash out of output on success", async () => {
  const password = "synthetic-success-password";
  const terminal = makeInteractiveTerminal({
    "Administrator full name: ": (input) => input.write("Synthetic Administrator\n"),
    [ADMIN_EMAIL_PROMPT]: (input) => input.write("seed-success@example.test\n"),
    [ADMIN_PASSWORD_PROMPT]: (input) => input.write(`${password}\r`)
  });
  const database = makeSyntheticKnex();

  assert.equal(await runSeedCommand({ ...terminal, database }), 0);
  assert.match(terminal.stdout.join(""), /Initial administrator created/);
  assert.equal(terminal.stderr.join(""), "");
  assert.equal(await argon2.verify(database.inserted.hash_senha, password), true);
  assert.deepEqual(terminal.input.rawModeChanges.slice(-2), [true, false]);
  assertNoSecretOutput(terminal, [password, database.inserted.hash_senha]);
  assert.match(terminal.stdout.join(""), /up to 254 characters/);
  assert.match(terminal.stdout.join(""), /15-1024 characters/);
  assert.match(terminal.stdout.join(""), /no composition rule; spaces and Unicode are allowed/);
});

test("interactive seed command keeps password out of output when validation fails", async () => {
  const password = "synthetic-validation-password";
  const terminal = makeInteractiveTerminal({
    "Administrator full name: ": (input) => input.write("Synthetic Administrator\n"),
    [ADMIN_EMAIL_PROMPT]: (input) => input.write("invalid-email\n"),
    [ADMIN_PASSWORD_PROMPT]: (input) => input.write(`${password}\r`)
  });
  const database = makeSyntheticKnex();

  assert.equal(await runSeedCommand({ ...terminal, database }), 1);
  assert.equal(database.inserted, undefined);
  assert.match(terminal.stderr.join(""), /Seed failed/);
  assert.deepEqual(terminal.input.rawModeChanges.slice(-2), [true, false]);
  assertNoSecretOutput(terminal, [password]);
});

test("interactive seed command keeps partial password input out of output on cancellation", async () => {
  const passwordPrefix = "synthetic-canceled-password";
  const terminal = makeInteractiveTerminal({
    "Administrator full name: ": (input) => input.write("Synthetic Administrator\n"),
    [ADMIN_EMAIL_PROMPT]: (input) => input.write("seed-cancel@example.test\n"),
    [ADMIN_PASSWORD_PROMPT]: (input) => {
      input.write(passwordPrefix);
      setImmediate(() => input.write("\x03"));
    }
  });
  const database = makeSyntheticKnex();

  assert.equal(await runSeedCommand({ ...terminal, database }), 1);
  assert.equal(database.inserted, undefined);
  assert.match(terminal.stderr.join(""), /Seed failed/);
  assert.deepEqual(terminal.input.rawModeChanges.slice(-2), [true, false]);
  assertNoSecretOutput(terminal, [passwordPrefix]);
});

test("Argon2id hashing uses the approved PHC parameters", async () => {
  const syntheticPassword = "synthetic-only-test-password";
  const passwordHash = await argon2.hash(syntheticPassword, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1
  });

  assert.match(passwordHash, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  assert.notEqual(passwordHash, syntheticPassword);
  assert.equal(await argon2.verify(passwordHash, syntheticPassword), true);
});

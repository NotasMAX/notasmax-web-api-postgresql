"use strict";

const { createInterface } = require("node:readline");
const { emitKeypressEvents } = require("node:readline");
const argon2 = require("argon2");
const knexFactory = require("knex");
const { z } = require("zod");
const { assertLoopbackHost } = require("../src/database/local-only.cjs");

const ADMIN_SEED_LOCK = [324001, 1];
const ADMIN_EMAIL_PROMPT = "Administrator email (valid format, up to 254 characters; surrounding spaces are trimmed and the address is lowercased): ";
const ADMIN_PASSWORD_PROMPT = "Administrator password (15-1024 characters; no composition rule; spaces and Unicode are allowed): ";
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(15).max(1024);

function normalizeAdminInput({ name, email, password }) {
  if (typeof name !== "string") {
    throw new Error("Administrator name is required.");
  }
  const normalizedName = name.trim();
  if (normalizedName.length === 0 || Array.from(normalizedName).length > 255) {
    throw new Error("Administrator name is invalid.");
  }

  const normalizedEmail = emailSchema.safeParse(email);
  if (!normalizedEmail.success) {
    throw new Error("Administrator email is invalid.");
  }

  const validatedPassword = passwordSchema.safeParse(password);
  if (!validatedPassword.success) {
    throw new Error("Administrator password is invalid.");
  }

  return { name: normalizedName, email: normalizedEmail.data, password: validatedPassword.data };
}

async function createInitialAdmin({ knex, name, email, password }) {
  if (!knex || typeof knex.transaction !== "function") {
    throw new Error("A PostgreSQL connection is required.");
  }
  assertLoopbackHost(knex.client && knex.client.config && knex.client.config.connection
    ? knex.client.config.connection.host
    : undefined);
  const normalized = normalizeAdminInput({ name, email, password });
  const passwordHash = await argon2.hash(normalized.password, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1
  });

  await knex.transaction(async (transaction) => {
    await transaction.raw("SELECT pg_advisory_xact_lock(?, ?)", ADMIN_SEED_LOCK);

    const activeAdministrator = await transaction("usuario")
      .select("id_usuario")
      .where({ tipo_perfil: "administrador" })
      .whereNotNull("ativado_em")
      .whereNull("excluido_em")
      .first();

    if (activeAdministrator) {
      const error = new Error("An active administrator already exists.");
      error.code = "ACTIVE_ADMIN_EXISTS";
      throw error;
    }

    await transaction("usuario").insert({
      tipo_perfil: "administrador",
      nome_completo: normalized.name,
      email_institucional: normalized.email,
      hash_senha: passwordHash,
      ativado_em: transaction.raw("CURRENT_TIMESTAMP")
    });
  });
}

function readVisible(prompt, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readHidden(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("A terminal is required for hidden password input."));
  }

  emitKeypressEvents(input);
  output.write(prompt);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Password prompt was canceled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (typeof character === "string" && character.length > 0 && !key.ctrl && !key.meta) {
        value += character;
      }
    };
    input.on("keypress", onKeypress);
  });
}

async function runSeed({
  input = process.stdin,
  output = process.stdout,
  database: injectedDatabase
} = {}) {
  const knexConfig = require("../knexfile.cjs").development;
  assertLoopbackHost(knexConfig.connection.host);
  if (!input.isTTY || !output.isTTY) {
    throw new Error("A local interactive terminal is required.");
  }

  const name = await readVisible("Administrator full name: ", { input, output });
  const email = await readVisible(ADMIN_EMAIL_PROMPT, { input, output });
  let password = await readHidden(ADMIN_PASSWORD_PROMPT, { input, output });
  const database = injectedDatabase || knexFactory(knexConfig);
  try {
    await createInitialAdmin({ knex: database, name, email, password });
    output.write("Initial administrator created.\n");
  } finally {
    password = ""; // eslint-disable-line no-useless-assignment -- release the local password reference after use
    if (!injectedDatabase) await database.destroy();
  }
}

async function runSeedCommand(options = {}) {
  const errorOutput = options.errorOutput || process.stderr;
  try {
    await runSeed(options);
    return 0;
  } catch (error) {
    errorOutput.write(error && error.code === "ACTIVE_ADMIN_EXISTS"
      ? "An active administrator already exists; no account was created.\n"
      : "Seed failed. Check the local PostgreSQL connection and the provided inputs.\n");
    return 1;
  }
}

if (require.main === module) {
  runSeedCommand().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  ADMIN_EMAIL_PROMPT,
  ADMIN_PASSWORD_PROMPT,
  createInitialAdmin,
  normalizeAdminInput,
  readHidden,
  runSeedCommand
};

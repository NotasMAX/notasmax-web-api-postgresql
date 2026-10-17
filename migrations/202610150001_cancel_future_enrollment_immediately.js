"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  await knex.raw(`
    DROP INDEX matricula_aluno_aberta_uk;
    CREATE UNIQUE INDEX matricula_aluno_aberta_uk
      ON matricula (id_usuario_aluno)
      WHERE fim_vigencia IS NULL AND cancelada_em IS NULL;
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};

"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  await knex.raw(`
    ALTER TABLE turma
      ADD COLUMN excluido_em TIMESTAMPTZ;

    ALTER TABLE turma
      DROP CONSTRAINT turma_serie_ano_uk;

    CREATE UNIQUE INDEX turma_serie_ano_ativa_uk
      ON turma (serie, ano_letivo)
      WHERE excluido_em IS NULL;
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};

"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  const preflight = await knex.raw(`
    SELECT
      count(*)::bigint AS row_count,
      count(*) FILTER (WHERE excluido_em IS NOT NULL)::bigint AS excluded_count
    FROM turma
  `);
  const counts = preflight.rows[0];
  if (BigInt(counts.row_count) !== 0n || BigInt(counts.excluded_count) !== 0n) {
    throw new Error("Class lifecycle migration requires an empty turma table; no dates or state were backfilled.");
  }

  await knex.raw(`
    DROP INDEX turma_serie_ano_ativa_uk;
    ALTER TABLE turma DROP COLUMN excluido_em;
    ALTER TABLE turma ADD COLUMN inicio_em DATE NOT NULL;
    ALTER TABLE turma ADD COLUMN fechada_em TIMESTAMPTZ;
    ALTER TABLE turma ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
    ALTER TABLE turma ADD COLUMN subjects_version INTEGER NOT NULL DEFAULT 1 CHECK (subjects_version > 0);
    ALTER TABLE turma ADD CONSTRAINT turma_serie_ano_uk UNIQUE (serie, ano_letivo);
    ALTER TABLE turma_disciplina ADD COLUMN teachers_version INTEGER NOT NULL DEFAULT 1
      CHECK (teachers_version > 0);
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};

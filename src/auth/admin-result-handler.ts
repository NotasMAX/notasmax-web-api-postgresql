import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { ifMatchProblem, readIfMatch } from "../http/etag";
import { withSecurityEvent } from "../http/security-event";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import { authenticationRequired, configuredOrigins, internalFailure, mutationRejection, requireAdminSession, resourceNotFound } from "./handler";
import { getResult, listResults, updateResult } from "./admin-result-service";
import { AdminSessionRevokedError } from "./session-service";

const maxId = 9223372036854775807n;
const id = z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= maxId);
const positive = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().safe().positive());
const classSimulation = z.strictObject({ classId: id, simulationId: id });
const resultPath = classSimulation.extend({ studentId: id, subjectId: id });
const querySchema = z.strictObject({ page: positive.optional().transform((v) => v ?? 1),
  pageSize: positive.pipe(z.number().int().max(100)).optional().transform((v) => v ?? 20),
  subjectId: id.optional(), status: z.enum(["pending", "assessed", "absent"]).optional(), search: z.string().trim().min(1).max(120).optional() });
const bodySchema = z.strictObject({ status: z.enum(["pending", "assessed", "absent"]),
  correctAnswers: z.number().int().nonnegative().optional() }).refine((value) =>
  (value.status === "assessed") === (value.correctAnswers !== undefined));
type RequestHandler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
function mutationProblem(status: string): HttpResponseInit | undefined {
  if (status === "not-found") return resourceNotFound();
  if (status === "stale") return ifMatchProblem("stale");
  if (status === "score-out-of-range") return createProblemResponse({ status: 422, title: "Conteúdo não processável",
    code: "VALIDATION_ERROR", detail: "O conteúdo enviado não atende aos critérios de validação.", errors: [{ code: "VALUE_OUT_OF_RANGE",
      detail: "O valor está fora do intervalo permitido.", source: { in: "body", pointer: "/correctAnswers" } }], headers: { "cache-control": "no-store" } });
  if (status === "invalid-transition") return createProblemResponse({ status: 409, title: "Conflito com o estado do resultado",
    detail: "A transição solicitada não é permitida para o estado atual do resultado.", headers: { "cache-control": "no-store" } });
  if (status === "not-realized") return createProblemResponse({ status: 409, title: "Simulado não confirmado",
    detail: "Os resultados só estão disponíveis após a confirmação da realização.", headers: { "cache-control": "no-store" } });
  return undefined;
}
export function createAdminResultHandlers(options: { getDatabase?: () => Knex; allowedOrigins?: readonly string[] } = {}) {
  const getDatabase = options.getDatabase ?? getKnex;
  const origins = options.allowedOrigins ?? configuredOrigins();
  const list: RequestHandler = async (request) => {
    const route = validateInput(classSimulation, request.params, { in: "path" }); if (!route.success) return route.response;
    const filters = validateInput(querySchema, request.query, { in: "query" }); if (!filters.success) return filters.response;
    const auth = await requireAdminSession(request, getDatabase); if (!auth.authorized) return auth.response;
    try { const results = await listResults(getDatabase(), route.data.classId, route.data.simulationId, filters.data);
      return results ? { status: 200, headers: { "cache-control": "no-store" }, jsonBody: results } : resourceNotFound();
    } catch { return internalFailure(); }
  };
  const get: RequestHandler = async (request) => {
    const route = validateInput(resultPath, request.params, { in: "path" }); if (!route.success) return route.response;
    const auth = await requireAdminSession(request, getDatabase); if (!auth.authorized) return auth.response;
    try { const result = await getResult(getDatabase(), route.data.classId, route.data.simulationId, route.data.studentId, route.data.subjectId);
      return result ? { status: 200, headers: { "cache-control": "no-store", etag: result.etag }, jsonBody: result.result } : resourceNotFound();
    } catch { return internalFailure(); }
  };
  const patch: RequestHandler = withSecurityEvent("admin_result_update", async (request) => {
    const rejected = mutationRejection(request, origins); if (rejected) return rejected;
    const route = validateInput(resultPath, request.params, { in: "path" }); if (!route.success) return route.response;
    let body; try { body = await validateJsonBody(request, bodySchema); } catch { return internalFailure(); }
    if (!body.success) return body.response;
    const auth = await requireAdminSession(request, getDatabase); if (!auth.authorized) return auth.response;
    const precondition = readIfMatch(request); if (precondition.status !== "ok") return ifMatchProblem(precondition.status);
    try { const result = await updateResult(getDatabase(), route.data.classId, route.data.simulationId,
      route.data.studentId, route.data.subjectId, body.data.status, body.data.correctAnswers,
      precondition.value, { actorId: auth.user.id, token: auth.token });
      const problem = mutationProblem(result.status); if (problem) return problem;
      if (result.status !== "ok") return internalFailure();
      return { status: 200, headers: { "cache-control": "no-store", etag: result.etag }, jsonBody: result.result };
    } catch (error) { return error instanceof AdminSessionRevokedError ? authenticationRequired() : internalFailure(); }
  });
  return { list, get, patch };
}

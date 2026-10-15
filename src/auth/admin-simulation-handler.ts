import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { etagExposureHeaders } from "../http/cors";
import { ifMatchProblem, readIfMatch } from "../http/etag";
import { withSecurityEvent } from "../http/security-event";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import { authenticationRequired, configuredOrigins, internalFailure, mutationRejection, requireAdminSession, resourceNotFound } from "./handler";
import { confirmSimulation, createSimulation, deleteSimulation, getSimulation, listSimulations, updateSimulation,
  type SimulationInput, type SimulationPatch, type SimulationQuery } from "./admin-simulation-service";

const MAX_BODY_BYTES = 16 * 1024;
const maxId = 9223372036854775807n;
const id = z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= maxId);
const positive = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().safe().positive());
const classPath = z.strictObject({ classId: id });
const itemPath = classPath.extend({ simulationId: id });
const subject = z.strictObject({
  subjectId: id,
  totalQuestions: z.number().int().positive().max(2147483647),
  weightPercent: z.number().positive().max(100).multipleOf(0.01)
});
const inputSchema = z.strictObject({
  type: z.enum(["objetivo", "dissertativo"]),
  bimester: z.number().int().min(1).max(4),
  scheduledDate: z.iso.date(),
  subjects: z.array(subject).min(1)
});
const patchSchema = z.strictObject({
  type: z.enum(["objetivo", "dissertativo"]).optional(),
  bimester: z.number().int().min(1).max(4).optional(),
  scheduledDate: z.iso.date().optional(),
  subjects: z.array(subject).min(1).optional()
}).refine((value) => Object.keys(value).length > 0);
const querySchema = z.strictObject({
  page: positive.optional().transform((value) => value ?? 1),
  pageSize: positive.pipe(z.number().int().max(100)).optional().transform((value) => value ?? 20),
  bimester: z.string().regex(/^[1-4]$/).transform(Number).optional(),
  type: z.enum(["objetivo", "dissertativo"]).optional(),
  subjectId: id.optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional()
}).refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate);
type RequestHandler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
function conflict(detail: string, code?: string): HttpResponseInit {
  return createProblemResponse({ status: 409, title: "Não foi possível alterar o simulado", ...(code ? { code } : {}), detail,
    headers: { "cache-control": "no-store" } });
}
function mutationResult(status: string): HttpResponseInit | undefined {
  if (status === "not-found") return resourceNotFound();
  if (status === "class-closed") return conflict("A operação não pode ser concluída porque a turma está fechada.", "CLASS_CLOSED");
  if (status === "stale") return ifMatchProblem("stale");
  if (status === "invalid-subjects") return conflict("Escolha matérias disponíveis para esta turma.");
  if (status === "weight-exceeded") return conflict("A soma dos pesos da matéria no bimestre não pode ultrapassar 100%.");
  if (status === "realized") return conflict("O simulado já teve a realização confirmada.");
  if (status === "has-linked-answers") return conflict("Este simulado não pode ser removido porque já foi realizado ou tem resultados registrados.", "SIMULATION_HAS_LINKED_ANSWERS");
  return undefined;
}
export type AdminSimulationHandlerOptions = { getDatabase?: () => Knex; allowedOrigins?: readonly string[] };
export function createAdminSimulationHandlers(options: AdminSimulationHandlerOptions = {}): {
  list: RequestHandler; get: RequestHandler; create: RequestHandler; update: RequestHandler; confirm: RequestHandler; remove: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const origins = options.allowedOrigins ?? configuredOrigins();
  const list: RequestHandler = async (request) => {
    const route = validateInput(classPath, request.params, { in: "path" });
    if (!route.success) return route.response;
    const filters = validateInput(querySchema, request.query, { in: "query" });
    if (!filters.success) return filters.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    try {
      const result = await listSimulations(getDatabase(), route.data.classId, filters.data as SimulationQuery);
      return result ? { status: 200, headers: { "cache-control": "no-store" }, jsonBody: result } : resourceNotFound();
    } catch { return internalFailure(); }
  };
  const get: RequestHandler = async (request) => {
    const route = validateInput(itemPath, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    try {
      const result = await getSimulation(getDatabase(), route.data.classId, route.data.simulationId);
      return result ? { status: 200, headers: { "cache-control": "no-store", etag: result.etag,
        ...etagExposureHeaders(request.headers.get("origin"), origins) }, jsonBody: result.simulation } : resourceNotFound();
    } catch { return internalFailure(); }
  };
  const create: RequestHandler = withSecurityEvent("admin_simulation_create", async (request) => {
    const rejected = mutationRejection(request, origins); if (rejected) return rejected;
    const route = validateInput(classPath, request.params, { in: "path" }); if (!route.success) return route.response;
    let body; try { body = await validateJsonBody(request, inputSchema, { maxBytes: MAX_BODY_BYTES }); } catch { return internalFailure(); }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase); if (!authorized.authorized) return authorized.response;
    try {
      const result = await createSimulation(getDatabase(), route.data.classId, body.data as SimulationInput,
        { actorId: authorized.user.id, token: authorized.token });
      const problem = mutationResult(result.status); if (problem) return problem;
      if (result.status !== "created") return internalFailure();
      return { status: 201, headers: { "cache-control": "no-store", etag: result.etag,
        ...etagExposureHeaders(request.headers.get("origin"), origins) }, jsonBody: result.simulation };
    } catch (error) { return error instanceof Error && error.name === "AdminSessionRevokedError" ? authenticationRequired() : internalFailure(); }
  });
  const update: RequestHandler = withSecurityEvent("admin_simulation_update", async (request) => {
    const rejected = mutationRejection(request, origins); if (rejected) return rejected;
    const route = validateInput(itemPath, request.params, { in: "path" }); if (!route.success) return route.response;
    let body; try { body = await validateJsonBody(request, patchSchema, { maxBytes: MAX_BODY_BYTES }); } catch { return internalFailure(); }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase); if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request); if (precondition.status !== "ok") return ifMatchProblem(precondition.status);
    try {
      const result = await updateSimulation(getDatabase(), route.data.classId, route.data.simulationId,
        body.data as SimulationPatch, precondition.value, { actorId: authorized.user.id, token: authorized.token });
      const problem = mutationResult(result.status); if (problem) return problem;
      if (result.status !== "ok") return internalFailure();
      return { status: 200, headers: { "cache-control": "no-store", etag: result.etag,
        ...etagExposureHeaders(request.headers.get("origin"), origins) }, jsonBody: result.simulation };
    } catch (error) { return error instanceof Error && error.name === "AdminSessionRevokedError" ? authenticationRequired() : internalFailure(); }
  });
  const confirm: RequestHandler = withSecurityEvent("admin_simulation_confirm", async (request) => {
    const rejected = mutationRejection(request, origins); if (rejected) return rejected;
    const route = validateInput(itemPath, request.params, { in: "path" }); if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase); if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request); if (precondition.status !== "ok") return ifMatchProblem(precondition.status);
    try {
      const result = await confirmSimulation(getDatabase(), route.data.classId, route.data.simulationId,
        precondition.value, { actorId: authorized.user.id, token: authorized.token });
      const problem = mutationResult(result.status); if (problem) return problem;
      if (result.status !== "ok") return internalFailure();
      return { status: 200, headers: { "cache-control": "no-store", etag: result.etag,
        ...etagExposureHeaders(request.headers.get("origin"), origins) }, jsonBody: result.simulation };
    } catch (error) { return error instanceof Error && error.name === "AdminSessionRevokedError" ? authenticationRequired() : internalFailure(); }
  });
  const remove: RequestHandler = withSecurityEvent("admin_simulation_delete", async (request) => {
    const rejected = mutationRejection(request, origins); if (rejected) return rejected;
    const route = validateInput(itemPath, request.params, { in: "path" }); if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase); if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request); if (precondition.status !== "ok") return ifMatchProblem(precondition.status);
    try {
      const result = await deleteSimulation(getDatabase(), route.data.classId, route.data.simulationId,
        precondition.value, { actorId: authorized.user.id, token: authorized.token });
      const problem = mutationResult(result.status); if (problem) return problem;
      return result.status === "deleted" ? { status: 204, headers: { "cache-control": "no-store" } } : internalFailure();
    } catch (error) { return error instanceof Error && error.name === "AdminSessionRevokedError" ? authenticationRequired() : internalFailure(); }
  });
  return { list, get, create, update, confirm, remove };
}

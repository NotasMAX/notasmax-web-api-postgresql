import { app } from "@azure/functions";
import { createAdminSimulationHandlers } from "../auth/admin-simulation-handler";

const handlers = createAdminSimulationHandlers();
const root = "v1/admin/classes/{classId}/simulations";
app.http("adminSimulationsList", { methods: ["GET"], authLevel: "anonymous", route: root, handler: handlers.list });
app.http("adminSimulationCreate", { methods: ["POST"], authLevel: "anonymous", route: root, handler: handlers.create });
app.http("adminSimulationDetail", { methods: ["GET"], authLevel: "anonymous", route: `${root}/{simulationId}`, handler: handlers.get });
app.http("adminSimulationUpdate", { methods: ["PATCH"], authLevel: "anonymous", route: `${root}/{simulationId}`, handler: handlers.update });
app.http("adminSimulationConfirm", { methods: ["POST"], authLevel: "anonymous", route: `${root}/{simulationId}/realizations`, handler: handlers.confirm });
app.http("adminSimulationDelete", { methods: ["DELETE"], authLevel: "anonymous", route: `${root}/{simulationId}`, handler: handlers.remove });

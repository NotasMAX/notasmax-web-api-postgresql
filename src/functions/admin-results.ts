import { app } from "@azure/functions";
import { createAdminResultHandlers } from "../auth/admin-result-handler";

const handlers = createAdminResultHandlers();
const root = "v1/admin/classes/{classId}/simulations/{simulationId}/results";
app.http("adminResultsList", { methods: ["GET"], authLevel: "anonymous", route: root, handler: handlers.list });
app.http("adminResultDetail", { methods: ["GET"], authLevel: "anonymous", route: `${root}/{studentId}/{subjectId}`, handler: handlers.get });
app.http("adminResultUpdate", { methods: ["PATCH"], authLevel: "anonymous", route: `${root}/{studentId}/{subjectId}`, handler: handlers.patch });

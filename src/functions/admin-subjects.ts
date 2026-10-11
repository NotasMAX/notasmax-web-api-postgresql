import { app } from "@azure/functions";
import { createAdminSubjectHandlers } from "../auth/admin-subject-handler";

const handlers = createAdminSubjectHandlers();

app.http("adminSubjectsList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/subjects",
  handler: handlers.listSubjects
});

app.http("adminSubjectsCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/subjects",
  handler: handlers.createSubject
});

app.http("adminSubjectUpdate", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "v1/admin/subjects/{subjectId}",
  handler: handlers.updateSubject
});

app.http("adminSubjectDelete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/admin/subjects/{subjectId}",
  handler: handlers.deleteSubject
});

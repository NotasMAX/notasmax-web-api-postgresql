import { app } from "@azure/functions";
import { createAdminClassHandlers } from "../auth/admin-class-handler";

const handlers = createAdminClassHandlers();

app.http("adminClassesList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/classes",
  handler: handlers.listClasses
});

app.http("adminClassesYears", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/classes/years",
  handler: handlers.listClassYears
});

app.http("adminClassDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}",
  handler: handlers.getClass
});

app.http("adminClassesCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/classes",
  handler: handlers.createClass
});

app.http("adminClassUpdate", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}",
  handler: handlers.updateClass
});

app.http("adminClassDelete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}",
  handler: handlers.deleteClass
});

app.http("adminClassSubjectsList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}/subjects",
  handler: handlers.listClassSubjects
});

app.http("adminClassSubjectAdd", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}/subjects/{subjectId}",
  handler: handlers.addClassSubject
});

app.http("adminClassSubjectRemove", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}/subjects/{subjectId}",
  handler: handlers.removeClassSubject
});

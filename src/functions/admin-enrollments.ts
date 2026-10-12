import { app } from "@azure/functions";
import { createAdminEnrollmentHandlers } from "../auth/admin-enrollment-handler";

const handlers = createAdminEnrollmentHandlers();

app.http("adminClassEnrollmentCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/classes/{classId}/enrollments",
  handler: handlers.createEnrollment
});

app.http("adminEnrollmentCancel", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/enrollments/{enrollmentId}/cancellations",
  handler: handlers.cancelEnrollment
});

app.http("adminEnrollmentDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/enrollments/{enrollmentId}",
  handler: handlers.getEnrollment
});

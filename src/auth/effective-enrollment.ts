export type EffectiveEnrollmentDate = "CURRENT_DATE" | "?::date";

export function effectiveEnrollmentPredicate(
  alias: "m",
  effectiveDate: EffectiveEnrollmentDate = "CURRENT_DATE"
): string {
  return `${alias}.inicio_vigencia <= ${effectiveDate}
    AND (${alias}.fim_vigencia IS NULL OR ${alias}.fim_vigencia > ${effectiveDate})`;
}

export function enrollmentOverlapsFromDatePredicate(
  alias: "m",
  startDate: EffectiveEnrollmentDate = "CURRENT_DATE"
): string {
  return `(${alias}.fim_vigencia IS NULL OR ${alias}.fim_vigencia > ${startDate})`;
}

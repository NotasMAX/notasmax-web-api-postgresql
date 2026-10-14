export function etagExposureHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Record<string, string> {
  return origin !== null && allowedOrigins.includes(origin)
    ? { "access-control-expose-headers": "ETag" }
    : {};
}

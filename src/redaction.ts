export function redactCredentials(text: string): string {
  return text
    .replace(/\b(?:xoxe\.)?(?:xox[a-z]|xapp)-[\w.-]+/gi, "[REDACTED]")
    .replace(/\bBearer[ \t]+[a-z\d._~+/=-]+/gi, "Bearer [REDACTED]");
}

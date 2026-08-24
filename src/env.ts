export function resolveEnv(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.ENV,
    process.env.APP_ENV,
    process.env.NODE_ENV,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return "unknown";
}

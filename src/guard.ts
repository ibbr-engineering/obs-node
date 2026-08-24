import { FORBIDDEN_LABEL_KEYS, FORBIDDEN_VALUE_PATTERNS } from "./contract";

const warned = new Set<string>();

function warnOnce(key: string, reason: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[@ibbr-engineering/observability] dropped label "${key}": ${reason}. ` +
      `Metrics must not contain PHI (metrics-contract.yaml).`
  );
}

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_LABEL_KEYS.includes(key.toLowerCase());
}

export function isForbiddenValue(value: string): boolean {
  return FORBIDDEN_VALUE_PATTERNS.some((re) => re.test(value));
}

export function sanitizeLabels(
  labels: Record<string, string | number | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, raw] of Object.entries(labels)) {
    if (raw === undefined || raw === null) continue;

    if (isForbiddenKey(key)) {
      warnOnce(key, "label name is listed in forbidden_label_keys");
      continue;
    }

    const value = String(raw);
    if (isForbiddenValue(value)) {
      warnOnce(
        key,
        "value matches a PHI pattern (email, phone, or national identity number)"
      );
      continue;
    }

    out[key] = value;
  }

  return out;
}

export function resetWarnings(): void {
  warned.clear();
}

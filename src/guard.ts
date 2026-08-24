import { FORBIDDEN_LABEL_KEYS, FORBIDDEN_VALUE_PATTERNS } from './contract';

/**
 * Penegakan anti-PHI di sisi aplikasi.
 *
 * OTLP berjalan plaintext di dalam VPC (§2 blueprint), jadi jaminan bahwa
 * metrik bebas PHI harus datang dari sini — bukan dari enkripsi jaringan.
 *
 * Perilakunya sengaja "buang diam-diam, hitung keras": label yang melanggar
 * dibuang, tapi pelanggarannya dicatat sekali per kunci supaya ketahuan saat
 * development. Melempar exception bukan pilihan — instrumentasi tidak boleh
 * pernah menjatuhkan request produksi.
 */

const warned = new Set<string>();

function warnOnce(key: string, reason: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[@ibbr-engineering/observability] label "${key}" dibuang: ${reason}. ` +
      `Metrik tidak boleh membawa PHI (metrics-contract.yaml).`
  );
}

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_LABEL_KEYS.includes(key.toLowerCase());
}

export function isForbiddenValue(value: string): boolean {
  return FORBIDDEN_VALUE_PATTERNS.some((re) => re.test(value));
}

/** Buang pasangan label yang melanggar kontrak; kembalikan sisanya. */
export function sanitizeLabels(
  labels: Record<string, string | number | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, raw] of Object.entries(labels)) {
    if (raw === undefined || raw === null) continue;

    if (isForbiddenKey(key)) {
      warnOnce(key, 'nama label ada di forbidden_label_keys');
      continue;
    }

    const value = String(raw);
    if (isForbiddenValue(value)) {
      warnOnce(key, 'nilainya cocok pola PHI (email/telepon/NIK)');
      continue;
    }

    out[key] = value;
  }

  return out;
}

/** Hanya untuk test — supaya peringatan "sekali saja" bisa diuji berulang. */
export function resetWarnings(): void {
  warned.clear();
}

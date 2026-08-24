/**
 * Resolusi nama environment.
 *
 * Sebelum kontrak 1.4.0, `env` tidak pernah datang dari aplikasi: jalur
 * scrape mengambilnya dari label target di apps.yml, jalur push dari
 * processor transform/add-env di collector. Dua sumber berbeda untuk satu
 * label yang sama — dan aplikasi sendiri tidak pernah tahu env-nya.
 *
 * KENAPA TIDAK BOLEH MENGEMBALIKAN STRING KOSONG:
 * job `apps` di prometheus.yml memakai `honor_labels: true`, jadi label dari
 * aplikasi MENANG atas label target. Kalau library mengirim env="", ia
 * menimpa env="local" dari apps.yml dengan string kosong — dan setiap
 * dashboard yang memfilter `$env` mendadak kosong tanpa error apa pun.
 * "unknown" dipilih supaya kelalaian menyetel env terlihat di dashboard,
 * bukan menghilang diam-diam.
 */

export function resolveEnv(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.ENV,
    process.env.APP_ENV,
    process.env.NODE_ENV,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return 'unknown';
}

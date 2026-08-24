import * as fs from 'fs';
import * as path from 'path';

/**
 * Cari akar repo dengan menaiki direktori sampai menemukan contract/.
 * Dipakai supaya test tetap benar baik dijalankan dari src/ maupun dari
 * hasil kompilasi di dist-test/.
 */
export function repoRoot(from: string = __dirname): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'contract', 'metrics-contract.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`contract/metrics-contract.yaml tidak ditemukan dari ${from}`);
}

export function contractPath(): string {
  return path.join(repoRoot(), 'contract', 'metrics-contract.yaml');
}

export function goldenPath(): string {
  return path.join(repoRoot(), 'contract', 'golden', 'metrics.txt');
}

/**
 * Ubah teks eksposisi Prometheus jadi daftar "nama{label,label}" yang stabil.
 * Nilai sengaja dibuang — yang dikontrak adalah bentuk, bukan angkanya.
 */
export function shapeOf(exposition: string): string[] {
  const shapes = new Set<string>();

  for (const line of exposition.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const braceAt = trimmed.indexOf('{');
    if (braceAt === -1) {
      shapes.add(`${trimmed.split(/\s+/)[0]}{}`);
      continue;
    }

    const name = trimmed.slice(0, braceAt);
    const labelBlock = trimmed.slice(braceAt + 1, trimmed.lastIndexOf('}'));
    const keys = labelBlock
      .split(',')
      .map((pair) => pair.split('=')[0].trim())
      .filter(Boolean)
      .sort();
    shapes.add(`${name}{${keys.join(',')}}`);
  }

  return [...shapes].sort();
}

/** Respons palsu secukupnya untuk menjalankan middleware tanpa server HTTP. */
export function fakeRes(statusCode = 200): any {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    statusCode,
    on(event: string, fn: () => void) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    removeListener(event: string, fn: () => void) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      return this;
    },
    emit(event: string) {
      for (const fn of [...(listeners[event] ?? [])]) fn();
    },
  };
}

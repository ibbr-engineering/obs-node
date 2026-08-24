import * as path from 'path';

export function repoRoot(from: string = __dirname): string {
  return path.resolve(from, '..', '..');
}

export function contractPath(): string {
  return path.join(repoRoot(), 'contract', 'metrics-contract.yaml');
}

export function goldenPath(): string {
  return path.join(repoRoot(), 'contract', 'golden', 'metrics.txt');
}

/** Return stable Prometheus shapes without sample values. */
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

/** Return a minimal response double for middleware tests. */
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

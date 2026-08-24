import * as assert from 'assert';
import { test } from 'node:test';

import * as observability from '../src/index';

const baseConfig = {
  service: 'config-test',
  tier: 'T1' as const,
  defaultMetrics: false,
  logger: () => undefined,
};

function assertConfigError(config: Record<string, unknown>): void {
  assert.throws(
    () => observability.initObservability(config as any),
    (error: unknown) => {
      assert.strictEqual((error as Error).name, 'ObservabilityConfigError');
      return true;
    }
  );
}

test('config exports a typed public error', () => {
  assert.strictEqual(typeof (observability as any).ObservabilityConfigError, 'function');
});

test('config rejects blank service, unknown tier and unknown transport', () => {
  assertConfigError({ ...baseConfig, service: '   ' });
  assertConfigError({ ...baseConfig, tier: 'T4' });
  assertConfigError({ ...baseConfig, transport: 'sidecar' });
});

test('config rejects unsafe numeric limits', () => {
  assertConfigError({ ...baseConfig, maxRoutes: 1 });
  assertConfigError({ ...baseConfig, pushIntervalMs: 0 });
  assertConfigError({ ...baseConfig, pushIntervalMs: -1 });
});

test('config allows HTTP OTLP only for local collectors', () => {
  const local = observability.initObservability({
    ...baseConfig,
    transport: 'push',
    otlpEndpoint: 'http://localhost:4318',
    pushIntervalMs: 60_000,
  });
  local.shutdown();

  const endpoint = 'http://secret:token@collector.example.com:4318';
  assert.throws(
    () => observability.initObservability({ ...baseConfig, transport: 'push', otlpEndpoint: endpoint }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.strictEqual((error as Error).name, 'ObservabilityConfigError');
      assert.ok(!message.includes('secret'));
      assert.ok(!message.includes('token'));
      assert.ok(!message.includes('collector.example.com'));
      return true;
    }
  );
});

test('OTLP explicit push rejects while scheduled failure is logged', async () => {
  const explicit = observability.initObservability({
    ...baseConfig,
    transport: 'push',
    otlpEndpoint: 'http://127.0.0.1:1',
    pushIntervalMs: 60_000,
  });
  await assert.rejects(explicit.pushOnce());
  explicit.shutdown();
  explicit.shutdown();

  const events: Array<Record<string, unknown>> = [];
  const scheduled = observability.initObservability({
    ...baseConfig,
    transport: 'push',
    otlpEndpoint: 'http://127.0.0.1:1',
    pushIntervalMs: 5,
    logger: (event) => events.push(event),
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  scheduled.shutdown();
  scheduled.shutdown();
  assert.ok(events.some((event) => event.msg === 'obs.push.failed'));
});

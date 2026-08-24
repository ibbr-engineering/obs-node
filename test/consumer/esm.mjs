import assert from 'node:assert';
import { CONTRACT_VERSION, initObservability } from '@ibbr-engineering/observability';

const obs = initObservability({
  service: 'git-install-esm',
  tier: 'T1',
  version: 'consumer-test',
  defaultMetrics: false,
  logger: () => undefined,
});
const exposition = await obs.render();
assert.strictEqual(CONTRACT_VERSION, '1.5.0');
assert.match(exposition, /app_build_info\{/);
assert.match(exposition, /contract_version="1\.5\.0"/);
obs.shutdown();

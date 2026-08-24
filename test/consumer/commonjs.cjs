const assert = require('node:assert');
const { CONTRACT_VERSION, initObservability } = require('@ibbr-engineering/observability');

async function main() {
  const obs = initObservability({
    service: 'git-install-commonjs',
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

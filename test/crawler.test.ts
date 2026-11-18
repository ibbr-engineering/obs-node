import * as assert from 'assert';
import { it } from 'mocha';
import { initObservability } from '../src/index';
import { fakeRes } from './helpers';

it('only recognized crawler products label the request counter', async () => {
  const obs = initObservability({
    service: 'crawler-test',
    tier: 'T1',
    defaultMetrics: false,
    logger: () => undefined,
  });
  const measure = obs.middleware();
  try {
    for (const userAgent of [
      'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)',
      'meta-externalads/1.1',
      'Mozilla/5.0 (compatible; ADSBOT-Google-Mobile/1.0)',
      'Googlebot/2.1',
      'TikTokSpider/1.0',
      'Mozilla/5.0 (iPhone) Mobile/15E148thirdLandingPageFeInfra',
      'Mozilla/5.0 (Linux) TikTok/41.2 FBAN/FBIOS',
      'CustomNotGooglebot/1.0',
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0',
      undefined,
    ]) {
      const res = fakeRes(200);
      measure({ method: 'GET', url: '/promo', headers: { 'user-agent': userAgent } }, res, () => {});
      res.emit('finish');
    }
    const lines = (await obs.render()).split('\n');
    const requests = lines.filter((line) => line.startsWith('http_server_requests_total{'));
    assert.strictEqual(requests.length, 2);
    assert.match(requests.find((line) => line.includes('crawler="known"')) ?? '', / 6$/);
    assert.match(requests.find((line) => !line.includes('crawler=')) ?? '', / 4$/);
    assert.ok(lines.filter((line) => line.startsWith('http_server_duration_seconds')).every((line) => !line.includes('crawler=')));
  } finally {
    obs.shutdown();
  }
});

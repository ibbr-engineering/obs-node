import * as assert from 'assert';
import { test } from 'node:test';

import { resetWarnings, sanitizeLabels } from '../src/guard';

/**
 * Metrik berjalan plaintext di dalam VPC (§2), jadi test ini menjaga satu
 * jaminan: nilai identitas pasien secara struktural tidak bisa jadi label.
 */

test('label dengan nama terlarang dibuang', () => {
  resetWarnings();
  const out = sanitizeLabels({
    service: 'booking',
    patient_id: '507f1f77bcf86cd799439011',
    mrn: 'RM-00123',
    route: '/api/patients/:id',
  });
  assert.deepStrictEqual(out, { service: 'booking', route: '/api/patients/:id' });
});

test('nilai berpola PHI dibuang meski nama labelnya tampak aman', () => {
  resetWarnings();
  const out = sanitizeLabels({
    service: 'booking',
    // Nama label tidak ada di daftar terlarang — pola nilainya yang menangkap.
    contact: 'budi@example.com',
    reference: '+628123456789',
    identity: '3171234567890123',
    route: '/api/x',
  });
  assert.deepStrictEqual(out, { service: 'booking', route: '/api/x' });
});

test('nama label terlarang tidak peka huruf besar-kecil', () => {
  resetWarnings();
  assert.deepStrictEqual(sanitizeLabels({ Patient_ID: 'x', service: 's' }), { service: 's' });
});

test('undefined dan null dibuang, angka jadi string', () => {
  resetWarnings();
  assert.deepStrictEqual(
    sanitizeLabels({ service: 'x', status: 200, missing: undefined }),
    { service: 'x', status: '200' }
  );
});

test('nilai wajar tidak ikut terbuang', () => {
  resetWarnings();
  const labels = {
    service: 'fdc-booking-api',
    route: '/api/clinics/:slug/slots',
    method: 'GET',
    status_class: '2xx',
    version: '2.6.54',
  };
  assert.deepStrictEqual(sanitizeLabels(labels), labels);
});

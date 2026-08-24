/**
 * Identitas per-proses, dibangkitkan sekali saat modul di-load.
 *
 * Kenapa ini perlu ada (lihat CHANGELOG.md 1.3.0): jalur `push` (Cloud Run)
 * tidak punya analog dari label `instance` bawaan Prometheus — itu hanya
 * ditempelkan Prometheus sendiri saat scrape, berdasarkan alamat target.
 * Push tidak melalui scrape, jadi tanpa label buatan sendiri, semua replica
 * autoscale dari service yang sama mengirim metrik dengan label yang
 * IDENTIK. Prometheus tidak bisa membedakan mereka sebagai series terpisah
 * — rate()/increase() dihitung seolah satu proses, padahal ditulis beberapa
 * proses berbeda secara bersamaan.
 *
 * Sengaja dinamai `replica_id`, bukan `instance` — supaya tidak collide
 * dengan label `instance` yang sudah dipakai Prometheus sendiri di jalur
 * scrape (host:port target).
 *
 * Nilai: `<K_REVISION atau hostname>-<6 hex acak>`. Prefix untuk konteks
 * manusiawi (revisi Cloud Run mana, atau hostname VM/container mana);
 * suffix acak untuk menjamin keunikan per BOOT, bahkan kalau prefix-nya
 * sama (dua replica dari revisi yang sama, atau restart di hostname yang
 * sama). Efek samping yang diharapkan: restart proses melahirkan replica_id
 * baru, sehingga metrik pasca-restart menjadi series yang genuinely baru —
 * bukan menyambung series lama sebagai "counter reset" yang harus
 * direkonsiliasi histogram_quantile.
 */
import * as crypto from 'crypto';
import * as os from 'os';

function computeReplicaId(): string {
  const prefix = process.env.K_REVISION || os.hostname() || 'unknown';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${prefix}-${suffix}`;
}

export const REPLICA_ID = computeReplicaId();

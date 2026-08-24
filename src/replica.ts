import * as crypto from "crypto";
import * as os from "os";

function computeReplicaId(): string {
  const prefix = process.env.K_REVISION || os.hostname() || "unknown";
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${suffix}`;
}

export const REPLICA_ID = computeReplicaId();

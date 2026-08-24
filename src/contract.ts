export const CONTRACT_VERSION = "1.5.0";

export const METRIC = {
  requests: "http_server_requests_total",
  duration: "http_server_duration_seconds",
  inFlight: "http_server_requests_in_flight",
  responseBytes: "http_server_response_bytes_total",
  buildInfo: "app_build_info",
  routeCardinality: "obs_route_cardinality",
  routeOverflow: "obs_route_overflow_total",
  dependency: "dependency_duration_seconds",
} as const;

export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export const DEPENDENCY_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;

export const LABELS = {
  requests: [
    "service",
    "env",
    "method",
    "route",
    "status_class",
    "status",
    "replica_id",
  ],
  duration: ["service", "env", "method", "route", "status_class", "replica_id"],
  responseBytes: [
    "service",
    "env",
    "method",
    "route",
    "status_class",
    "replica_id",
  ],
  inFlight: ["service", "env", "replica_id"],
  buildInfo: [
    "service",
    "env",
    "version",
    "commit",
    "tier",
    "contract_version",
    "lang",
    "display_name",
    "description",
    "public",
    "replica_id",
  ],
  routeCardinality: ["service", "env", "replica_id"],
  routeOverflow: ["service", "env", "replica_id"],
  dependency: [
    "service",
    "env",
    "dependency",
    "operation",
    "outcome",
    "replica_id",
  ],
} as const;

export const MAX_ROUTES_PER_SERVICE = 40;
export const OVERFLOW_ROUTE = "__other__";

export const FORBIDDEN_LABEL_KEYS: readonly string[] = [
  "email",
  "phone",
  "nik",
  "patient_id",
  "mrn",
  "name",
  "address",
  "user_id",
  "session_id",
];

export const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /^\+?62[0-9]{8,13}$/,
  /^[0-9]{16}$/,
];

export type Tier = "T1" | "T2" | "T3";

export function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}

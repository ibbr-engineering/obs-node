# Changelog

All notable changes to this project are documented in this file. Releases use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-10-01

### Fixed

- OTLP pushes always settle when the collector resets mid-response; previously
  the pending request was retained forever.
- Repeated `initObservability()`/`shutdown()` no longer leaks the runtime
  collectors created by `collectDefaultMetrics` (now shared per process).
- `time()` caps distinct `(dependency, operation)` pairs (`maxDependencySeries`,
  default 200) instead of growing series without bound.
- LoopBack 4 and LoopBack 3 route matching prefers static segments, so
  `/api/x/count` is no longer labeled `/api/x/:id`; template literals are
  escaped and non-verb OpenAPI keys are ignored.
- Paths the router table does not match share a bounded budget
  (`maxUnmatchedRoutes`), so 404 scanners can no longer push real routes into
  `__other__`.
- Failures while recording a finished request are logged once
  (`obs.record.failed`) instead of escaping the response event.
- Subpath type declarations resolve under `moduleResolution: "node"` through
  `typesVersions`.

### Changed

- `shutdown()` returns a promise and performs a final push for `push`/`both`.
- OTLP bodies are gzip-compressed by default (`otlpCompression: "none"` to
  opt out); scheduled pushes never overlap.
- `method` labels outside the standard set are recorded as `OTHER`; PHI-shaped
  route templates are recorded as `__other__` instead of dropping the label.

### Performance

- Route lookup uses a segment trie (about 27 µs to 0.2 µs per request with 1,250
  LoopBack routes).
- Response bytes reuse the declared or Node-computed body length instead of
  re-measuring strings; label children are cached per series. Middleware cost
  drops from about 68 µs to 4 µs per request for a 200 KB response.
- Push collection yields between metrics (event-loop stall about 84 ms to
  26 ms for 1,800 series) and the payload shrinks about 99% with gzip.

## [1.1.1] - 2026-08-30

### Fixed

- Allow plain HTTP OTLP to private VPC addresses (RFC1918), matching the
  centralized collector deployed with Direct VPC egress.

## [1.1.0] - 2026-08-24

### Added

- Standalone Apache-2.0 repository installable from immutable Git tags.
- Vendored metrics-contract v1.5.0 and offline conformance checks.
- Express, LoopBack 3, and LoopBack 4 package entry points with declarations.
- CommonJS and ESM Git-install smoke coverage.
- Draft GitHub Release packaging with SHA-256 checksums.

### Changed

- Replaced registry publishing metadata with Git and release-tarball distribution.
- Added typed initialization errors and HTTPS enforcement for remote OTLP endpoints.

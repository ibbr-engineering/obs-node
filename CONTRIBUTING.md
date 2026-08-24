# Contributing

Use Node.js 16 or later and install the locked dependencies with `npm ci`.

Before submitting a change, run:

```bash
npm test
npm run typecheck
npm run build
npm run test:git-install
npm run pack:check
git diff --check
```

Public behavior changes require tests. Keep metric names, types, labels, and
buckets aligned with the vendored contract. Do not edit contract snapshots by
hand; sync an explicitly selected local source:

```bash
npm run contract:sync -- --source ../observability/contract
```

Contract changes require a matching platform contract version and changelog
entry. Never add raw paths, user identifiers, record identifiers, credentials,
or arbitrary application values to metric labels.

Use concise English comments only when a non-obvious constraint needs to be
preserved. Do not add registry publishing configuration, registry credentials,
publishing commands, or an unpinned branch-based production installation
example.

# Contributing

Thanks for helping. Contributions that add providers, engines or fixes are very welcome.

## Ground rules

- **Both languages move together.** A behaviour change lands in TypeScript and Python in the same PR, with shared fixtures in `contracts/fixtures/` that both test suites run.
- **No invented capabilities.** Base new protocol code on the provider's official docs, link the docs in the fixture `description`, and declare anything unverified as `requires_configuration` or `unsupported`.
- **Zero runtime dependencies in the core.** Heavy integrations (noise-suppression engines, provider SDKs) go in optional extras or separate packages.
- **No secrets, audio, transcripts or email addresses in logs or fixtures.**

## Development

```sh
# TypeScript (Node 20+)
cd packages/typescript && npm ci && npm run typecheck && npm test && npm run build

# Python (3.10+)
cd packages/python && uv sync && uv run pytest && uv run mypy
```

## Adding a provider

Follow [docs/ADAPTER_DEVELOPMENT.md](docs/ADAPTER_DEVELOPMENT.md):
1. Add session fixtures from the provider's docs.
2. Implement the adapter in both languages.
3. Run the conformance suite.
4. Update [docs/PROVIDER_COMPATIBILITY.md](docs/PROVIDER_COMPATIBILITY.md) with honest statuses.

## Pull requests

- Keep PRs focused, and describe what was verified and how.
- CI must be green: tests and typecheck in both languages, the examples, and packaging.
- Report security issues privately, never in public issues (see [docs/SECURITY.md](docs/SECURITY.md)).

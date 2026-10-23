# examples

| Example | Run |
|---|---|
| **Live call dashboard**: real-time UI driven by the actual toolkit code | `node examples/live-dashboard/server.mjs` then open http://localhost:4173 |
| End-to-end (TypeScript) | `node examples/typescript/end-to-end.mjs` |
| End-to-end (Python) | `cd packages/python && uv run python ../../examples/python/end_to_end.py` |

Build the TypeScript package first (`cd packages/typescript && npm ci && npm run build`).

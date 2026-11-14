# Nadhra engines

One JSON manifest per local engine, in `manifests/` (format and rules: `src/lib/server/engines/manifest.ts`).

**Empty on purpose (step N2).** No real engine or model is connected yet. Adding a manifest here doesn't make Nadhra
claim any ability: what Nadhra can do is declared separately, from benchmarks only
(`NADHRA_TASKS` in `src/lib/ai/router.ts`), and needs approval.

Rules enforced by the validator and by `tests/engines.test.ts`:
- a permissive licence (Apache-2.0, MIT, BSD, ISC, Zlib, Unlicense). Anything else needs `benchOnly: true`, and the launcher never loads such an engine;
- the measured peak RAM (`ramMB`), and the supported architectures (`x86_64`, `aarch64`);
- model files described by path, https URL, SHA-256 and size. They live outside the repo, in `NADHRA_MODEL_DIR`
  (default `~/.local/share/nadhra/models`), and the app never downloads them;
- the command is a program and its arguments, never a shell. The only placeholders are `{host}`, `{port}` and `{modelDir}`.

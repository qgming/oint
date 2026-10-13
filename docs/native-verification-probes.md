# Native verification probes

Run `npm run build` before the Electron UI probes so they exercise current main/preload/renderer bundles.

1.2.0 起 `npm run probe:kernel` 的首个检查是 **Chord host 运行时的真实往返**（memory 链路 + remote 契约 + facet + 方法调用），`npm run probe:packaged` 核对六个包（chord / pi-ai / pi-durable / pi-mcp / pi-codemode / pi-telemetry）的 1.2.0 版本与导入位置；插件链路（源码直载 + utilityProcess）由 `node scripts/probe-native-plugins.mjs` 覆盖（打包版加 `--packaged`，需先 `npm run pack`）。

`node scripts/probe-usage-stats.mjs` builds a small fixture helper, creates an isolated `sessions-v1` SQLite database through the app SessionStore and official Harness/UsageDoc APIs, and uses the production usage checkpoint/report projection. It generates 725 tokens: 650 dated and 75 without a retained date. It copies no user data and disables remote MCP presets in its temporary settings. The probe checks the preload report, dated heatmap/trends/donut, undated annotation, modal/navigation behavior, and stable totals after renderer reload. No separate usage accounting database is expected.

`node scripts/e2e-smoke.mjs` requires explicitly supplied `OINT_PROBE_API_KEY` (optional `OINT_PROBE_BASE_URL` and `OINT_PROBE_MODEL`). It is a live provider test and was **not run** during this verification because no model credentials were supplied. It reads committed `chat.snapshot(sessionId).state` for messages and running state, uses events only for approvals, and awaits the pending send after responding to the approval. It also checks message persistence and application restart.

Static verification performed: syntax checks for both scripts, strict TypeScript checking of the native fixture helper, production Vite build, and native usage/report/view tests. The live model test is separate from the credential-free statistics probe.

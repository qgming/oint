// Shared, credential-free checks for development and the packaged Electron runtime.
export async function probeKernel(load = (name) => import(name)) {
  const results = [];
  const check = async (name, run) => {
    try {
      results.push({ name, ok: true, detail: await run() });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error?.stack ?? error) });
    }
  };
  const fs = await load("node:fs/promises");
  const os = await load("node:os");
  const path = await load("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oint-pi1-probe-"));
  try {
    const { BACKGROUND_CONTEXT: context } = await load("@earendil-works/chord/context");
    const { Harness, createRegistry } = await load("@earendil-works/pi-durable");
    const { createModels } = await load("@earendil-works/pi-ai/models");
    await check("chord host runtime (contracts, links, facet loader)", async () => {
      const chord = await load("@earendil-works/chord");
      const node = await load("@earendil-works/chord/node");
      for (const api of [
        chord.createHost,
        chord.defineFacet,
        chord.remote,
        chord.method,
        chord.cell,
        chord.ipcLink,
        chord.memoryLinkPair,
        node.nodeLoader,
        node.createHostManager,
        node.forkDriver,
        node.childControl,
        node.processLock,
      ]) {
        if (typeof api !== "function") throw new Error("Missing official chord host runtime API");
      }
      const { Type } = await load("typebox");
      const contract = chord.remote("probe.echo", {
        version: 1,
        input: Type.Object({}),
        variants: {
          default: {
            state: { note: Type.String() },
            methods: {
              echo: chord.method(
                Type.Object({ text: Type.String() }),
                Type.Object({ text: Type.String() }),
              ),
            },
          },
        },
      });
      const [serverLink, clientLink] = chord.memoryLinkPair();
      const server = chord.createHost({ name: "probe-server" });
      const client = chord.createHost({ name: "probe-client", upstream: clientLink });
      server.accept(serverLink, { principal: { host: "probe" }, kind: "host", name: "probe-client" });
      const facet = chord.defineFacet((api) => {
        api.serve(
          contract,
          (_input, _principal, self) => {
            const state = self.state({ note: chord.cell(Type.String(), "ready") });
            return {
              kind: "default",
              note: state.note,
              echo: (args) => ({ text: `${args.text}:ack` }),
            };
          },
          { eager: true },
        );
      });
      try {
        await client.load([{ ...facet, name: "probe" }]);
        const handle = server.get(contract, {}, { at: "probe-client" });
        const result = await handle.echo({ text: "probe" });
        if (result.text !== "probe:ack") throw new Error(`RPC round trip failed: ${JSON.stringify(result)}`);
        if (handle.status !== "live") throw new Error(`Handle not live: ${handle.status}`);
      } finally {
        await server.close();
        await client.close();
      }
      return "host/accept/upstream + remote contract + facet round trip over a memory link";
    });
    await check("pi-ai model catalog", async () => {
      const all = await load("@earendil-works/pi-ai/providers/all");
      const providers = all.getBuiltinProviders();
      const models = providers.flatMap((provider) => all.getBuiltinModels(provider));
      if (providers.length === 0 || models.length === 0) throw new Error("Empty catalog");
      return `${providers.length} providers / ${models.length} chat models`;
    });
    await check("native filesystem API", async () => {
      const { NodeExecutionEnv } = await load("@earendil-works/pi-durable/env/node");
      const env = new NodeExecutionEnv({ cwd: dir });
      const file = path.join(dir, "lines.txt");
      for (const operation of [
        () => env.writeFile(file, "alpha\nbeta\n", context),
        () => env.truncateFile(file, 5, context),
        () => env.flushFile(file, context),
      ]) {
        const result = await operation();
        if (!result.ok) throw result.error;
      }
      const result = await env.readTextFile(file, context);
      if (!result.ok) throw result.error;
      if (result.value !== "alpha") throw new Error("Truncate failed");
      if (!env.id || typeof env.openTextLineReader !== "function") throw new Error("Missing API");
      return "id, file write/read/truncate/flush and line reader";
    });
    await check("durable SQLite commit, fork and reopen", async () => {
      const { openNodeSqliteStorage } = await load("@earendil-works/pi-durable/storage/sqlite/node");
      const file = path.join(dir, "session.sqlite");
      const options = { models: createModels(), registry: createRegistry() };
      let harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
      let rootId;
      let entryId;
      try {
        const root = await harness.root(context);
        rootId = root.id;
        const entry = await root.commit(
          (tx) => tx.appendEntry(root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "persisted pi 1.0", timestamp: 1 }],
          }),
          context,
        );
        entryId = entry.id;
        const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
        if (fork.id === root.id) throw new Error("Fork did not allocate a conversation");
      } finally {
        await harness.close(context);
      }
      harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
      try {
        const root = await harness.root(context);
        const entry = await root.commit((tx) => tx.entry(entryId), context);
        if (root.id !== rootId || entry?.model?.[0]?.content !== "persisted pi 1.0") {
          throw new Error("SQLite roundtrip lost the transcript");
        }
      } finally {
        await harness.close(context);
      }
      return "native SQLite and conversation fork survived close/reopen";
    });
    await check("pi-mcp native handshake, tool call and conversion", async () => {
      const { McpClient, toLlmContent } = await load("@earendil-works/pi-mcp");
      const { createInMemoryTransportPair } = await load("@earendil-works/pi-mcp/testing");
      const pair = createInMemoryTransportPair();
      pair.server.onMessage(async (message) => {
        if (message.id === undefined) return;
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] }
            : { content: [{ type: "text", text: "native MCP works" }] };
        await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
      });
      await pair.server.start();
      const client = new McpClient({ name: "oint-probe", version: "1", requestTimeoutMs: 5000 });
      try {
        await client.connect(pair.client);
        const tools = await client.listTools();
        const result = await client.callTool("echo", {});
        if (tools[0]?.name !== "echo" || toLlmContent(result)[0]?.text !== "native MCP works") {
          throw new Error("Native MCP roundtrip failed");
        }
      } finally {
        await client.close();
        await pair.server.close();
      }
      return "native client, transport, discovery, invocation and content conversion";
    });
  } finally {
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("oint-pi1-probe-")) {
      throw new Error("Unexpected probe cleanup path");
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const results = await probeKernel();
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
}

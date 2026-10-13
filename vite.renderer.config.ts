import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

const dependencyNames = Object.keys(pkg.dependencies ?? {});

// 主进程依赖必须保持外部化：pisdk 内部用 import.meta.url 定位随包分发的 SQL/资源文件，
// 被内联进 bundle 后这些相对定位会失效（表现为 ERR_INVALID_URL_SCHEME）。
// 同时外置 node: 内置模块，避免 Rollup 尝试解析。
const external = (id: string): boolean =>
  builtinModules.includes(id) ||
  id.startsWith("node:") ||
  dependencyNames.some((name) => id === name || id.startsWith(`${name}/`));

const alias = {
  "@": path.resolve(import.meta.dirname, "./src"),
};

export default defineConfig(async () => ({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: {
          main: "src/main/index.ts",
          "plugin-worker": "src/main/plugins/worker.ts",
          // 插件作者 API：子进程用 resolve hook 把 `oint:plugin` 指到这里（dist-electron/plugin-api.js）
          "plugin-api": "src/main/plugins/plugin-api.ts",
        },
        vite: {
          resolve: { alias },
          build: {
            target: "node22",
            // Vite 8 走 rolldown，旧键 rollupOptions 不再生效；两者都写上以兼容版本差异
            rolldownOptions: { external },
            rollupOptions: { external },
          },
        },
        onstart: async ({ startup }) => {
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          await startup(["."], { env });
        },
      },
      /*
        两个 preload 入口**必须各自一次构建**（数组形式），不能合成一个多入口构建。

        原因不是配置麻烦，是沙箱的硬约束：`sandbox: true` 的 preload 里 `require`
        只能拿到 electron 与少数内建模块，**require 不了兄弟 chunk**。
        而多入口 + CJS 会触发代码分割（vite 直接报
        `multiple inputs are not supported when output.codeSplitting is false`），
        强行打开它产出的 preload 在沙箱里一加载就失败 —— 症状是
        「窗口开了，但 window.oint 是 undefined」。

        所以：每个入口一个自包含的单文件产物。
      */
      preload: [
        {
          input: { preload: "src/preload/index.ts" },
          vite: {
            resolve: { alias },
            build: {
              emptyOutDir: false,
              target: "node22",
              rollupOptions: {
                // sandbox: true 的窗口只支持 CJS preload，因此强制产出 .cjs
                output: { format: "cjs", entryFileNames: "[name].cjs" },
              },
            },
          },
        },
        {
          // 插件界面的 guest preload：暴露给**第三方页面**的那一份（权限面完全不同）
          input: { "plugin-surface": "src/preload/plugin-surface.ts" },
          vite: {
            resolve: { alias },
            build: {
              emptyOutDir: false,
              target: "node22",
              rollupOptions: {
                output: { format: "cjs", entryFileNames: "[name].cjs" },
              },
            },
          },
        },
      ],
    }),
  ],
  resolve: {
    alias,
  },
  build: {
    rollupOptions: {
      output: {
        // 重型依赖独立分包，降低首包体积
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("/react/") || id.endsWith("/react")) {
              return "chunk-react";
            }
          }
          return undefined;
        },
      },
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
}));

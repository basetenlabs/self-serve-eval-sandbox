/// <reference types="vitest/config" />
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { sourceHash, WEB } from "./build.ts";

// `vite build --mode app` writes the page `pr-eval serve` shows; `--mode report` writes the template
// report.py fills with a run's data. Both land in eval_sandbox/ as single files.
const TARGETS: Record<string, { entry: string; out: string }> = {
  app: { entry: "index.html", out: "app.html" },
  report: { entry: "report.html", out: "report_template.html" },
};

function ship(mode: string): Plugin {
  const target = TARGETS[mode];
  return {
    name: "pr-eval-ship",
    apply: "build",
    closeBundle() {
      const built = path.join(WEB, "dist", mode, target.entry);
      const html = readFileSync(built, "utf8").replace(
        "<head>", `<head>\n<meta name="pr-eval-build" content="${sourceHash()}">`);
      writeFileSync(built, html);
      copyFileSync(built, path.join(WEB, "..", "eval_sandbox", target.out));
    },
  };
}

// `npm run dev` proxies the API and run files to a `pr-eval serve` on PR_EVAL_PORT (8765).
const backend = `http://127.0.0.1:${process.env.PR_EVAL_PORT ?? 8765}`;

export default defineConfig(({ mode }) => {
  const target = TARGETS[mode] ?? TARGETS.app;
  return {
    plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true }), ...(TARGETS[mode] ? [ship(mode)] : [])],
    resolve: { alias: { "@": path.join(WEB, "src") } },
    build: {
      outDir: path.join("dist", mode),
      emptyOutDir: true,
      assetsInlineLimit: 1_000_000,
      rollupOptions: { input: path.join(WEB, target.entry) },
    },
    server: {
      proxy: {
        "^/(api|[A-Za-z0-9_-][A-Za-z0-9_.-]*/report\\.(json|html))": {
          target: backend,
          changeOrigin: true,
          headers: { origin: backend }, // the page server only accepts POSTs from its own origin
        },
      },
    },
    test: { include: ["test/**/*.test.ts"] },
  };
});

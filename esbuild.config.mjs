import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  // `obsidian` and Electron/Node built-ins are provided by the host at runtime.
  external: ["obsidian", "electron", "child_process", "node:crypto", "node:fs", "node:path", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  // Verification can direct builds outside the repository so a concurrent
  // dirty main.js is never overwritten.
  outfile: process.env.AIOS_DASHBOARD_OUTFILE || "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

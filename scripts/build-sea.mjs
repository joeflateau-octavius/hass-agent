import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

function getArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const output = resolve(getArgument("--output", "hass-agent"));
const executable = getArgument("--executable", undefined);
const version = process.env.VERSION || "development";
const distDirectory = resolve("dist");
const bundlePath = resolve(distDirectory, "index.cjs");
const configPath = resolve(distDirectory, "sea-config.json");

await mkdir(distDirectory, { recursive: true });

await build({
  entryPoints: [resolve("index.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node26",
  minify: true,
  sourcemap: false,
  define: {
    VERSION: JSON.stringify(version),
    "import.meta.main": "true",
  },
});

const seaConfig = {
  main: bundlePath,
  mainFormat: "commonjs",
  output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgv: ["--experimental-ffi", "--no-warnings"],
  execArgvExtension: "none",
};

if (executable) {
  seaConfig.executable = resolve(executable);
}

await writeFile(configPath, `${JSON.stringify(seaConfig, null, 2)}\n`);

execFileSync(process.execPath, ["--build-sea", configPath], {
  stdio: "inherit",
});

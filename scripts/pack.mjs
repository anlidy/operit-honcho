import { mkdirSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = resolve(root, "build/package");
const output = resolve(root, "build/operit-honcho-0.1.0.toolpkg");

rmSync(resolve(root, "build"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(resolve(root, "manifest.json"), resolve(stage, "manifest.json"));
cpSync(resolve(root, "dist"), resolve(stage, "dist"), { recursive: true });

const result = spawnSync("zip", ["-q", "-r", output, "."], {
  cwd: stage,
  stdio: "inherit",
});
if (result.status !== 0) {
  throw new Error(`zip failed with exit code ${result.status}`);
}
console.log(output);

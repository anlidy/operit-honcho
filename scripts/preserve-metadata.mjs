import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "src/packages/honcho.ts");
const outputPath = resolve(root, "dist/packages/honcho.js");
const source = readFileSync(sourcePath, "utf8");
const match = source.match(/\/\*\s*METADATA\s*[\s\S]*?\*\//);
if (!match) throw new Error("Honcho source METADATA block is missing");

let output = readFileSync(outputPath, "utf8");
if (!/\/\*\s*METADATA\b/.test(output)) {
  const marker = '"use strict";';
  output = output.includes(marker)
    ? output.replace(marker, `${marker}\n${match[0]}`)
    : `${match[0]}\n${output}`;
  writeFileSync(outputPath, output);
}

const metadataMatch = output.match(/\/\*\s*METADATA\s*([\s\S]*?)\*\//);
if (!metadataMatch) throw new Error("Compiled Honcho METADATA block is missing");
const metadata = JSON.parse(metadataMatch[1]);
const expected = [
  "honcho_profile",
  "honcho_search",
  "honcho_context",
  "honcho_reasoning",
  "honcho_conclude",
];
const actual = Array.isArray(metadata.tools) ? metadata.tools.map((tool) => tool.name) : [];
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected Honcho tool schema: ${JSON.stringify(actual)}`);
}
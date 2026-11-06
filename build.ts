#!/usr/bin/env -S bun --ts

import { rm, mkdir, copyFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";

const distDir = join(import.meta.dir, "dist");
const esmDir = join(distDir, "esm");

// Clean and create dirs
await rm(distDir, { recursive: true, force: true });
await mkdir(esmDir, { recursive: true });

// Step 1: Build ESM modules with tsc
console.log("Step 1: Building ESM modules...");
execSync("bunx tsc -p tsconfig.dist.json", { stdio: "inherit" });

// Step 2: Rewrite .ts -> .js in ESM d.ts files
console.log("Step 2: Rewriting .ts -> .js in ESM d.ts...");
const esmFiles = await Bun.$`ls dist/esm/*.d.ts`.text();
for (const file of esmFiles.trim().split("\n").filter(Boolean)) {
  const content = await Bun.file(file).text();
  const rewritten = content.replace(
    /from "\.\/([^"]+)\.ts"/g,
    'from "./$1.js"',
  );
  await Bun.write(file, rewritten);
}

// Step 3: Build browser bundle
console.log("Step 3: Building browser bundle.js...");
execSync(
  "bun build ./src/index.ts --target=browser --format=esm --outfile=dist/bundle.js",
  { stdio: "inherit" },
);

// Step 4: Bundle alle d.ts in eine einzige bundle.d.ts
console.log("Step 4: Bundling all d.ts into bundle.d.ts...");
const allDtsFiles = await Bun.$`ls dist/esm/*.d.ts`.text();
const contents: string[] = [];

for (const file of allDtsFiles.trim().split("\n").filter(Boolean)) {
  let content = await Bun.file(file).text();
  // Entferne import-Anweisungen UND export ... from-Anweisungen
  const lines = content
    .split("\n")
    .filter((line) => !line.match(/^import /) && !line.match(/^export.*from /))
    .join("\n");
  if (lines.trim()) {
    contents.push(lines);
  }
}

await Bun.write("dist/bundle.d.ts", contents.join("\n\n"));

console.log("Build complete!");

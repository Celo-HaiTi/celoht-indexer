import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPattern = /(from\s+["'][^"']*(mock|fixture|seed|fake|demo|sample|stub|placeholder)[^"']*["']|import\s+.*from\s+["'][^"']*(mock|fixture|seed|fake|demo|sample|stub|placeholder)[^"']*["']|require\(["'][^"']*(mock|fixture|seed|fake|demo|sample|stub|placeholder)[^"']*["']\))/i;
const violations = [];

function walk(current) {
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "tests") continue;
      walk(full);
      continue;
    }

    if (!/\.(js|mjs|cjs|ts|tsx)$/i.test(entry.name)) continue;
    if (full.includes("check-no-prod-mocks")) continue;

    const text = readFileSync(full, "utf8");
    if (forbiddenPattern.test(text)) {
      violations.push(full);
    }
  }
}

const srcDir = path.join(root, "src");
if (statSync(srcDir, { throwIfNoEntry: false })) {
  walk(srcDir);
}

if (violations.length > 0) {
  console.error("Production source imports prohibited mock/demo modules:");
  for (const violation of violations) {
    console.error(`- ${path.relative(root, violation)}`);
  }
  process.exit(1);
}

console.log("No prohibited mock/demo imports found in production sources.");

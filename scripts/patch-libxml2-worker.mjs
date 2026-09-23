import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../node_modules/libxml2-wasm/lib/libxml2.mjs", import.meta.url);
const original = `import moduleLoader from './libxml2raw.mjs';
import { ContextStorage } from './utils.mjs';
const libxml2 = await moduleLoader();`;
const patched = `import { ContextStorage } from './utils.mjs';
const libxml2 = globalThis.__d2fLibxml2Runtime;
if (!libxml2) throw new Error('D2F libxml2 runtime was not initialized');`;

const source = await readFile(target, "utf8");
if (source.includes(patched)) process.exit(0);
if (!source.includes(original)) {
  throw new Error("Unsupported libxml2-wasm layout: expected 0.7.2 initialization block was not found");
}
await writeFile(target, source.replace(original, patched));

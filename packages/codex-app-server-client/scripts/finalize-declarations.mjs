import { readFileSync, writeFileSync } from "node:fs";

// API Extractor drops the source's type-reference directives from the shared rollup.
// Resolve our own @types/node dependency even in pnpm's non-hoisted consumer layout.
const rollup = new URL("../dist/_tsup-dts-rollup.d.ts", import.meta.url);
const reference = '/// <reference types="node" />\n';
const declaration = readFileSync(rollup, "utf8");
if (!declaration.startsWith(reference)) writeFileSync(rollup, reference + declaration);

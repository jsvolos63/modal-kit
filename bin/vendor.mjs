#!/usr/bin/env node
// Thin shim over the family's shared vendoring CLI — the generation logic
// lives (and is tested) once in @jfs/vendor-cli. It reads THIS kit's
// package.json + index.js from the directory above this bin.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVendorCli } from '@jfs/vendor-cli';

runVendorCli(dirname(dirname(fileURLToPath(import.meta.url))));

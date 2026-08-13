#!/usr/bin/env node
import { run } from '../src/cli/index.js';

run(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

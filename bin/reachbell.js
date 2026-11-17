#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const publicDir = path.join(cwd, 'public');
const targetDir = fs.existsSync(publicDir) ? publicDir : cwd;
const targetFile = path.join(targetDir, 'reachbell-sw.js');

const content = `/**
 * ReachBell Service Worker
 * Automatically loads the latest service worker engine from ReachBell.
 */
importScripts('https://app.reachbell.com/reachbell-sw-core.js');
`;

try {
  if (fs.existsSync(targetFile)) {
    console.log(`\x1b[33mℹ reachbell-sw.js already exists at:\x1b[0m ${path.relative(cwd, targetFile)}`);
  } else {
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log(`\x1b[32m✔ ReachBell Service Worker created successfully at:\x1b[0m ${path.relative(cwd, targetFile)}`);
  }
} catch (err) {
  console.error(`\x1b[31m✖ Failed to create reachbell-sw.js:\x1b[0m`, err.message);
  process.exit(1);
}

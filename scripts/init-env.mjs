/**
 * Writes .env from .env.example with a freshly generated signing key.
 *
 * The key cannot live in .env.example: that file is committed, so any value in
 * it is public, and src/config.ts refuses the ones that have been. Generating
 * per clone is what keeps that rule true without making the setup a paragraph
 * of instructions.
 *
 * Refuses to overwrite an existing .env — that file holds whatever local state
 * you have, and a setup script is not worth losing it over.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const EXAMPLE = '.env.example';
const TARGET = '.env';

if (existsSync(TARGET)) {
  console.log(`${TARGET} already exists — leaving it alone.`);
  process.exit(0);
}
if (!existsSync(EXAMPLE)) {
  console.error(`${EXAMPLE} is missing; nothing to copy from.`);
  process.exit(1);
}

copyFileSync(EXAMPLE, TARGET);

const secret = randomBytes(48).toString('base64');
const contents = readFileSync(TARGET, 'utf8');
const replaced = contents.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET="${secret}"`);

if (replaced === contents) {
  console.error('No JWT_SECRET line found in .env.example. Add one and re-run.');
  process.exit(1);
}

writeFileSync(TARGET, replaced);
console.log(`Wrote ${TARGET} with a generated JWT_SECRET.`);

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { logAudit } = require('../lib/audit.cjs');
const { createService } = require('../lib/server.cjs');
const { preview } = require('../lib/cleanup.cjs');

test('audit log rotates to bounded files and cleanup previews both', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'audit.jsonl');
  for (let i = 0; i < 12; i++) logAudit({ state: 'test', commandSha256: String(i).padStart(64, 'a') }, file, { maxBytes: 250 });
  assert(existsSync(file) && existsSync(file + '.1'));
  assert(statSync(file).size <= 250);
  assert(statSync(file + '.1').size <= 250);
  assert.match(readFileSync(file, 'utf8'), /"state":"test"/);
  const service = createService({}, { filename: join(dir, 'connections.json') });
  service.auditFile = file;
  const data = preview(service);
  assert(data.ownedFiles.includes(file));
  assert(data.ownedFiles.includes(file + '.1'));
});

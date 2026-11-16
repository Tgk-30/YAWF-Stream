import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateNativeCase } from './evidence.mjs';

// Private, runner-owned inputs only. The result never copies observations.
const [ledgerPath, argsPath, resultPath] = process.argv.slice(2);
if (!ledgerPath || !argsPath || !resultPath) process.exit(2);
try {
  const bytes = readFileSync(ledgerPath);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('LEDGER_LIMIT');
  const records = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const args = JSON.parse(readFileSync(argsPath, 'utf8'));
  const result = evaluateNativeCase({ ...args, records });
  writeFileSync(resultPath, JSON.stringify(result) + '\n', { mode: 0o600, flag: 'wx' });
  process.exitCode = result.ok ? 0 : 1;
} catch {
  writeFileSync(resultPath, JSON.stringify({ ok: false, code: 'EVIDENCE_PARSE_FAILURE' }) + '\n', { mode: 0o600, flag: 'wx' });
  process.exitCode = 1;
}

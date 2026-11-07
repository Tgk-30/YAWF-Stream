// A disposable Windows runner audit, not a production permission mutation.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppDatabase, databaseLockPath } from '../../src/db.js';
import { createLegacyServerFixture } from './migrationFixtures.js';

if (process.platform !== 'win32') throw new Error('This audit requires an actual Windows runner.');
const output = process.argv[2];
if (output == null || resolve(output) !== output) throw new Error('An absolute output path is required.');
const root = mkdtempSync(join(tmpdir(), 'yawf-win-storage-audit-'));
const script = fileURLToPath(new URL('../../../scripts/windows_storage_acl_audit.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
writeFileSync(join(root, '.audit-owner'), 'YAWF disposable storage audit');
type AclResult = { artifact: string; structurallyPrivate: boolean; unexpectedAllowCount: number };
function inspect(input: object, mode = 'inspect'): AclResult[] {
  const inventory = join(root, 'inventory.json');
  writeFileSync(inventory, JSON.stringify({ root, ...input }));
  const run = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-InputPath', inventory, '-Mode', mode], { encoding: 'utf8', timeout: 20_000, maxBuffer: 512_000,
    env: { ...process.env, PSModulePath: join(dirname(powershell), 'Modules') } });
  if (run.error != null || run.status !== 0) throw new Error(`Disposable ACL observer failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout.replace(/^\uFEFF/, '').trim()) as AclResult[];
}
const cases: Array<{ name: string; files: AclResult[] }> = [];
try {
  for (const name of ['host-inherited', 'private-parent', 'permissive-parent']) {
    const data = join(root, name);
    mkdirSync(data);
    if (name !== 'host-inherited') inspect({ path: data }, `${name === 'private-parent' ? 'private' : 'permissive'}-test-parent`);
    const path = join(data, 'database.sqlite');
    createLegacyServerFixture(path, 7);
    const db = new AppDatabase(path);
    try {
      db.sqlite.exec('CREATE TABLE windows_storage_audit_control(value INTEGER); INSERT INTO windows_storage_audit_control VALUES(1);');
      const files = [
        { artifact: 'database', path },
        { artifact: 'lease', path: databaseLockPath(path) },
        ...['-wal', '-shm'].filter(suffix => existsSync(path + suffix)).map(suffix => ({ artifact: suffix.slice(1), path: path + suffix })),
        ...readdirSync(join(data, 'backups')).map(file => ({ artifact: 'migration-snapshot', path: join(data, 'backups', file) })),
      ];
      for (const artifact of ['database', 'lease', 'wal', 'shm', 'migration-snapshot']) {
        if (!files.some(file => file.artifact === artifact)) throw new Error(`Missing required ${artifact} artifact in ${name}.`);
      }
      cases.push({ name, files: inspect({ files }) });
    } finally { db.close(); }
  }
  const privateCase = cases.find(x => x.name === 'private-parent')!;
  const permissiveCase = cases.find(x => x.name === 'permissive-parent')!;
  if (privateCase.files.some(x => !x.structurallyPrivate)) throw new Error('Private-parent positive control failed.');
  if (permissiveCase.files.some(x => x.structurallyPrivate || x.unexpectedAllowCount === 0)) throw new Error('Permissive-parent negative fixture did not expose inheritance.');
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, source: process.env.GITHUB_SHA,
    node: process.versions.node, os: process.platform, cases, fixtureControlsPassed: true,
    actualUnrelatedUserAccessTested: false, productionPermissionCodeChanged: false }, null, 2) + '\n');
  console.log('Windows descriptor audit completed with private and permissive fixture controls.');
} finally { rmSync(root, { recursive: true, force: true }); }

import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export class PrivateStorageError extends Error {
  constructor() {
    super("Windows storage privacy could not be verified. Use a private data or backup folder owned by your account and ensure native permission checks are available. Existing permissions and files were not changed.");
    this.name = "PrivateStorageError";
  }
}

type StorageKind = "file" | "directory" | "ancestor";
interface StorageRule {
  sid: string;
  allow: boolean;
  rights: number;
  inheritOnly: boolean;
  objectInherit: boolean;
  containerInherit: boolean;
  noPropagate: boolean;
}
export interface WindowsStorageDescriptor {
  kind: StorageKind;
  currentSid: string;
  ownerSid: string;
  trustedInstallerSid: string | null;
  directory: boolean;
  reparse: boolean;
  daclPresent: boolean;
  daclNull: boolean;
  rawAceTypes: number[];
  rules: StorageRule[];
}

// The data boundary admits only this user and the two privileged Windows
// principals. TrustedInstaller is an OS-ancestor exception, never a data grant.
export function windowsStorageDescriptorIsPrivate(value: WindowsStorageDescriptor): boolean {
  const trusted = new Set([value.currentSid, "S-1-5-18", "S-1-5-32-544"]);
  if (!["file", "directory", "ancestor"].includes(value.kind) ||
      !/^S-1-\d+(?:-\d+)+$/.test(value.currentSid) || !Array.isArray(value.rules) ||
      value.rules.length === 0 || value.rules.length > 256 || value.reparse ||
      !Array.isArray(value.rawAceTypes) || value.rawAceTypes.length !== value.rules.length ||
      value.rawAceTypes.some(type => type !== 0 && type !== 1) ||
      value.daclPresent !== true || value.daclNull !== false ||
      (value.kind === "file" ? value.directory !== false : value.directory !== true)) return false;
  if (value.kind === "ancestor" && value.trustedInstallerSid != null) trusted.add(value.trustedInstallerSid);
  if (!trusted.has(value.ownerSid)) return false;
  let fileInheritance = false;
  let directoryInheritance = false;
  for (const [index, rule] of value.rules.entries()) {
    if (typeof rule.sid !== "string" || typeof rule.allow !== "boolean" ||
        !Number.isSafeInteger(rule.rights) || rule.rights < 0 || rule.rights > 0xffffffff ||
        [rule.inheritOnly, rule.objectInherit, rule.containerInherit, rule.noPropagate].some(flag => typeof flag !== "boolean")) return false;
    if (rule.allow !== (value.rawAceTypes[index] === 0)) return false;
    if (!rule.allow || rule.rights === 0) continue;
    const creator = rule.sid === "S-1-3-0" && rule.inheritOnly;
    if (value.kind === "ancestor") {
      // Public ancestor traversal is normal. Untrusted deletion of children or
      // ACL/owner changes could instead replace the private path underneath us.
      if (!rule.inheritOnly && !trusted.has(rule.sid) && (rule.rights & 0x100d0040) !== 0) return false;
      continue;
    }
    if (value.kind === "file" && rule.inheritOnly) continue;
    if (!trusted.has(rule.sid) && !creator) return false;
    const read = (rule.rights & 1) !== 0 || (rule.rights & 0x90000000) !== 0;
    const write = (rule.rights & 2) !== 0 || (rule.rights & 0x50000000) !== 0;
    if (read && write && !rule.noPropagate) {
      fileInheritance ||= rule.objectInherit;
      directoryInheritance ||= rule.containerInherit;
    }
  }
  return value.kind !== "directory" || (fileInheritance && directoryInheritance);
}

// Static code only. Paths travel as JSON on stdin, never as executable text or
// command-line values. This observer cannot change ACLs or read file contents.
const DESCRIPTOR_OBSERVER = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YawfNativeSecurity {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileSecurityW(string name, uint information, [Out] byte[] buffer, uint length, out uint needed);
  public static byte[] Read(string path) {
    uint needed;
    bool initial = GetFileSecurityW(path, 5, null, 0, out needed);
    if (initial || Marshal.GetLastWin32Error() != 122 || needed < 20 || needed > 262144)
      throw new InvalidOperationException("Storage metadata could not be read.");
    byte[] bytes = new byte[(int)needed];
    uint actual;
    if (!GetFileSecurityW(path, 5, bytes, (uint)bytes.Length, out actual) || actual > bytes.Length)
      throw new InvalidOperationException("Storage metadata could not be read.");
    return bytes;
  }
}
'@
$entries = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$installer = $null
try { $installer = ([Security.Principal.NTAccount]::new('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
$result = @()
foreach ($entry in $entries) {
  $attributes = [IO.File]::GetAttributes($entry.path)
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new([YawfNativeSecurity]::Read($entry.path), 0)
  $rules = @()
  $types = @()
  if ($null -ne $raw.DiscretionaryAcl) {
    foreach ($ace in $raw.DiscretionaryAcl) {
      $types += [int]$ace.AceType
      if ($ace -isnot [Security.AccessControl.CommonAce] -or [int]$ace.AceType -notin @(0, 1)) { continue }
      $aceFlags = [int]$ace.AceFlags
      $rules += [ordered]@{
        sid = $ace.SecurityIdentifier.Value
        allow = [int]$ace.AceType -eq 0
        rights = ([int64]$ace.AccessMask -band 4294967295)
        inheritOnly = ($aceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0
        objectInherit = ($aceFlags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) -ne 0
        containerInherit = ($aceFlags -band [int][Security.AccessControl.AceFlags]::ContainerInherit) -ne 0
        noPropagate = ($aceFlags -band [int][Security.AccessControl.AceFlags]::NoPropagateInherit) -ne 0
      }
    }
  }
  $result += [ordered]@{
    id = $entry.id
    kind = $entry.kind
    currentSid = $current
    ownerSid = $raw.Owner.Value
    trustedInstallerSid = $installer
    directory = $attributes.HasFlag([IO.FileAttributes]::Directory)
    reparse = $attributes.HasFlag([IO.FileAttributes]::ReparsePoint)
    daclPresent = ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0
    daclNull = $null -eq $raw.DiscretionaryAcl
    rawAceTypes = $types
    rules = $rules
  }
}
[Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
`;

/** Validate existing artifacts and the private ancestor from which a new
 * artifact would inherit its DACL. No cache: permissions can change at runtime. */
export function assertPrivateWindowsStorage(paths: readonly string[]): void {
  if (process.platform !== "win32") return;
  try {
    if (paths.length === 0 || paths.length > 16) throw new PrivateStorageError();
    const entries = new Map<string, { path: string; kind: StorageKind }>();
    const add = (path: string, kind: StorageKind) => {
      const existing = entries.get(path.toLowerCase());
      if (existing == null || existing.kind === "ancestor") entries.set(path.toLowerCase(), { path, kind });
    };
    const inspect = (path: string) => {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new PrivateStorageError();
        return stat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    for (const input of paths) {
      if (typeof input !== "string" || input.includes("\0") || input.length > 4096) throw new PrivateStorageError();
      const path = resolve(input);
      if (path.slice(parse(path).root.length).includes(":")) throw new PrivateStorageError();
      if (inspect(path) != null) add(path, "file");
      let parent = dirname(path);
      while (inspect(parent) == null) {
        const next = dirname(parent);
        if (next === parent) throw new PrivateStorageError();
        parent = next;
      }
      add(parent, "directory");
      for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
        if (inspect(ancestor) == null) throw new PrivateStorageError();
        add(ancestor, "ancestor");
        if (dirname(ancestor) === ancestor) break;
      }
    }
    const requests = [...entries.values()].map((entry, id) => ({ ...entry, id }));
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const osEnvironment = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE",
      "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "LOCALAPPDATA", "APPDATA"]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => osEnvironment.has(key.toUpperCase()))
      .map(([key, value]) => [key.toUpperCase(), value]));
    env.PSModulePath = join(dirname(powershell), "Modules");
    const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(DESCRIPTOR_OBSERVER, "utf16le").toString("base64")], {
      input: JSON.stringify(requests), encoding: "utf8", env, timeout: 7000, maxBuffer: 256_000, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const descriptors = JSON.parse(output.replace(/^\uFEFF/, "").trim()) as Array<WindowsStorageDescriptor & { id: number }>;
    if (!Array.isArray(descriptors) || descriptors.length !== requests.length || descriptors.some((value, id) =>
      value.id !== id || value.kind !== requests[id]!.kind || !windowsStorageDescriptorIsPrivate(value))) throw new PrivateStorageError();
  } catch {
    // Native command errors contain local paths. Neither descriptors, stdin,
    // stdout nor stderr are attached to a public error or diagnostic record.
    throw new PrivateStorageError();
  }
}

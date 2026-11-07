import { describe, expect, it } from "vitest";
import { windowsStorageDescriptorIsPrivate, type WindowsStorageDescriptor } from "../src/privateStorage.js";

const current = "S-1-5-21-123-456-789-1001";
const everyone = "S-1-1-0";
function descriptor(): WindowsStorageDescriptor {
  return { kind: "directory", currentSid: current, ownerSid: current, trustedInstallerSid: "S-1-5-80-123",
    directory: true, reparse: false, daclPresent: true, daclNull: false, rawAceTypes: [0],
    rules: [{ sid: current, allow: true, rights: 0x1f01ff, inheritOnly: false, objectInherit: true, containerInherit: true, noPropagate: false }] };
}
function appendRule(d: WindowsStorageDescriptor, rule: WindowsStorageDescriptor["rules"][number]): void {
  d.rules.push(rule); d.rawAceTypes.push(rule.allow ? 0 : 1);
}
describe("Windows private storage descriptor policy", () => {
  it("admits a private inheriting user directory and its privileged Windows principals", () => {
    const d = descriptor();
    for (const sid of [current, "S-1-5-18", "S-1-5-32-544"]) {
      d.ownerSid = sid; d.rules[0]!.sid = sid;
      expect(windowsStorageDescriptorIsPrivate(d)).toBe(true);
    }
  });
  it.each(["database", "lease", "wal", "shm", "key", "snapshot", "backup"])("rejects Everyone ReadData on a %s file", () => {
    const d = descriptor(); d.kind = "file"; d.directory = false;
    appendRule(d, { ...d.rules[0]!, sid: everyone, rights: 1 });
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it.each(["null", "absent", "empty", "reparse", "owner"])("rejects a %s security boundary", (bad) => {
    const d = descriptor();
    if (bad === "null") d.daclNull = true;
    if (bad === "absent") d.daclPresent = false;
    if (bad === "empty") d.rules = [];
    if (bad === "reparse") d.reparse = true;
    if (bad === "owner") d.ownerSid = everyone;
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it.each(["object", "container", "no-propagate"])("requires private future %s inheritance", (bad) => {
    const d = descriptor();
    if (bad === "object") d.rules[0]!.objectInherit = false;
    if (bad === "container") d.rules[0]!.containerInherit = false;
    if (bad === "no-propagate") d.rules[0]!.noPropagate = true;
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it("rejects an inherit-only public child grant but maps future CREATOR_OWNER safely", () => {
    const d = descriptor(); appendRule(d, { ...d.rules[0]!, sid: everyone, inheritOnly: true });
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
    d.rules[1]!.sid = "S-1-3-0";
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(true);
  });
  it("does not admit CREATOR_OWNER as an effective file grant", () => {
    const d = descriptor(); d.kind = "file"; d.directory = false; d.rules[0]!.sid = "S-1-3-0";
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it("recognizes private future CREATOR_OWNER generic full control", () => {
    const d = descriptor(); d.rules[0]!.objectInherit = false; d.rules[0]!.containerInherit = false;
    appendRule(d, { ...d.rules[0]!, sid: "S-1-3-0", rights: 0x10000000,
      inheritOnly: true, objectInherit: true, containerInherit: true });
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(true);
  });
  it("permits public ancestor traversal and the OS installer without admitting it to data", () => {
    const d = descriptor(); d.kind = "ancestor"; d.ownerSid = d.trustedInstallerSid!;
    appendRule(d, { ...d.rules[0]!, sid: everyone, rights: 0x1200a9 });
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(true);
    d.kind = "directory";
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it.each([0x40, 0x10000, 0x40000, 0x80000, 0x10000000])("rejects untrusted ancestor replacement right %s", (rights) => {
    const d = descriptor(); d.kind = "ancestor";
    appendRule(d, { ...d.rules[0]!, sid: everyone, rights });
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it("rejects malformed rule masks and booleans rather than treating them as safe", () => {
    const d = descriptor(); d.rules[0]!.rights = -1;
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
    d.rules[0]!.rights = 0x1f01ff; d.rules[0]!.allow = undefined as never;
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it.each([5, 6, 9, 10, 11, 12, 13, 17])("fails closed on unsupported raw ACE type %s", (type) => {
    const d = descriptor(); d.rawAceTypes[0] = type;
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
  it("rejects a projection omitting a raw ACE or changing its allow/deny meaning", () => {
    const d = descriptor(); d.rawAceTypes.push(0);
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
    d.rawAceTypes = [1];
    expect(windowsStorageDescriptorIsPrivate(d)).toBe(false);
  });
});

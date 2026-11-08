#!/usr/bin/env node
// Read-only metadata admission. Never creates, boots, installs, or launches.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateArrival(value, expectedId, expectedRevision) {
  if (!uuid.test(expectedId) || !/^[a-f0-9]{40}$/.test(expectedRevision) || !value ||
      Object.keys(value).sort().join(',') !== 'fixtureInstanceId,loginSuccessCount,schemaVersion,sourceRevision' ||
      value.schemaVersion !== 1 || typeof value.fixtureInstanceId !== 'string' || value.fixtureInstanceId.toLowerCase() !== expectedId.toLowerCase() ||
      value.sourceRevision !== expectedRevision || !Number.isSafeInteger(value.loginSuccessCount) || value.loginSuccessCount < 0) throw new Error('Fixture arrival identity/source/schema mismatch');
  return value.loginSuccessCount;
}
export function validateProbeURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43178' || url.pathname !== '/__qa/arrival' || url.username || url.password || url.search || url.hash) throw new Error('Only the explicit synthetic loopback arrival probe is permitted');
  return url.href;
}
export function validateOwnership(ownership, registry, destinations) {
  if (ownership?.schemaVersion !== 1 || ownership.createdFor !== 'ipad-native-qa' || ownership.createdFresh !== true ||
      !uuid.test(ownership.udid ?? '') || !/^YAWF-iPad-NativeQA-[a-f0-9-]{36}$/i.test(ownership.name ?? '') ||
      !['com.apple.CoreSimulator.SimRuntime.iOS-26-5', 'com.apple.CoreSimulator.SimRuntime.iOS-27-0'].includes(ownership.runtimeIdentifier) ||
      typeof ownership.deviceSetPath !== 'string') throw new Error('A root-created fresh named iPad ownership receipt is required');
  const deviceSet = resolve(ownership.deviceSetPath);
  const defaultSet = join(homedir(), 'Library/Developer/CoreSimulator/Devices');
  if (!deviceSet.startsWith('/Volumes/Work/') && !(deviceSet === defaultSet && ownership.rootApprovedDefaultSet === true)) throw new Error('Custom Work set or explicit root-approved fresh default-set device required');
  const matches = Object.entries(registry.devices ?? {}).flatMap(([runtime, devices]) => devices.filter((device) => device.udid?.toUpperCase() === ownership.udid.toUpperCase()).map((device) => ({ ...device, runtime })));
  if (matches.length !== 1) throw new Error('Exact owned device is absent or ambiguous');
  const device = matches[0];
  if (device.name !== ownership.name || device.runtime !== ownership.runtimeIdentifier || device.isAvailable !== true ||
      !['Shutdown', 'Booted'].includes(device.state) || !device.deviceTypeIdentifier?.startsWith('com.apple.CoreSimulator.SimDeviceType.iPad') ||
      resolve(device.dataPath ?? '') !== join(deviceSet, device.udid, 'data')) throw new Error('Owned iPad registry metadata mismatch');
  let available = false, admitted = false;
  for (const line of destinations.split('\n')) {
    if (/Available destinations for|Destinations compatible with/.test(line)) available = true;
    if (/Ineligible destinations|Unavailable destinations|Destinations incompatible with/.test(line)) available = false;
    if (!available || !line.includes('{')) continue;
    const fields = Object.fromEntries(line.slice(line.indexOf('{') + 1, line.lastIndexOf('}')).split(',').map((field) => {
      const at = field.indexOf(':'); return [field.slice(0, at).trim(), field.slice(at + 1).trim()];
    }));
    if (fields.platform === 'iOS Simulator' && fields.id?.toUpperCase() === ownership.udid.toUpperCase() && fields.name === ownership.name) admitted = true;
  }
  if (!admitted) throw new Error('xcodebuild must discover the exact owned UDID as an available iOS Simulator destination; no name/default fallback');
  return { schemaVersion: 1, udid: device.udid, name: device.name, runtime: device.runtime, destination: `platform=iOS Simulator,id=${device.udid}`, defaultSetApproved: deviceSet === defaultSet };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) throw new Error('Usage: node preflight.mjs <ownership.json> <devices.json> <destinations.txt>');
  const values = [];
  for (const input of process.argv.slice(2)) {
    const path = resolve(input);
    if (!path.startsWith('/Volumes/Work/')) throw new Error('Preflight input snapshots must be in owned Work evidence');
    const bytes = await readFile(path);
    if (bytes.length > 1024 * 1024) throw new Error('Oversized metadata snapshot');
    values.push(bytes.toString('utf8'));
  }
  console.log(JSON.stringify(validateOwnership(JSON.parse(values[0]), JSON.parse(values[1]), values[2]), null, 2));
}

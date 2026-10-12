#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const ANDROID_PAGE_SIZE = 16_384n;

const ELF_CLASS_32 = 1;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const PT_LOAD = 1;
const PT_GNU_RELRO = 0x6474e552;
const PN_XNUM = 0xffff;

function reject(label, reason) {
  throw new Error(`${label}: ${reason}`);
}

function safeOffset(value, label, description, fileLength) {
  if (value < 0n || value > BigInt(fileLength) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    reject(label, `${description} is outside the file`);
  }
  return Number(value);
}

function readProgramHeader(view, elfClass, offset) {
  if (elfClass === ELF_CLASS_64) {
    return {
      type: view.getUint32(offset, true),
      fileOffset: view.getBigUint64(offset + 8, true),
      virtualAddress: view.getBigUint64(offset + 16, true),
      fileSize: view.getBigUint64(offset + 32, true),
      memorySize: view.getBigUint64(offset + 40, true),
      alignment: view.getBigUint64(offset + 48, true),
    };
  }
  return {
    type: view.getUint32(offset, true),
    fileOffset: BigInt(view.getUint32(offset + 4, true)),
    virtualAddress: BigInt(view.getUint32(offset + 8, true)),
    fileSize: BigInt(view.getUint32(offset + 16, true)),
    memorySize: BigInt(view.getUint32(offset + 20, true)),
    alignment: BigInt(view.getUint32(offset + 28, true)),
  };
}

export function checkElfBuffer(bytes, label = "native library") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (
    buffer.length < 16 ||
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x4c ||
    buffer[3] !== 0x46
  ) {
    reject(label, "not a supported ELF file");
  }
  const elfClass = buffer[4];
  if (elfClass !== ELF_CLASS_32 && elfClass !== ELF_CLASS_64) {
    reject(label, "unsupported ELF class");
  }
  if (buffer[5] !== ELF_DATA_LITTLE_ENDIAN) {
    reject(label, "only little-endian ELF files are supported");
  }

  const headerSize = elfClass === ELF_CLASS_64 ? 64 : 52;
  const minimumProgramHeaderSize = elfClass === ELF_CLASS_64 ? 56 : 32;
  if (buffer.length < headerSize) reject(label, "truncated ELF header");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const programHeaderOffset = elfClass === ELF_CLASS_64
    ? view.getBigUint64(32, true)
    : BigInt(view.getUint32(28, true));
  const programHeaderEntrySize = view.getUint16(elfClass === ELF_CLASS_64 ? 54 : 42, true);
  const programHeaderCount = view.getUint16(elfClass === ELF_CLASS_64 ? 56 : 44, true);
  if (programHeaderCount === 0 || programHeaderCount === PN_XNUM) {
    reject(label, "missing or unsupported program header count");
  }
  if (programHeaderEntrySize < minimumProgramHeaderSize) {
    reject(label, "program header entries are truncated");
  }
  const programTableSize = BigInt(programHeaderEntrySize) * BigInt(programHeaderCount);
  const programTableEnd = programHeaderOffset + programTableSize;
  if (programTableEnd > BigInt(buffer.length)) {
    reject(label, "truncated program header table");
  }
  const programTableStart = safeOffset(
    programHeaderOffset,
    label,
    "program header table",
    buffer.length,
  );

  let loadCount = 0;
  let relroCount = 0;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programTableStart + index * programHeaderEntrySize;
    const header = readProgramHeader(view, elfClass, offset);
    if (header.fileOffset + header.fileSize > BigInt(buffer.length)) {
      reject(label, `program header ${index} extends beyond the file`);
    }

    if (header.type === PT_LOAD) {
      const loadIndex = loadCount;
      loadCount += 1;
      if (header.fileSize > header.memorySize) {
        reject(label, `PT_LOAD ${loadIndex} has file data larger than memory size`);
      }
      if (
        header.alignment < ANDROID_PAGE_SIZE ||
        (header.alignment & (header.alignment - 1n)) !== 0n
      ) {
        reject(label, `PT_LOAD ${loadIndex} alignment is below 16384 bytes`);
      }
      if (header.fileOffset % header.alignment !== header.virtualAddress % header.alignment) {
        reject(label, `PT_LOAD ${loadIndex} file and virtual offsets are not congruent`);
      }
    } else if (header.type === PT_GNU_RELRO) {
      relroCount += 1;
      if ((header.virtualAddress + header.memorySize) % ANDROID_PAGE_SIZE !== 0n) {
        reject(label, "PT_GNU_RELRO end is not aligned to 16384 bytes");
      }
    }
  }
  if (loadCount === 0) reject(label, "ELF file has no PT_LOAD segments");

  return { elfClass, loadCount, relroCount };
}

export function checkAndroidElfFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("Provide one or more explicit native library paths.");
  }
  return paths.map((path) => {
    const label = basename(path);
    let bytes;
    try {
      if (!statSync(path).isFile()) reject(label, "path is not a file");
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error;
      reject(label, "could not read native library");
    }
    return { path, label, ...checkElfBuffer(bytes, label) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const results = checkAndroidElfFiles(process.argv.slice(2));
    for (const result of results) {
      console.log(
        `ok   ${result.label}: ELF${result.elfClass === ELF_CLASS_64 ? "64" : "32"}, ${result.loadCount} PT_LOAD segment(s)`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Android ELF alignment check failed.");
    process.exitCode = 1;
  }
}

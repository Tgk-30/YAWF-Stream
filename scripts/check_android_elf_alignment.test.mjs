import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANDROID_PAGE_SIZE,
  checkAndroidElfFiles,
  checkElfBuffer,
} from "./check_android_elf_alignment.mjs";

const PT_LOAD = 1;
const PT_GNU_RELRO = 0x6474e552;

function makeElf(elfClass, programHeaders) {
  const is64 = elfClass === 2;
  const headerSize = is64 ? 64 : 52;
  const programHeaderSize = is64 ? 56 : 32;
  const buffer = Buffer.alloc(headerSize + programHeaderSize * programHeaders.length);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1, 1]);
  if (is64) {
    buffer.writeBigUInt64LE(BigInt(headerSize), 32);
    buffer.writeUInt16LE(headerSize, 52);
    buffer.writeUInt16LE(programHeaderSize, 54);
    buffer.writeUInt16LE(programHeaders.length, 56);
  } else {
    buffer.writeUInt32LE(headerSize, 28);
    buffer.writeUInt16LE(headerSize, 40);
    buffer.writeUInt16LE(programHeaderSize, 42);
    buffer.writeUInt16LE(programHeaders.length, 44);
  }

  programHeaders.forEach((header, index) => {
    const offset = headerSize + index * programHeaderSize;
    const fileOffset = BigInt(header.fileOffset ?? 0);
    const virtualAddress = BigInt(header.virtualAddress ?? 0);
    const fileSize = BigInt(header.fileSize ?? 0);
    const memorySize = BigInt(header.memorySize ?? fileSize);
    const alignment = BigInt(header.alignment ?? 0);
    buffer.writeUInt32LE(header.type, offset);
    if (is64) {
      buffer.writeUInt32LE(4, offset + 4);
      buffer.writeBigUInt64LE(fileOffset, offset + 8);
      buffer.writeBigUInt64LE(virtualAddress, offset + 16);
      buffer.writeBigUInt64LE(virtualAddress, offset + 24);
      buffer.writeBigUInt64LE(fileSize, offset + 32);
      buffer.writeBigUInt64LE(memorySize, offset + 40);
      buffer.writeBigUInt64LE(alignment, offset + 48);
    } else {
      buffer.writeUInt32LE(Number(fileOffset), offset + 4);
      buffer.writeUInt32LE(Number(virtualAddress), offset + 8);
      buffer.writeUInt32LE(Number(virtualAddress), offset + 12);
      buffer.writeUInt32LE(Number(fileSize), offset + 16);
      buffer.writeUInt32LE(Number(memorySize), offset + 20);
      buffer.writeUInt32LE(4, offset + 24);
      buffer.writeUInt32LE(Number(alignment), offset + 28);
    }
  });
  return buffer;
}

function validHeaders() {
  return [
    {
      type: PT_LOAD,
      fileOffset: 0,
      virtualAddress: 0,
      memorySize: 0x3000,
      alignment: ANDROID_PAGE_SIZE,
    },
    {
      type: PT_GNU_RELRO,
      virtualAddress: 0x3000,
      memorySize: 0x1000,
    },
  ];
}

test("accepts a little-endian ELF32 library with 16 KiB LOAD and RELRO alignment", () => {
  assert.deepEqual(checkElfBuffer(makeElf(1, validHeaders()), "valid32.so"), {
    elfClass: 1,
    loadCount: 1,
    relroCount: 1,
  });
});

test("accepts a little-endian ELF64 library with 16 KiB LOAD and RELRO alignment", () => {
  assert.deepEqual(checkElfBuffer(makeElf(2, validHeaders()), "valid64.so"), {
    elfClass: 2,
    loadCount: 1,
    relroCount: 1,
  });
});

test("rejects a second PT_LOAD segment that falls back to 4 KiB alignment", () => {
  const bytes = makeElf(2, [
    validHeaders()[0],
    {
      type: PT_LOAD,
      fileOffset: 0,
      virtualAddress: 0,
      memorySize: 0x1000,
      alignment: 0x1000,
    },
    validHeaders()[1],
  ]);
  assert.throws(
    () => checkElfBuffer(bytes, "second-load.so"),
    /second-load\.so: PT_LOAD 1 alignment is below 16384 bytes/,
  );
});

test("rejects a PT_LOAD segment whose file size exceeds its memory size", () => {
  const bytes = makeElf(2, [{
    type: PT_LOAD,
    fileOffset: 0,
    virtualAddress: 0,
    fileSize: 64,
    memorySize: 32,
    alignment: ANDROID_PAGE_SIZE,
  }]);
  assert.throws(
    () => checkElfBuffer(bytes, "oversized-load.so"),
    /PT_LOAD 0 has file data larger than memory size/,
  );
});

test("rejects incongruent PT_LOAD file and virtual offsets", () => {
  const incongruent = makeElf(2, [{
    type: PT_LOAD,
    fileOffset: 0,
    virtualAddress: 0x1000,
    memorySize: 0x1000,
    alignment: 0x4000,
  }]);
  assert.throws(
    () => checkElfBuffer(incongruent, "incongruent.so"),
    /file and virtual offsets are not congruent/,
  );
});

test("rejects a GNU_RELRO segment whose end is not 16 KiB aligned", () => {
  const relro = makeElf(1, [
    validHeaders()[0],
    { type: PT_GNU_RELRO, virtualAddress: 0x3000, memorySize: 0x800 },
  ]);
  assert.throws(
    () => checkElfBuffer(relro, "relro.so"),
    /PT_GNU_RELRO end is not aligned to 16384 bytes/,
  );
});

test("accepts aligned GNU_RELRO file data that is larger than its memory mapping", () => {
  const bytes = makeElf(2, [
    validHeaders()[0],
    {
      type: PT_GNU_RELRO,
      fileOffset: 0,
      virtualAddress: 0x3fe0,
      fileSize: 64,
      memorySize: 32,
    },
  ]);
  let result;
  assert.doesNotThrow(() => {
    result = checkElfBuffer(bytes, "relro-file-padding.so");
  });
  assert.deepEqual(result, {
    elfClass: 2,
    loadCount: 1,
    relroCount: 1,
  });
});

test("fails closed for a malformed non-ELF input", () => {
  assert.throws(
    () => checkElfBuffer(Buffer.from("not elf"), "malformed.so"),
    /not a supported ELF file/,
  );
});

test("fails closed for a truncated program header table", () => {
  const truncated = makeElf(2, validHeaders()).subarray(0, 80);
  assert.throws(
    () => checkElfBuffer(truncated, "truncated.so"),
    /truncated program header table/,
  );
});

test("fails closed when an ELF file has no PT_LOAD segment", () => {
  const noLoad = makeElf(2, [validHeaders()[1]]);
  assert.throws(
    () => checkElfBuffer(noLoad, "no-load.so"),
    /has no PT_LOAD segments/,
  );
});

test("checks only explicit native library paths and reports basename-scoped results", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-elf-alignment-"));
  try {
    const path = join(root, "libdebridstreamer.so");
    writeFileSync(path, makeElf(2, validHeaders()));
    assert.deepEqual(checkAndroidElfFiles([path]), [{
      path,
      label: "libdebridstreamer.so",
      elfClass: 2,
      loadCount: 1,
      relroCount: 1,
    }]);
    assert.throws(
      () => checkAndroidElfFiles([]),
      /one or more explicit native library paths/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scopes both 16 KiB linker flags to Android cdylibs using Cargo target metadata", () => {
  const buildSource = readFileSync(new URL("../web/src-tauri/build.rs", import.meta.url), "utf8");
  assert.match(
    buildSource,
    /let target_os = std::env::var\("CARGO_CFG_TARGET_OS"\)\.unwrap_or_default\(\)/,
  );
  const androidBlock = /if target_os == "android"\s*\{([\s\S]*?)\n\s*\}/.exec(buildSource)?.[1];
  assert.ok(androidBlock, "Android target block is missing");
  assert.match(
    androidBlock,
    /cargo:rustc-cdylib-link-arg=-Wl,-z,max-page-size=16384/,
  );
  assert.match(
    androidBlock,
    /cargo:rustc-cdylib-link-arg=-Wl,-z,common-page-size=16384/,
  );
  assert.equal((androidBlock.match(/cargo:rustc-cdylib-link-arg=/g) ?? []).length, 2);
  assert.doesNotMatch(buildSource, /cargo:rustc-link-arg=[^\n]*page-size/);
  assert.doesNotMatch(buildSource, /#\[cfg\(target_os = "android"\)\]|cfg!\(target_os = "android"\)/);
});

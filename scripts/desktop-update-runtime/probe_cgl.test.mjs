import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const file = new URL('./probe_cgl.c', import.meta.url);
const source = await readFile(file, 'utf8');

test('exact CGL diagnostic attributes match the production accelerated core3.2 pixel format', async () => {
  const rust = await readFile(new URL('../../web/src-tauri/src/render_player/surface_macos.rs', import.meta.url), 'utf8');
  const production = /const CGLPixelFormatAttribute production_attributes\[\] = \{([^}]+)\}/.exec(source)?.[1];
  assert.ok(production);
  assert.deepEqual(production.split(',').map((value) => value.trim()).filter(Boolean), [
    'kCGLPFAAccelerated', 'kCGLPFAOpenGLProfile', '(CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core', '(CGLPixelFormatAttribute)0',
  ]);
  const native = /let attribs = \[([\s\S]*?)\];/.exec(rust.slice(rust.indexOf('fn copy_cgl_pixel_format(')))?.[1];
  assert.ok(native);
  assert.deepEqual(native.split(',').map((value) => value.trim()).filter(Boolean), [
    'CGLPixelFormatAttribute::CGLPFAAccelerated', 'CGLPixelFormatAttribute::CGLPFAOpenGLProfile',
    'CGLPixelFormatAttribute(CGL_OGLP_VERSION_3_2_CORE)', 'CGLPixelFormatAttribute(0)',
  ]);
  assert.match(rust, /const CGL_OGLP_VERSION_3_2_CORE: u32 = 0x3200/);
  assert.match(source, /CGLDescribePixelFormat\(pixel_format, 0, kCGLPFAAccelerated, &accelerated\)/);
});

test('CGL probe restores its prior current context and releases every retained or created object', () => {
  const previous = source.indexOf('CGLContextObj previous = CGLGetCurrentContext();');
  const retain = source.indexOf('CGLRetainContext(previous)');
  const create = source.indexOf('CGLCreateContext(pixel_format, NULL, &context)');
  const restore = source.indexOf('result.restore_error = CGLSetCurrentContext(previous);');
  const detach = source.indexOf('if (!result.previous_restored) result.detach_error = CGLSetCurrentContext(NULL);');
  const release = source.indexOf('CGLReleaseContext(context)');
  assert.ok(previous >= 0 && previous < retain && retain < create && create < restore && restore < detach && detach < release);
  assert.ok(release < source.indexOf('CGLReleasePixelFormat(pixel_format)'));
  assert.ok(source.indexOf('CGLReleasePixelFormat(pixel_format)') < source.indexOf('CGLReleaseContext(previous)'));
  assert.match(source, /result\.previous_restored = result\.restore_error == kCGLNoError && CGLGetCurrentContext\(\) == previous/);
});

test('probe JSON schema has only fixed keys and numeric or boolean values without renderer identities', () => {
  const block = source.slice(source.indexOf('static void print_result('), source.indexOf('int main(void)'));
  const format = block.slice(block.indexOf('printf(') + 7, block.indexOf('boolean(r->attempted)'));
  const strings = format.match(/"(?:\\.|[^"\\])*"/g);
  assert.ok(strings);
  const rendered = strings.map((value) => JSON.parse(value)).join('').replace(/%s/g, 'false').replace(/%[du]/g, '0');
  const profile = JSON.parse(rendered);
  assert.equal(Object.keys(profile).length, 25);
  for (const [key, value] of Object.entries(profile)) assert.ok(typeof value === 'number' || typeof value === 'boolean', key);
  for (const field of ['chooseError', 'pixelFormatCount', 'createError', 'setCurrentError', 'glMajor', 'glMinor', 'accelerated', 'previousRestored', 'supported']) assert.ok(field in profile);
  assert.match(source, /glGetString\(GL_VERSION\)/);
  assert.match(source, /sscanf\(\(const char \*\)version, "%u\.%u", &major, &minor\)/);
  assert.match(source, /boolean\(bool value\) \{ return value \? "true" : "false"; \}/);
  assert.match(source, /\\"diagnosticOnly\\":true,\\"offscreenContextOnly\\":true,\\"provesVideoRendering\\":false/);
  for (const call of source.matchAll(/(?:printf|fputs|puts)\(([\s\S]*?)\);/g)) assert.doesNotMatch(call[1], /\bversion\b/);
  assert.doesNotMatch(source, /GL_VENDOR|GL_RENDERER|fopen\(|getenv\(|NSWindow|CGLSetParameter|CGLSetOption/);
  assert.ok(rendered.length < 2048);
});

test('unsupported production capability runs a clearly non-production default control and still exits zero', () => {
  assert.match(source, /default_control_attributes\[\] = \{ \(CGLPixelFormatAttribute\)0 \}/);
  assert.match(source, /if \(!production\.supported && production\.previous_restored\) control = probe\(default_control_attributes, false\)/);
  assert.match(source, /result\.production_profile = production_profile/);
  assert.match(source, /result\.accelerated_requested = production_profile/);
  assert.match(source, /result\.core32_requested = production_profile/);
  assert.match(source, /!production_profile \|\| \(result\.accelerated && core32\)/);
  assert.match(source, /fputs\(",\\"defaultControl\\":", stdout\)/);
  assert.match(source, /if \(ferror\(stdout\) \|\| fflush\(stdout\) != 0\) return 1/);
  assert.match(source, /return execution_ok \? 0 : 2;/);
  assert.doesNotMatch(source, /return production\.supported|exit\(EXIT_SUCCESS\)/);
});

test('Apple SDK compiles the actual C probe without executing any graphics API', (t) => {
  if (process.platform !== 'darwin') { t.skip('Apple SDK syntax compilation unavailable on this host; not a native probe pass.'); return; }
  const result = spawnSync('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-Wno-unused-command-line-argument', '-framework', 'OpenGL', '-fsyntax-only', fileURLToPath(file)], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

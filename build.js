#!/usr/bin/env node
/*
 * Build for the Backlog Sections plugin. Plain node, no dependencies.
 *
 *   node build.js          writes dist/<files>, dist/backlog-sections-<version>.zip and dist/backlog-sections.zip
 *
 * The only transformation is inlining src/core.js into plugin.js and
 * index.html at the `@@CORE@@` marker, so both halves of the plugin share one
 * copy of the configuration and resolution logic. The ZIP is written by hand
 * (local headers, central directory, end record) because node has no archive
 * API and the plugin must stay dependency-free. The test suite imports this
 * module and assembles the same files in memory.
 */
'use strict';

// Shared with the Tag Groups plugin (same author): inlining of core.js and the
// English strings at the @@CORE@@ marker, validation, and a dependency-free ZIP
// writer; only the plugin-specific names differ.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const CORE_MARKER = '/* @@CORE@@ */';

// Limits mirrored from the host (src/app/plugins/plugin.const.ts): index.html
// and the manifest share the 100 KB cap, plugin.js has 5 MB.
const MAX_INDEX_HTML_BYTES = 100 * 1024;
const MAX_PLUGIN_JS_BYTES = 5 * 1024 * 1024;

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/*
 * core.js plus the English strings. The strings are the last-resort fallback
 * for when the host has no translations registered for the plugin (older
 * hosts, a failed upload, a missing language): the UI then still reads as
 * English prose instead of raw keys. The host's translate() stays the primary
 * source, so the app language is followed whenever the host can provide it.
 */
function assembleCoreBlock() {
  const core = readSrc('core.js').trimEnd();
  // '<' is escaped so the block can never close the <script> it sits in.
  const english = JSON.stringify(JSON.parse(readSrc('i18n/en.json'))).replace(/</g, '\\u003c');
  return `${core}
// English strings embedded by the build; used only when the host cannot translate a key.
var BacklogSectionsEnglish = ${english};`;
}

function inlineCore(text, name) {
  if (text.indexOf(CORE_MARKER) === -1) {
    throw new Error(`${name} has no ${CORE_MARKER} marker to inline core.js into`);
  }
  const block = assembleCoreBlock();
  return text.replace(CORE_MARKER, () => block);
}

function assemblePluginJs() {
  return inlineCore(readSrc('plugin.js'), 'plugin.js');
}

function assembleIndexHtml() {
  return inlineCore(readSrc('index.html'), 'index.html');
}

function readManifest() {
  return JSON.parse(readSrc('manifest.json'));
}

function flattenKeys(obj, prefix) {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

/* Everything that goes into the ZIP, as { name, data } with forward-slash names. */
function buildFiles() {
  const manifest = readManifest();
  const files = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'plugin.js', data: Buffer.from(assemblePluginJs()) },
    { name: 'index.html', data: Buffer.from(assembleIndexHtml()) },
  ];
  if (manifest.icon) {
    files.push({ name: manifest.icon, data: Buffer.from(readSrc(manifest.icon)) });
  }
  const languages = (manifest.i18n && manifest.i18n.languages) || [];
  for (const lang of languages) {
    files.push({ name: `i18n/${lang}.json`, data: Buffer.from(readSrc(`i18n/${lang}.json`)) });
  }
  return files;
}

/* Checks that would otherwise only surface as a silent failure inside the host. */
function validate(files) {
  const byName = Object.fromEntries(files.map((f) => [f.name, f.data]));
  const problems = [];

  const manifest = JSON.parse(byName['manifest.json'].toString('utf8'));
  if (!manifest.id || manifest.id.includes(':')) {
    problems.push('manifest id is missing or contains ":"');
  }
  for (const field of ['name', 'version', 'minSupVersion']) {
    if (!manifest[field]) {
      problems.push(`manifest is missing "${field}"`);
    }
  }
  if (!Array.isArray(manifest.hooks) || !Array.isArray(manifest.permissions)) {
    problems.push('manifest hooks and permissions must be arrays');
  }
  if (manifest.iFrame !== true) {
    problems.push('manifest must set iFrame: true for the settings screen');
  }

  const languages = (manifest.i18n && manifest.i18n.languages) || [];
  if (!languages.includes('en')) {
    problems.push('i18n.languages must include "en" (the host falls back to it)');
  }
  let referenceKeys = null;
  for (const lang of languages) {
    const data = byName[`i18n/${lang}.json`];
    if (!data) {
      problems.push(`i18n/${lang}.json is declared but missing`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch (e) {
      problems.push(`i18n/${lang}.json is not valid JSON: ${e.message}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push(`i18n/${lang}.json must contain a JSON object`);
      continue;
    }
    const keys = flattenKeys(parsed, '');
    if (referenceKeys === null) {
      referenceKeys = keys;
    } else if (JSON.stringify(keys) !== JSON.stringify(referenceKeys)) {
      const missing = referenceKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !referenceKeys.includes(k));
      problems.push(
        `i18n/${lang}.json keys differ from the first language: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
      );
    }
  }

  for (const name of ['plugin.js', 'index.html']) {
    if (byName[name].toString('utf8').includes(CORE_MARKER)) {
      problems.push(`${name} still contains the ${CORE_MARKER} marker`);
    }
  }
  if (byName['index.html'].length > MAX_INDEX_HTML_BYTES) {
    problems.push(`index.html is ${byName['index.html'].length} bytes; the host accepts at most ${MAX_INDEX_HTML_BYTES}`);
  }
  if (byName['plugin.js'].length > MAX_PLUGIN_JS_BYTES) {
    problems.push(`plugin.js is ${byName['plugin.js'].length} bytes; the host accepts at most ${MAX_PLUGIN_JS_BYTES}`);
  }
  try {
    // Same wrapper the host uses; constructing the function parses the code.
    new Function('plugin', 'PluginAPI', `'use strict';\ntry {\n${byName['plugin.js'].toString('utf8')}\n} catch (error) { throw error; }`);
  } catch (e) {
    problems.push(`plugin.js does not parse: ${e.message}`);
  }
  if (manifest.icon && !byName[manifest.icon]) {
    problems.push(`icon "${manifest.icon}" is declared but missing`);
  }

  return problems;
}

// ---- minimal ZIP writer ------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/*
 * entries: [{ name, data: Buffer }]. Deflate is used when it actually shrinks
 * the entry, otherwise the entry is stored; fflate (the host's unzipper)
 * handles both. Names are ASCII here, so no UTF-8 flag is needed, but it is
 * set anyway for correctness should a non-ASCII name ever be added.
 */
function zip(entries, date) {
  const { time, date: dosDate } = dosDateTime(date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const stored = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const flags = 0x0800; // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, stored);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + stored.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

/* Reads a ZIP written by zip() back into { name, data } entries; used by the tests. */
function unzip(buf) {
  const endOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) {
    throw new Error('end of central directory not found');
  }
  const count = buf.readUInt16LE(endOffset + 10);
  let pos = buf.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('bad central directory entry');
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(stored) : Buffer.from(stored);
    if (crc32(data) !== crc) {
      throw new Error(`crc mismatch for ${name}`);
    }
    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---- main ----------------------------------------------------------------------

function build() {
  const files = buildFiles();
  const problems = validate(files);
  if (problems.length) {
    throw new Error('Build aborted:\n- ' + problems.join('\n- '));
  }
  const manifest = readManifest();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const file of files) {
    const target = path.join(DIST, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  const zipName = `${manifest.id}-${manifest.version}.zip`;
  const zipBuf = zip(files);
  fs.writeFileSync(path.join(DIST, zipName), zipBuf);
  // A stable name next to the versioned one, so the README can link to the
  // current build without being edited on every release.
  fs.writeFileSync(path.join(DIST, `${manifest.id}.zip`), zipBuf);
  return { files, zipName, zipBuf };
}

if (require.main === module) {
  try {
    const { files, zipName, zipBuf } = build();
    for (const file of files) {
      console.log(`  ${file.name.padEnd(16)} ${String(file.data.length).padStart(7)} bytes`);
    }
    console.log(`Wrote dist/${zipName} (${zipBuf.length} bytes)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = {
  CORE_MARKER,
  assembleCoreBlock,
  assemblePluginJs,
  assembleIndexHtml,
  readManifest,
  readSrc,
  buildFiles,
  validate,
  flattenKeys,
  zip,
  unzip,
  crc32,
  build,
};

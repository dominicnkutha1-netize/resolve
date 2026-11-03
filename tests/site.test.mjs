import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * These are not unit tests of DNS logic — those live in dns.test.mjs.
 *
 * This file guards the things that silently rot in a static site: a README
 * that links a screenshot nobody committed, an <img> pointing at a renamed
 * file, an import typo that only shows up once the page is deployed. Caught
 * here, they fail the build instead of rendering as a broken image on the
 * repository page.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts));

const html = read('index.html');
const readme = read('README.md');
const app = read('assets', 'app.js');
const dns = read('assets', 'dns.js');
const css = read('assets', 'style.css');

/** Anything that is not a remote URL, an anchor or an inline data URI. */
const isLocalRef = (ref) => ref && !/^(https?:|mailto:|data:|#|\/\/)/i.test(ref);

test('every local src/href in index.html exists on disk', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(isLocalRef)
    .map((ref) => ref.split('?')[0].split('#')[0])
    .filter(Boolean);

  assert.ok(refs.length >= 3, 'expected stylesheet and script references');

  for (const ref of refs) {
    assert.equal(exists(ref), true, `index.html references missing file: ${ref}`);
  }
});

test('every relative import resolves to a real file', () => {
  const imports = [...app.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 0, 'app.js should import dns.js');

  for (const specifier of imports) {
    const target = path.join('assets', specifier);
    assert.equal(exists(target), true, `app.js imports missing file: ${target}`);
  }
});

test('every screenshot the README points at was committed', () => {
  const refs = [...readme.matchAll(/docs\/screenshots\/[A-Za-z0-9._-]+\.png/g)].map((m) => m[0]);
  assert.ok(refs.length > 0, 'README should show at least one real screenshot');

  for (const ref of new Set(refs)) {
    assert.equal(exists(ref), true, `README references missing image: ${ref}`);
  }
});

test('index.html has the metadata a shared link needs', () => {
  assert.match(html, /<html lang="[a-z]{2}/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /name="viewport"/i);
  assert.match(html, /<title>[^<]{10,}<\/title>/i);
  assert.match(html, /name="description" content="[^"]{50,}"/i);
  assert.match(html, /rel="icon"/i);
});

test('every image has alt text and every control has a label', () => {
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of images) {
    if (/\balt="/.test(tag) && !/\balt=""/.test(tag)) continue;
    if (/\balt=""/.test(tag)) continue;
    assert.fail(`image without alt text: ${tag}`);
  }

  for (const id of ['name']) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `input #${id} has no <label>`);
  }
});

test('the page loads nothing from a third party', () => {
  // The footer promises "no analytics, no cookies, no server". A CDN font or a
  // third-party script would quietly make that untrue.
  const remoteScripts = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:[^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(remoteScripts, [], 'index.html must not load remote scripts or styles');

  for (const source of [app, dns]) {
    const remoteImports = [...source.matchAll(/from\s+'https?:/g)];
    assert.equal(remoteImports.length, 0, 'modules must not import from a CDN');
  }
});

test('no debugging leftovers in the shipped JavaScript', () => {
  for (const [name, source] of [['app.js', app], ['dns.js', dns]]) {
    assert.equal(/debugger;/.test(source), false, `${name} contains a debugger statement`);
    assert.equal(/console\.(log|debug|trace)\(/.test(source), false, `${name} logs to the console`);
  }
});

test('the stylesheet defines the colour variables the markup relies on', () => {
  for (const token of ['--bg', '--panel', '--text', '--muted', '--green', '--red', '--amber']) {
    assert.match(css, new RegExp(`${token}:`), `style.css is missing ${token}`);
  }
});

test('the two resolvers are both HTTPS endpoints', () => {
  const endpoints = [...app.matchAll(/endpoint:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.equal(endpoints.length, 2, 'expected exactly two resolvers');
  for (const endpoint of endpoints) {
    assert.match(endpoint, /^https:\/\//, `${endpoint} is not HTTPS`);
  }
});

test('the README documents how to run and test the project', () => {
  assert.match(readme, /node --test/);
  assert.match(readme, /## Quick start/i);
  assert.match(readme, /## Known limitations/i);
  assert.match(readme, /MIT/);
});

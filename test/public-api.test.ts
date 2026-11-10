/**
 * The hotfix must not change the public API (1.4.4 is a patch release).
 *
 * Builds the type declarations from src/ into a temporary folder and compares
 * them with the PUBLISHED 1.4.3 declarations (npm alias `sdk-1.4.3`).
 *
 * The only allowed difference is the optional debug hooks agreed for 1.4.4
 * (plan step 11): `onRequest?` / `onResponse?` on EncatchConfig and their info
 * types, named in ALLOWED_NEW_TYPES. Anything else fails this test.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PUBLISHED = path.join(ROOT, 'node_modules/sdk-1.4.3/dist/index.d.ts');
const ALLOWED_NEW_TYPES = ['EncatchRequestInfo', 'EncatchResponseInfo'];

function buildDeclarations(): string {
  const out = mkdtempSync(path.join(tmpdir(), 'encatch-api-'));
  try {
    execFileSync(path.join(ROOT, 'node_modules/.bin/tsup'), ['--dts-only', '--dts-resolve', '--out-dir', out], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    return readFileSync(path.join(out, 'index.d.ts'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Drops comments, blank lines and `private` class members. Private members are
 * written into .d.ts files but can't be used outside the class, so they aren't
 * public API; a member made public would still show up as a new public line.
 */
function normalise(dts: string): string {
  return dts
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*private (readonly )?[\w$]+;\s*$/gm, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
}

/** Removes `onRequest?:` / `onResponse?:` members, including ones that span several lines. */
function withoutHookMembers(dts: string): string {
  const lines = dts.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*on(Request|Response)\?:/.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    // Skip until brackets balance and the member ends with ';'.
    let depth = 0;
    for (; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if ('({['.includes(ch)) depth++;
        if (')}]'.includes(ch)) depth--;
      }
      if (depth <= 0 && lines[i].trimEnd().endsWith(';')) break;
    }
  }
  return kept.join('\n');
}

/** Removes the allowed 1.4.4 additions, so what's left must equal 1.4.3. */
function withoutAllowedAdditions(dts: string): string {
  let out = withoutHookMembers(dts);
  for (const name of ALLOWED_NEW_TYPES) {
    out = out
      .replace(new RegExp(`^(export )?(declare )?interface ${name}\\b[\\s\\S]*?^}\\n?`, 'm'), '')
      .replace(new RegExp(`^(export )?(declare )?type ${name}\\b[^;]*;\\n?`, 'm'), '')
      .replace(new RegExp(`\\s*(type )?${name},?`, 'g'), '');
  }
  return normalise(out);
}

describe('public API', () => {
  it('matches the published 1.4.3 declarations (apart from the allowed optional debug hooks)', () => {
    const built = buildDeclarations();
    const published = normalise(readFileSync(PUBLISHED, 'utf8'));
    expect(withoutAllowedAdditions(built)).toBe(published);
  }, 60_000);
});

describe('built package', () => {
  it('embeds the package.json version as the reported SDK version', () => {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const out = mkdtempSync(path.join(tmpdir(), 'encatch-build-'));
    try {
      execFileSync(path.join(ROOT, 'node_modules/.bin/tsup'), ['--out-dir', out], { cwd: ROOT, stdio: 'pipe' });
      for (const file of ['index.js', 'index.mjs']) {
        const code = readFileSync(path.join(out, file), 'utf8');
        expect(code).toContain(`SDK_VERSION = true ? ${JSON.stringify(version)}`);
        expect(code).not.toContain('__ENCATCH_SDK_VERSION__');
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

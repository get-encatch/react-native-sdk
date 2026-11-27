/**
 * 1.5.0 may only add to the public API, never change or remove anything.
 *
 * Builds the type declarations from src/ into a temporary folder and compares
 * them with the PUBLISHED 1.4.4 declarations (npm alias `sdk-1.4.4`).
 *
 * The only allowed differences are the 1.5.0 additions listed in
 * ALLOWED_NEW_MEMBERS. Anything else fails this test.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PUBLISHED = path.join(ROOT, 'node_modules/sdk-1.4.4/dist/index.d.ts');
/** New one-line members in 1.5.0, as they appear in the declarations. */
const ALLOWED_NEW_MEMBERS = [
  // Encatch.isIdentified()
  'isIdentified(): boolean;',
  // Internal setter used by EncatchProvider for autoStartVisitorSession
  '_setAutoStartVisitorSession(enabled: boolean): void;',
  // EncatchProvider prop
  'autoStartVisitorSession?: boolean;',
  // EncatchConfig option
  'persistUserAcrossRestarts?: boolean;',
  // Encatch.setUserProperties() and the hook's setUserProperties
  'setUserProperties(userName: string, traits: UserTraits): Promise<void>;',
  'setUserProperties: (userName: string, traits: UserTraits) => void;',
];

/**
 * Lines changed in 1.5.0, new form -> published 1.4.4 form: only additions to a
 * union (two new onResponse skip reasons).
 */
const ALLOWED_CHANGED_LINES: Record<string, string> = {
  "reason?: 'rate-limited' | 'collapsed' | 'duplicate' | 'signature-expired' | 'visitor' | 'survey-open' | 'not-identified' | 'wrong-user';":
    "reason?: 'rate-limited' | 'collapsed' | 'duplicate' | 'signature-expired' | 'visitor' | 'survey-open';",
};

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

/** Removes the allowed 1.5.0 additions, so what's left must equal 1.4.4. */
function withoutAllowedAdditions(dts: string): { rest: string; found: string[] } {
  const found: string[] = [];
  const rest = normalise(dts)
    .split('\n')
    .filter((l) => {
      const allowed = ALLOWED_NEW_MEMBERS.includes(l.trim());
      if (allowed) found.push(l.trim());
      return !allowed;
    })
    .map((l) => {
      const was = ALLOWED_CHANGED_LINES[l.trim()];
      return was === undefined ? l : l.replace(l.trim(), was);
    })
    .join('\n');
  return { rest, found };
}

describe('public API', () => {
  it('matches the published 1.4.4 declarations, apart from the 1.5.0 additions', () => {
    const built = buildDeclarations();
    const published = normalise(readFileSync(PUBLISHED, 'utf8'));
    const { rest, found } = withoutAllowedAdditions(built);
    expect(rest).toBe(published);
    // Each addition is really there (the list doesn't hide a removed member).
    expect([...new Set(found)].sort()).toEqual([...ALLOWED_NEW_MEMBERS].sort());
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

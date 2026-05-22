/**
 * Unit tests for `loginMaxance` (M8.T2).
 *
 * The real Stagehand is replaced with a `StubStagehand` that records every
 * `act` / `extract` / `goto` call and returns scripted responses. No network,
 * no Chromium, no Anthropic spend — runs in <100ms per case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginMaxance } from '../../src/maxance/login.js';
import type { HumanActionResolver, MaxancePageType } from '../../src/maxance/types.js';

/**
 * Minimal Page stand-in. Captures every `act` call and serves a 1-byte PNG
 * for `screenshot()` so the on-disk capture path runs without coupling the
 * test to Playwright internals.
 */
class StubPage {
  goto = async (_url: string, _opts: unknown): Promise<void> => {
    this.gotos.push(_url);
  };
  url = (): string => this.currentUrl;
  title = async (): Promise<string> => 'stub';
  screenshot = async (_opts: { type: 'png'; fullPage: boolean }): Promise<Buffer> =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  gotos: string[] = [];
  currentUrl = 'https://www.maxance.com/Proximeo/home';
}

/**
 * Configurable double for the Stagehand instance. The test scripts the
 * sequence of `pageType` responses for `extract` and (optionally) the
 * responses for `act`. Every call is recorded for assertion.
 */
class StubStagehand {
  page = new StubPage();
  context = { activePage: (): StubPage => this.page };

  extractResponses: MaxancePageType[] = [];
  actCalls: { instruction: string; variables?: Record<string, string> }[] = [];
  extractCalls: string[] = [];
  actImpl: ((instruction: string) => Promise<void> | void) | undefined;

  extract = async <T extends { pageType: MaxancePageType }>(
    instruction: string,
    _schema: unknown,
  ): Promise<T> => {
    this.extractCalls.push(instruction);
    const next = this.extractResponses.shift();
    if (!next) {
      throw new Error('StubStagehand: ran out of scripted extract responses');
    }
    return { pageType: next } as T;
  };

  act = async (
    instruction: string,
    opts?: { variables?: Record<string, string> },
  ): Promise<void> => {
    this.actCalls.push({ instruction, ...(opts?.variables ? { variables: opts.variables } : {}) });
    if (this.actImpl) await this.actImpl(instruction);
  };
}

// Cast helper — `loginMaxance` takes the real `Stagehand` type; our stub is
// structurally compatible for the surface it touches. Casting via `unknown`
// keeps the test honest about the bypass.
const asStagehand = <T>(s: T): import('@browserbasehq/stagehand').Stagehand =>
  s as unknown as import('@browserbasehq/stagehand').Stagehand;

let dataDir: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'f16-maxance-test-'));
  process.env.MAXANCE_USERNAME = 'test-broker.FAKE123';
  process.env.MAXANCE_PASSWORD = 'p@ssw0rd-test-only';
  process.env.MAXANCE_BASE_URL = 'https://extranet.maxance.com/MaXance/';
});

function restoreEnvKey(k: 'MAXANCE_USERNAME' | 'MAXANCE_PASSWORD' | 'MAXANCE_BASE_URL'): void {
  // Reassign by literal key rather than computed delete — keeps eslint
  // `no-dynamic-delete` happy and is functionally equivalent for our purposes.
  const original = ORIGINAL_ENV[k];
  if (original === undefined) {
    process.env[k] = '';
  } else {
    process.env[k] = original;
  }
}

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  // Restore env so we don't leak across tests.
  restoreEnvKey('MAXANCE_USERNAME');
  restoreEnvKey('MAXANCE_PASSWORD');
  restoreEnvKey('MAXANCE_BASE_URL');
});

const noResolver: HumanActionResolver = async () => {
  throw new Error('humanActionResolver should not have been called');
};

describe('loginMaxance — happy path', () => {
  it('login_form → password_form → dashboard → proximeo_home returns success', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form', 'password_form', 'dashboard', 'proximeo_home'];

    const out = await loginMaxance(asStagehand(sh), 'sess-1', {
      humanActionResolver: noResolver,
      dataRoot: dataDir,
    });

    expect(out.alreadyLoggedIn).toBe(false);
    expect(out.requiredHumanAction).toBe(false);
    expect(out.finalUrl).toMatch(/maxance/);
    expect(out.screenshots.length).toBeGreaterThanOrEqual(3);
    // Credentials should have been passed via `variables`, not interpolated.
    // Match on the placeholder token so we land on the fill-act (not the
    // sibling "Click Continuer" act whose text mentions the word "password").
    const userAct = sh.actCalls.find((c) => c.instruction.includes('%username%'));
    expect(userAct?.variables?.username).toBe('test-broker.FAKE123');
    expect(userAct?.instruction).not.toContain('test-broker.FAKE123');
    const passAct = sh.actCalls.find((c) => c.instruction.includes('%password%'));
    expect(passAct?.variables?.password).toBe('p@ssw0rd-test-only');
    expect(passAct?.instruction).not.toContain('p@ssw0rd-test-only');
  });

  it('already-logged-in fast path skips credential entry', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['dashboard', 'proximeo_home'];

    const out = await loginMaxance(asStagehand(sh), 'sess-warm', {
      humanActionResolver: noResolver,
      dataRoot: dataDir,
    });

    expect(out.alreadyLoggedIn).toBe(true);
    expect(out.requiredHumanAction).toBe(false);
    // No username/password act should have fired.
    expect(sh.actCalls.find((c) => c.instruction.includes('username'))).toBeUndefined();
    expect(sh.actCalls.find((c) => c.instruction.includes('password'))).toBeUndefined();
    // The "Accès Proximéo" click should have happened.
    expect(sh.actCalls.find((c) => c.instruction.includes('Accès Proximéo'))).toBeDefined();
  });

  it('already on Proximéo home returns alreadyLoggedIn=true without SSO click', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['proximeo_home', 'proximeo_home'];

    const out = await loginMaxance(asStagehand(sh), 'sess-prox', {
      humanActionResolver: noResolver,
      dataRoot: dataDir,
    });

    expect(out.alreadyLoggedIn).toBe(true);
    // No SSO bounce click since we were already there.
    expect(sh.actCalls.find((c) => c.instruction.includes('Accès Proximéo'))).toBeUndefined();
  });
});

describe('loginMaxance — 2FA branch', () => {
  it('login_form → password_form → sms_prompt → dashboard → proximeo_home with resolver', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = [
      'login_form', // initial classification
      'password_form', // post-identifiant-submit (step 2 of auth)
      'sms_prompt', // post-password-submit
      'dashboard', // post-2FA
      'proximeo_home', // post-SSO confirm
    ];
    let resolverCalls = 0;
    const resolver: HumanActionResolver = async (req) => {
      resolverCalls += 1;
      expect(req.summary).toMatch(/SMS/);
      expect(req.options[0]?.type).toBe('free_text');
      return '123456';
    };

    const out = await loginMaxance(asStagehand(sh), 'sess-2fa', {
      humanActionResolver: resolver,
      dataRoot: dataDir,
    });

    expect(resolverCalls).toBe(1);
    expect(out.requiredHumanAction).toBe(true);
    // The 2FA code submission should have used variable substitution.
    const codeAct = sh.actCalls.find((c) => c.instruction.includes('SMS'));
    expect(codeAct?.variables?.code).toBe('123456');
    expect(codeAct?.instruction).not.toContain('123456');
  });

  it('2FA resolver timeout throws maxance_2fa_timeout', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form', 'password_form', 'sms_prompt'];
    const resolver: HumanActionResolver = () => new Promise(() => undefined); // never resolves

    await expect(
      loginMaxance(asStagehand(sh), 'sess-timeout', {
        humanActionResolver: resolver,
        dataRoot: dataDir,
        twoFactorTimeoutMs: 50,
      }),
    ).rejects.toThrow(/maxance_2fa_timeout/);
  });

  it('2FA resolver returns empty code → throws maxance_2fa_empty_code', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form', 'password_form', 'sms_prompt'];
    const resolver: HumanActionResolver = async () => '   ';

    await expect(
      loginMaxance(asStagehand(sh), 'sess-empty', {
        humanActionResolver: resolver,
        dataRoot: dataDir,
      }),
    ).rejects.toThrow(/maxance_2fa_empty_code/);
  });

  it('initial sms_prompt (resumed session) flows through resolver', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['sms_prompt', 'dashboard', 'proximeo_home'];
    const resolver: HumanActionResolver = async () => '654321';

    const out = await loginMaxance(asStagehand(sh), 'sess-resume', {
      humanActionResolver: resolver,
      dataRoot: dataDir,
    });

    expect(out.requiredHumanAction).toBe(true);
    expect(out.alreadyLoggedIn).toBe(false);
  });
});

describe('loginMaxance — failure modes', () => {
  it('bad credentials: login_form persists after submit', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form', 'password_form', 'login_form'];

    await expect(
      loginMaxance(asStagehand(sh), 'sess-bad', {
        humanActionResolver: noResolver,
        dataRoot: dataDir,
      }),
    ).rejects.toThrow(/maxance_bad_credentials/);
  });

  it('unknown initial page throws + escalates with type tag', async () => {
    const sh = new StubStagehand();
    // detectPage retries up to 3 times on 'unknown' before giving up — supply
    // enough responses to exhaust the retry budget.
    sh.extractResponses = ['unknown', 'unknown', 'unknown'];

    await expect(
      loginMaxance(asStagehand(sh), 'sess-unknown', {
        humanActionResolver: noResolver,
        dataRoot: dataDir,
      }),
    ).rejects.toThrow(/maxance_unexpected_initial_page:unknown/);
  });

  it('proximeo_not_loaded if Proximéo confirm fails after SSO', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['dashboard', 'unknown'];

    await expect(
      loginMaxance(asStagehand(sh), 'sess-no-proximeo', {
        humanActionResolver: noResolver,
        dataRoot: dataDir,
      }),
    ).rejects.toThrow(/maxance_proximeo_not_loaded:unknown/);
  });

  it('missing credentials → throws cleanly without echoing env', async () => {
    // Clearing to empty triggers the same "unset or placeholder" guard;
    // avoids eslint no-dynamic-delete on `delete process.env.X`.
    process.env.MAXANCE_USERNAME = '';
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form'];

    await expect(
      loginMaxance(asStagehand(sh), 'sess-nocreds', {
        humanActionResolver: noResolver,
        dataRoot: dataDir,
      }),
    ).rejects.toThrow(/MAXANCE_USERNAME/);
  });
});

describe('loginMaxance — credentials safety', () => {
  it('never leaks credentials in screenshots metadata or filenames', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form', 'password_form', 'dashboard', 'proximeo_home'];

    await loginMaxance(asStagehand(sh), 'sess-safety', {
      humanActionResolver: noResolver,
      dataRoot: dataDir,
    });

    const dir = join(dataDir, 'screenshots');
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).not.toContain('test-broker');
      expect(f).not.toContain('p@ssw0rd');
    }
  });

  it('redacts credentials from thrown error messages', async () => {
    const sh = new StubStagehand();
    sh.extractResponses = ['login_form', 'password_form', 'login_form'];
    // Make an act call throw with a message containing the password — proves
    // the redactor strips it before re-throwing.
    sh.actImpl = (instruction: string) => {
      // Trigger on the password-step click (after the "Mot de passe" fill).
      if (instruction.includes('sign in after the Mot de passe')) {
        throw new Error(`network error logging in for p@ssw0rd-test-only`);
      }
    };

    let thrown: Error | undefined;
    try {
      await loginMaxance(asStagehand(sh), 'sess-redact', {
        humanActionResolver: noResolver,
        dataRoot: dataDir,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain('p@ssw0rd-test-only');
    expect(thrown?.message).toContain('<redacted>');
  });
});

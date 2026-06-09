/**
 * Pure-function tests for the ads-approval error humanizer.
 *
 * `humanizeLaunchError` turns a raw Meta Graph error string into the
 * plain-French message Ridaa/Achraf read in the WhatsApp operator group — the
 * group must NEVER see raw JSON. No DB / network — ~1ms.
 */
import { describe, expect, it } from 'vitest';
import { humanizeLaunchError } from '../../../src/agents/ads-manager-agent/approval.js';

const META_TOS_ERROR =
  'Meta POST /act_27386160994320240/adsets -> 400: ' +
  '{"error":{"message":"Invalid parameter","type":"OAuthException","code":100,' +
  '"error_subcode":1815089,"is_transient":false,' +
  '"error_user_title":"Terms of Service Not Accepted","error_user_msg":"You have not accepted the ToS"}}';

describe('humanizeLaunchError', () => {
  it('explains the Lead Ads ToS error in French with the ToS link (by subcode 1815089)', () => {
    const out = humanizeLaunchError(META_TOS_ERROR);
    expect(out).toContain('Lead Ads');
    expect(out).toContain('https://www.facebook.com/legal/leadgen/tos');
    expect(out).toContain('relancer');
    // Never leak raw JSON / the Graph path.
    expect(out).not.toContain('error_subcode');
    expect(out).not.toContain('{');
    expect(out).not.toContain('/act_');
  });

  it('detects the ToS error by its title even without the subcode', () => {
    const out = humanizeLaunchError('400: Terms of Service Not Accepted');
    expect(out).toContain('Lead Ads');
    expect(out).toContain('leadgen/tos');
  });

  it("surfaces Meta's user-facing message for other errors (no raw JSON)", () => {
    const raw =
      'Meta POST /act_1/adsets -> 400: {"error":{"message":"Invalid parameter",' +
      '"error_user_msg":"Le budget quotidien est trop bas pour cette enchère."}}';
    const out = humanizeLaunchError(raw);
    expect(out).toContain('Lancement de la campagne impossible');
    expect(out).toContain('Le budget quotidien est trop bas');
    expect(out).not.toContain('{');
    expect(out).not.toContain('error_user_msg');
  });

  it('falls back to the top-level message when no user-facing message exists', () => {
    const raw = 'Meta POST /act_1/ads -> 400: {"error":{"message":"Unsupported post request."}}';
    const out = humanizeLaunchError(raw);
    expect(out).toContain('Unsupported post request.');
    expect(out).not.toContain('{');
  });

  it('uses a generic French fallback for an unparseable error (never raw output)', () => {
    const out = humanizeLaunchError('ECONNRESET socket hang up');
    expect(out).toContain('Lancement de la campagne impossible');
    expect(out).toContain('logs');
    // The raw technical string must not be echoed to the operator.
    expect(out).not.toContain('ECONNRESET');
  });
});

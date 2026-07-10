#!/usr/bin/env bash
# F16 M10 V2 — Asterisk OpenAI Realtime NATIVE SIP setup (idempotent).
#
# Captures the WSL/Asterisk config the voice channel needs, so it is
# reproducible + version-controlled (instead of living only in the distro).
# Run INSIDE the WSL Ubuntu distro as root:
#
#   OPENAI_PROJECT_ID=proj_xxx bash asterisk-openai-setup.sh
#
# Or from Windows:
#   wsl -d Ubuntu -u root -- bash -lc \
#     "OPENAI_PROJECT_ID=proj_xxx bash '/mnt/c/Users/Rlefr/Desktop/Platforms Factory/Assuryal/F16/scripts/deploy/asterisk-openai-setup.sh'"
#
# Safe to re-run: every block is guarded by a marker grep. No secrets here —
# the OVH trunk creds live in pjsip.conf separately; the project id is an
# identifier (not a secret) passed via OPENAI_PROJECT_ID.
#
# What it does:
#   1. pjsip.conf  : TLS transport (:5061) + [openai] endpoint/AOR to
#                    sip:$PROJECT_ID@sip.api.openai.com;transport=tls
#   2. extensions.conf : f16-openai-{probe,probe-id,bridge,stamp,in} contexts
#                        (bridge stamps X-F16-Session + records via MixMonitor)
#   3. modules.conf : noload res_resolver_unbound.so  (WSL "0 viable targets" fix)
#   4. logger.conf  : ensure the `full` log captures verbose+debug (SIP trace)
#   5. reload / restart as needed
set -euo pipefail

PJSIP=/etc/asterisk/pjsip.conf
EXTEN=/etc/asterisk/extensions.conf
MODULES=/etc/asterisk/modules.conf
LOGGER=/etc/asterisk/logger.conf
PROJECT_ID="${OPENAI_PROJECT_ID:-}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: set OPENAI_PROJECT_ID=proj_... (from platform.openai.com → Settings → General)" >&2
  exit 1
fi

ts=$(date +%Y%m%d-%H%M%S)

# ---------------------------------------------------------------------------
# 1. pjsip.conf — TLS transport + OpenAI endpoint/AOR
# ---------------------------------------------------------------------------
if grep -q '^\[openai\]' "$PJSIP"; then
  echo "pjsip: [openai] already present — skipping"
else
  cp "$PJSIP" "$PJSIP.bak.$ts"
  # NOTE: the ';transport=tls' in the contact MUST be escaped as '\;'
  # (';' is a comment char in Asterisk config).
  cat >> "$PJSIP" <<EOF

;==============================================================================
; OpenAI Realtime NATIVE SIP (M10 V2) — added by asterisk-openai-setup.sh
;==============================================================================
[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:5061
method=tlsv1_2

[openai]
type=aor
contact=sip:${PROJECT_ID}@sip.api.openai.com\\;transport=tls

[openai]
type=endpoint
transport=transport-tls
context=f16-openai-in
disallow=all
allow=ulaw
allow=alaw
aors=openai
from_user=${PROJECT_ID}
from_domain=sip.api.openai.com
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
EOF
  echo "pjsip: appended TLS transport + [openai] endpoint (backup $PJSIP.bak.$ts)"
fi

# ---------------------------------------------------------------------------
# 2. extensions.conf — OpenAI dialplan contexts
# ---------------------------------------------------------------------------
if grep -q '^\[f16-openai-bridge\]' "$EXTEN"; then
  echo "extensions: f16-openai-* already present — skipping"
else
  cp "$EXTEN" "$EXTEN.bak.$ts"
  cat >> "$EXTEN" <<'EOF'

;==============================================================================
; OpenAI Realtime NATIVE SIP (M10 V2) — added by asterisk-openai-setup.sh
;==============================================================================
; No-human smoke: greet to nobody (watch backend log for the greeting).
[f16-openai-probe]
exten => s,1,NoOp(F16 OpenAI probe)
 same => n,Answer()
 same => n,Wait(30)
 same => n,Hangup()

; No-human identity probe: stamps a fixed session id, dials OpenAI.
[f16-openai-probe-id]
exten => s,1,Answer()
 same => n,Set(__F16SESSION=f16-probe-id)
 same => n,Dial(PJSIP/openai,30,b(f16-openai-stamp^s^1))
 same => n,Hangup()

; Outbound bridge: customer answers via OVH -> bridge to OpenAI; record + stamp.
; 2026-07-10: OpenAI's SIP edge answers in ~2s when healthy but intermittently
; never delivers the 200 OK (3 of 4 live calls that day) — 60s of dead silence
; before the drop. Dial 20s, then ONE fresh re-INVITE before giving up.
[f16-openai-bridge]
exten => s,1,NoOp(F16 bridge -> OpenAI session=${AS_UUID})
 same => n,Answer()
 same => n,MixMonitor(${AS_UUID}.wav,b,)
 same => n,Dial(PJSIP/openai,20,b(f16-openai-stamp^s^1))
 same => n,NoOp(F16 openai dial 1 status=${DIALSTATUS})
 same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?done)
 same => n,Dial(PJSIP/openai,20,b(f16-openai-stamp^s^1))
 same => n,NoOp(F16 openai dial 2 status=${DIALSTATUS})
 same => n(done),Hangup()

; Predial gosub (runs on the OpenAI leg before INVITE): stamp X-F16-Session
; from the per-call master channel (concurrency-safe), global as fallback.
[f16-openai-stamp]
exten => s,1,Set(PJSIP_HEADER(add,X-F16-Session)=${IF($["${MASTER_CHANNEL(AS_UUID)}" != ""]?${MASTER_CHANNEL(AS_UUID)}:${F16SESSION})})
 same => n,Return()

; Inbound from OpenAI (if any) — audio is bridged by Dial.
[f16-openai-in]
exten => s,1,NoOp(F16 openai inbound)
 same => n,Hangup()
exten => _X.,1,NoOp(F16 openai inbound ext)
 same => n,Hangup()
EOF
  echo "extensions: appended f16-openai-* contexts (backup $EXTEN.bak.$ts)"
fi

# ---------------------------------------------------------------------------
# 3. modules.conf — disable unbound resolver (WSL "0 viable targets" fix)
# ---------------------------------------------------------------------------
if grep -q 'noload => res_resolver_unbound.so' "$MODULES"; then
  echo "modules: unbound already disabled — skipping"
else
  cp "$MODULES" "$MODULES.bak.$ts"
  sed -i '/^autoload=yes/a noload => res_resolver_unbound.so' "$MODULES"
  echo "modules: disabled res_resolver_unbound.so (backup $MODULES.bak.$ts) — needs a restart"
  NEEDS_RESTART=1
fi

# ---------------------------------------------------------------------------
# 4. logger.conf — capture verbose+debug in the `full` log (SIP trace)
# ---------------------------------------------------------------------------
if grep -qE '^full =>.*verbose' "$LOGGER" 2>/dev/null; then
  echo "logger: full already captures verbose — skipping"
else
  cp "$LOGGER" "$LOGGER.bak.$ts" 2>/dev/null || true
  if grep -qE '^full =>' "$LOGGER" 2>/dev/null; then
    sed -i 's/^full =>.*/full => notice,warning,error,verbose,debug/' "$LOGGER"
  else
    printf '\nfull => notice,warning,error,verbose,debug\n' >> "$LOGGER"
  fi
  echo "logger: full now captures verbose+debug"
fi

# ---------------------------------------------------------------------------
# 5. apply
# ---------------------------------------------------------------------------
if [[ "${NEEDS_RESTART:-0}" == "1" ]]; then
  echo "restarting asterisk (module change)…"
  systemctl restart asterisk
  sleep 6
else
  asterisk -rx 'pjsip reload'   >/dev/null 2>&1 || true
  asterisk -rx 'dialplan reload' >/dev/null 2>&1 || true
  asterisk -rx 'logger reload'   >/dev/null 2>&1 || true
fi

echo "=== verification ==="
asterisk -rx 'pjsip show endpoint openai' 2>&1 | grep -iE 'Endpoint:|Aor:|sip.api' | head -3 || true
asterisk -rx 'pjsip show registrations' 2>&1 | grep -iE 'ovh|Registered' || true
echo "done. (Asterisk dials sip:${PROJECT_ID}@sip.api.openai.com;transport=tls)"

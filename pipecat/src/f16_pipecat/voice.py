"""Voice bridge scaffold (option F).

The V1 voice channel design (per memory/project_voice_stack.md) routes
SIP audio through a Pipecat pipeline:

    OVH SIP trunk
        │  (RTP audio)
        ▼
    Pipecat pipeline (this file, eventually)
        │  STT (Deepgram Nova-3 FR streaming)
        │  ↓
        │  POST /v1/voice/turn → F16 backend
        │  ↑    {leadId, customerId, transcript}
        │  ← {replyText} from the shared Sales Agent
        │  TTS (Azure Neural FR)
        ▼
    OVH SIP trunk → customer

Brain is SHARED with the WhatsApp Sales Agent. Pipecat is intentionally
thin — STT/TTS + HTTP shuttle.

V0 scope (this file): the FastAPI surface so the backend + admin can
exercise the contract without real SIP/Deepgram/Azure credentials.
Endpoints accept structured stubs that mirror what the live pipeline
will eventually feed in. The pipeline orchestration itself, the SIP
trunk wiring, the Deepgram + Azure adapters, and the backend's
`/v1/voice/turn` consumer all land in M10.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from f16_pipecat.logging import logger

# Module-scope ephemeral session store. Real V1 will replace this with
# whatever Pipecat exposes for call state. For V0, this lets the contract
# tests assert that session ids round-trip and that "turn before new"
# returns a 404 rather than silently creating a stub.
_SESSIONS: dict[str, dict[str, str | int]] = {}

router = APIRouter(prefix="/voice", tags=["voice"])


class StartCallRequest(BaseModel):
    """Inbound shape — what OVH SIP webhook (or admin "place a call" UI)
    POSTs to /voice/sessions/new to spawn a session."""

    direction: str = Field(
        description="inbound (customer called us) or outbound (we called them).",
        pattern=r"^(inbound|outbound)$",
    )
    lead_id: str = Field(description="F16 lead id this session belongs to.")
    customer_id: str = Field(description="F16 customer id matched on phone.")
    # E.164 phone — useful for the admin to audit which line a session ran on.
    phone: str = Field(description='Customer phone in E.164 (e.g. "+33612345678").')


class StartCallResponse(BaseModel):
    session_id: str = Field(description="Opaque session id; pass to subsequent /turn calls.")
    status: str = Field(description="ringing | live | failed (V0 always 'ringing').")


class VoiceTurnRequest(BaseModel):
    """A single STT transcript chunk from a live session. The pipeline
    calls this when Deepgram emits an end-of-utterance event."""

    session_id: str = Field(description="Session id returned by /voice/sessions/new.")
    transcript: str = Field(
        min_length=1,
        max_length=2000,
        description="French text the customer just said.",
    )


class VoiceTurnResponse(BaseModel):
    reply_text: str = Field(description="What TTS should speak back.")
    session_state: str = Field(description="live | ended | escalated.")


@router.post("/sessions/new", response_model=StartCallResponse, status_code=201)
def start_call(body: StartCallRequest) -> StartCallResponse:
    """Open a new voice session. Returns a session id used by subsequent
    /voice/turn calls.

    V0 just records the metadata; the actual SIP leg, Pipecat pipeline
    spin-up, and Deepgram subscription land in M10.
    """
    session_id = str(uuid.uuid4())
    _SESSIONS[session_id] = {
        "lead_id": body.lead_id,
        "customer_id": body.customer_id,
        "direction": body.direction,
        "phone": body.phone,
        "turns": 0,
    }
    logger.info(f"voice: opened {body.direction} session {session_id} for lead={body.lead_id}")
    return StartCallResponse(session_id=session_id, status="ringing")


@router.post("/turn", response_model=VoiceTurnResponse)
def voice_turn(body: VoiceTurnRequest) -> VoiceTurnResponse:
    """Process one customer utterance.

    V0 echoes the transcript back with a fixed French acknowledgement —
    enough to validate the round-trip end-to-end without the backend's
    Sales Agent endpoint being live. M10 replaces the echo with an HTTP
    call to F16 backend's /v1/voice/turn, which dispatches a
    CUSTOMER.MESSAGE_RECEIVED to the same Sales Agent the WhatsApp
    channel uses.
    """
    session = _SESSIONS.get(body.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")

    # Bump turn counter — useful for admin observability when the real
    # Pipecat pipeline is live.
    turns = int(session.get("turns", 0)) + 1
    session["turns"] = turns
    logger.info(
        f"voice: session={body.session_id} turn={turns} transcript_chars={len(body.transcript)}"
    )

    # V0 reply: simple echo + acknowledgement so the SIP path can be
    # exercised end-to-end without the backend bridge.
    reply = f"J'ai bien entendu : {body.transcript}. Un instant, je transmets ça à votre agent."
    return VoiceTurnResponse(reply_text=reply, session_state="live")


@router.post("/sessions/{session_id}/end", status_code=204)
def end_call(session_id: str) -> None:
    """Tear down a session. Idempotent — unknown session is a no-op."""
    if session_id in _SESSIONS:
        turns = _SESSIONS[session_id].get("turns", 0)
        del _SESSIONS[session_id]
        logger.info(f"voice: ended session {session_id} after {turns} turns")
    return None


def _reset_sessions_for_tests() -> None:
    """Test-only helper to flush the in-memory session store between cases."""
    _SESSIONS.clear()

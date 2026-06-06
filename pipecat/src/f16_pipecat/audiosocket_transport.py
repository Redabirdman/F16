"""Pipecat transport that bridges an Asterisk AudioSocket TCP stream <-> frames.

Split out from ``f16_pipecat.audiosocket`` (which holds the pure framing codec +
the TCP server) so that the heavy Pipecat transport base classes are imported
ONLY when a call actually runs — ``audiosocket.py`` and ``server.py`` stay
importable at app boot without pulling in pipecat's transport machinery (and
PIL). The codec module lazy-imports :func:`build_audiosocket_transport` from
here inside ``build_audiosocket_transport``'s public wrapper.

Design (mirrors Pipecat's ``WebsocketServerTransport`` but over a single,
already-accepted ``asyncio`` reader/writer pair):

  * ``AudioSocketInputTransport`` (``BaseInputTransport``) runs a read loop that
    decodes frames off the reader; ``0x10`` audio → ``push_audio_frame`` (feeds
    STT); ``0x00``/EOF → signals the call to end; ``0x03`` DTMF is logged.
  * ``AudioSocketOutputTransport`` (``BaseOutputTransport``) overrides
    ``write_audio_frame`` to wrap the (already 8 kHz) PCM as a ``0x10`` frame and
    write it to the socket. The base ``MediaSender`` chunks + resamples + paces,
    so TTS audio (e.g. 24 kHz from Aura-2) is resampled down to 8 kHz here.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import struct

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams

from f16_pipecat.audiosocket import (
    AUDIOSOCKET_CHANNELS,
    AUDIOSOCKET_SAMPLE_RATE,
    TYPE_AUDIO,
    TYPE_DTMF,
    TYPE_ERROR,
    TYPE_TERMINATE,
    AudioSocketProtocolError,
    encode_audio_frame,
    read_frame,
)
from f16_pipecat.logging import logger


class AudioSocketInputTransport(BaseInputTransport):
    """Reads framed TCP audio off the reader and feeds it into the pipeline."""

    def __init__(
        self,
        transport: AudioSocketTransport,
        reader: asyncio.StreamReader,
        params: TransportParams,
        **kwargs: object,
    ) -> None:
        super().__init__(params, **kwargs)
        self._as_transport = transport
        self._reader = reader
        self._read_task: asyncio.Task[None] | None = None
        self._started = False
        self._audio_frames_in = 0
        # Optional raw-PCM capture of the inbound slin stream for offline STT
        # debugging. Set F16_VOICE_DUMP_PCM=<path> to enable; default off.
        self._pcm_dump: object | None = None
        dump_path = os.environ.get("F16_VOICE_DUMP_PCM")
        if dump_path:
            try:
                self._pcm_dump = open(dump_path, "wb")  # noqa: SIM115
                logger.info(f"audiosocket: dumping inbound PCM to {dump_path}")
            except OSError as exc:
                logger.warning(f"audiosocket: could not open PCM dump: {exc}")

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        if self._started:
            return
        self._started = True
        # set_transport_ready() spins up the base audio queue/task.
        await self.set_transport_ready(frame)
        if self._read_task is None:
            logger.info(
                f"audiosocket: input start, spawning read loop (in_rate={self.sample_rate} Hz)"
            )
            self._read_task = self.create_task(self._read_loop())

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._cancel_read_task()

    async def cancel(self, frame: CancelFrame) -> None:
        await super().cancel(frame)
        await self._cancel_read_task()

    async def cleanup(self) -> None:
        # pipecat's BaseObject.cleanup is untyped; these calls are correct.
        await super().cleanup()  # type: ignore[no-untyped-call]
        await self._as_transport.cleanup()  # type: ignore[no-untyped-call]

    async def _cancel_read_task(self) -> None:
        task = self._read_task
        if task is not None:
            self._read_task = None
            await self.cancel_task(task)

    async def _read_loop(self) -> None:
        """Decode inbound frames; audio → pipeline, terminate/EOF → end call."""
        try:
            while True:
                result = await read_frame(self._reader)
                if result is None:
                    logger.info("audiosocket: peer closed connection (EOF)")
                    break
                frame_type, payload = result
                if frame_type == TYPE_AUDIO:
                    if payload:
                        self._audio_frames_in += 1
                        if self._pcm_dump is not None:
                            self._pcm_dump.write(payload)  # type: ignore[attr-defined]
                        # Log the first inbound audio frame + every ~5s (250
                        # frames @ 20ms) so we can confirm Asterisk is actually
                        # streaming media and STT is being fed, without spamming.
                        # `peak` = max |sample| (slin 16-bit LE): ~0 ⇒ silence
                        # (one-way audio / no inbound RTP), thousands ⇒ real voice.
                        if self._audio_frames_in == 1 or self._audio_frames_in % 250 == 0:
                            n = (len(payload) // 2) * 2
                            samples = struct.unpack(f"<{n // 2}h", payload[:n]) if n else ()
                            peak = max((abs(s) for s in samples), default=0)
                            logger.info(
                                f"audiosocket: inbound audio frames={self._audio_frames_in} "
                                f"peak={peak} (payload={len(payload)} B)"
                            )
                        await self.push_audio_frame(
                            InputAudioRawFrame(
                                audio=payload,
                                sample_rate=AUDIOSOCKET_SAMPLE_RATE,
                                num_channels=AUDIOSOCKET_CHANNELS,
                            )
                        )
                elif frame_type == TYPE_TERMINATE:
                    logger.info("audiosocket: received TERMINATE (0x00)")
                    break
                elif frame_type == TYPE_DTMF:
                    digit = payload.decode("ascii", "replace") if payload else ""
                    logger.info(f"audiosocket: DTMF digit={digit!r}")
                    # TODO(live): forward DTMF to the backend brain if the IVR
                    # ever needs keypad input. Not wired in V1.
                elif frame_type == TYPE_ERROR:
                    code = payload[0] if payload else -1
                    logger.warning(f"audiosocket: ERROR frame code={code}")
                else:
                    logger.debug(f"audiosocket: ignoring frame type=0x{frame_type:02x}")
        except AudioSocketProtocolError as exc:
            logger.warning(f"audiosocket: protocol error, ending call: {exc}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — last-ditch guard for the read loop
            logger.error(f"audiosocket: read loop failed: {exc}")
        finally:
            if self._pcm_dump is not None:
                with contextlib.suppress(OSError):
                    self._pcm_dump.flush()  # type: ignore[attr-defined]
                    self._pcm_dump.close()  # type: ignore[attr-defined]
            logger.info(
                f"audiosocket: read loop ended, total inbound audio frames={self._audio_frames_in}"
            )
            # Signal the transport so the runner can end the pipeline.
            self._as_transport.signal_call_ended()


class AudioSocketOutputTransport(BaseOutputTransport):
    """Wraps outbound (8 kHz) PCM as ``0x10`` frames and writes to the socket."""

    def __init__(
        self,
        transport: AudioSocketTransport,
        writer: asyncio.StreamWriter,
        params: TransportParams,
        **kwargs: object,
    ) -> None:
        super().__init__(params, **kwargs)
        self._as_transport = transport
        self._writer = writer
        self._closed = False
        self._started = False
        self._audio_frames_out = 0

    async def start(self, frame: StartFrame) -> None:
        """Mark the output transport ready so TTS audio is actually written.

        ``BaseOutputTransport.start()`` only computes the sample rate / chunk
        size; it does NOT call ``set_transport_ready()``. That method is what
        registers the default (``None``) MediaSender. Without it, every
        downstream ``OutputAudioRawFrame`` is dropped at the base class with
        "destination [None] not registered" and ``write_audio_frame`` is never
        reached — i.e. total outbound silence. Our socket is already accepted, so
        we are ready immediately (mirrors ``AudioSocketInputTransport.start``).
        """
        await super().start(frame)
        if self._started:
            return
        self._started = True
        await self.set_transport_ready(frame)

    async def cleanup(self) -> None:
        # pipecat's BaseObject.cleanup is untyped; these calls are correct.
        await super().cleanup()  # type: ignore[no-untyped-call]
        await self._as_transport.cleanup()  # type: ignore[no-untyped-call]

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        """Send one 8 kHz slin chunk back to Asterisk as a ``0x10`` frame.

        The base ``MediaSender`` has already resampled the TTS audio to the
        transport's ``audio_out_sample_rate`` (8 kHz) and chunked it, so the
        bytes here are correct slin — we just frame and write them.
        """
        if self._closed or not frame.audio:
            return False
        try:
            self._writer.write(encode_audio_frame(bytes(frame.audio)))
            await self._writer.drain()
            self._audio_frames_out += 1
            if self._audio_frames_out == 1 or self._audio_frames_out % 250 == 0:
                logger.info(
                    f"audiosocket: outbound audio frames={self._audio_frames_out} "
                    f"(last payload={len(frame.audio)} B)"
                )
        except (ConnectionError, RuntimeError) as exc:
            logger.warning(f"audiosocket: write failed, ending output: {exc}")
            self._closed = True
            return False
        return True


class AudioSocketTransport(BaseTransport):
    """Owns the reader/writer pair and exposes input()/output() processors."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        params: TransportParams,
        *,
        call_ended: asyncio.Event,
    ) -> None:
        super().__init__()
        self._reader = reader
        self._writer = writer
        self._params = params
        self._call_ended = call_ended
        self._input: AudioSocketInputTransport | None = None
        self._output: AudioSocketOutputTransport | None = None

    def input(self) -> AudioSocketInputTransport:
        if self._input is None:
            self._input = AudioSocketInputTransport(self, self._reader, self._params)
        return self._input

    def output(self) -> AudioSocketOutputTransport:
        if self._output is None:
            self._output = AudioSocketOutputTransport(self, self._writer, self._params)
        return self._output

    def signal_call_ended(self) -> None:
        """Mark the call ended so the runner can stop the pipeline."""
        self._call_ended.set()


def make_audiosocket_transport(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    *,
    call_ended: asyncio.Event,
) -> AudioSocketTransport:
    """Construct an :class:`AudioSocketTransport` bound to one TCP connection.

    IO runs at 8 kHz slin mono; the output transport relies on Pipecat's
    ``MediaSender`` to resample TTS audio down to 8 kHz before framing.
    """
    params = TransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        audio_in_sample_rate=AUDIOSOCKET_SAMPLE_RATE,
        audio_out_sample_rate=AUDIOSOCKET_SAMPLE_RATE,
        audio_in_channels=AUDIOSOCKET_CHANNELS,
        audio_out_channels=AUDIOSOCKET_CHANNELS,
        # Asterisk paces playout itself; don't pad the tail with extra silence.
        audio_out_end_silence_secs=0,
    )
    logger.info(f"audiosocket-transport: built (slin PCM mono @ {AUDIOSOCKET_SAMPLE_RATE} Hz)")
    return AudioSocketTransport(reader, writer, params, call_ended=call_ended)


__all__ = [
    "AudioSocketInputTransport",
    "AudioSocketOutputTransport",
    "AudioSocketTransport",
    "make_audiosocket_transport",
]

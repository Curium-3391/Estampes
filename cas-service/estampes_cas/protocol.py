"""Frames: 4-byte big-endian length + UTF-8 JSON. v=1.
Request  {v, id, method: compute|health|cancel, params}
Response {v, id, ok: true, result} | {v, id, ok: false, error: {code, message}}"""
import json
import struct

from .limits import LIMITS, CasError

VERSION = 1


def encode(obj, max_bytes):
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > max_bytes:
        raise CasError("resource_limit", "the reply is larger than %d bytes" % max_bytes)
    return struct.pack(">I", len(body)) + body


async def read_frame(reader):
    head = await reader.readexactly(4)
    n = struct.unpack(">I", head)[0]
    if n > LIMITS.max_request_bytes:
        raise CasError("resource_limit", "request frame too large")
    return json.loads((await reader.readexactly(n)).decode("utf-8"))

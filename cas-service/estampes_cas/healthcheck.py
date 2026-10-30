"""Docker healthcheck: ask the service for its health over the socket."""
import json
import os
import socket
import struct
import sys

path = os.environ.get("ESTAMPES_CAS_SOCKET", "/run/estampes-cas/cas.sock")
try:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(3)
    s.connect(path)
    body = json.dumps({"v": 1, "id": "hc", "method": "health"}).encode()
    s.sendall(struct.pack(">I", len(body)) + body)
    n = struct.unpack(">I", s.recv(4))[0]
    data = b""
    while len(data) < n:
        data += s.recv(n - len(data))
    sys.exit(0 if json.loads(data).get("ok") else 1)
except Exception:
    sys.exit(1)

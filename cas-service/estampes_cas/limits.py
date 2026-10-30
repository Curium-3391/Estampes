"""Hard limits. Every one can be lowered (never raised past the *_MAX) with
an ESTAMPES_CAS_* environment variable."""
import os


def _env(name, default, lo, hi):
    try:
        v = int(os.environ.get("ESTAMPES_CAS_" + name, default))
    except ValueError:
        v = default
    return max(lo, min(hi, v))


class Limits:
    def __init__(self):
        self.max_expr_chars = _env("MAX_EXPR_CHARS", 4096, 16, 16384)
        self.max_depth = _env("MAX_DEPTH", 60, 8, 120)
        self.max_nodes = _env("MAX_NODES", 2000, 16, 10000)
        self.max_int_digits = _env("MAX_INT_DIGITS", 300, 10, 2000)
        self.max_factorial = _env("MAX_FACTORIAL", 1000, 10, 5000)
        self.max_pow_bits = _env("MAX_POW_BITS", 200000, 1000, 2000000)
        self.max_matrix = _env("MAX_MATRIX", 8, 2, 12)
        self.max_precision = _env("MAX_PRECISION", 100, 5, 200)
        self.max_symbols = _env("MAX_SYMBOLS", 16, 2, 64)
        self.max_defs = _env("MAX_DEFS", 64, 0, 256)
        self.timeout_ms = _env("TIMEOUT_MS", 8000, 200, 60000)
        self.max_reply_bytes = _env("MAX_REPLY_BYTES", 512 * 1024, 4096, 2 * 1024 * 1024)
        self.max_request_bytes = _env("MAX_REQUEST_BYTES", 256 * 1024, 4096, 1024 * 1024)
        self.workers = _env("WORKERS", 4, 1, 16)
        self.queue = _env("QUEUE", 16, 0, 256)
        self.memory_mb = _env("MEMORY_MB", 1536, 256, 8192)


LIMITS = Limits()


class CasError(Exception):
    """A typed failure. code: syntax, unsupported, domain, timeout,
    resource_limit, stale, worker_unavailable, cancelled, internal."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message

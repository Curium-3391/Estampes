// Least-squares line fit for Estampes (ABI estampes.wasm/1), freestanding C:
// no libc, no imports. Reads {"params":{"points":[[x,y],...]}} and replies
// with axes, the points, the fitted line, an info card and the numbers, or
// {"error": "..."} when the points cannot be fitted. Build (clang + wasm-ld):
//   clang --target=wasm32 -O2 -nostdlib -ffreestanding -Wl,--no-entry \
//     -Wl,--export=alloc -Wl,--export=handle -Wl,--initial-memory=1048576 \
//     -Wl,--max-memory=2097152 -o linefit.wasm linefit.c
typedef unsigned int u32;
typedef unsigned char u8;

static u8 heap[131072];
static u32 heap_top;
static char out[65536];
static u32 out_len;

u32 alloc(u32 len) { u32 at = heap_top; heap_top += (len + 7u) & ~7u; return (u32)(heap + at); }

// ---- tiny output buffer ----------------------------------------------------
static void put(const char *s) { while (*s && out_len < sizeof out - 8) out[4 + out_len++] = *s++; }
static void put_num(double v) {
  char buf[40]; int n = 0;
  if (v != v) { put("null"); return; }
  if (v < 0) { put("-"); v = -v; }
  if (v > 1e15) { put("1e15"); return; }
  // 9 decimals, trailing zeros trimmed
  double scaled = v * 1e9 + 0.5;
  unsigned long long whole = (unsigned long long)v, frac = (unsigned long long)scaled - whole * 1000000000ULL;
  if (frac >= 1000000000ULL) { whole++; frac -= 1000000000ULL; }
  do { buf[n++] = '0' + (char)(whole % 10); whole /= 10; } while (whole);
  char tmp[2]; tmp[1] = 0;
  while (n) { tmp[0] = buf[--n]; put(tmp); }
  if (frac) {
    char f[10]; for (int i = 8; i >= 0; i--) { f[i] = '0' + (char)(frac % 10); frac /= 10; }
    int last = 8; while (last > 0 && f[last] == '0') last--;
    put("."); for (int i = 0; i <= last; i++) { tmp[0] = f[i]; put(tmp); }
  }
}
static u32 finish(void) {
  out[0] = out_len & 255; out[1] = (out_len >> 8) & 255; out[2] = (out_len >> 16) & 255; out[3] = (out_len >> 24) & 255;
  return (u32)out;
}
static u32 fail(const char *message) { out_len = 0; put("{\"error\":\""); put(message); put("\"}"); return finish(); }

// ---- tiny JSON reading -------------------------------------------------------
static const u8 *p, *end;
static void ws(void) { while (p < end && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) p++; }
static int number(double *v) {
  ws(); double sign = 1, x = 0; int any = 0;
  if (p < end && *p == '-') { sign = -1; p++; }
  while (p < end && *p >= '0' && *p <= '9') { x = x * 10 + (*p++ - '0'); any = 1; }
  if (p < end && *p == '.') { double f = 0.1; p++; while (p < end && *p >= '0' && *p <= '9') { x += (*p++ - '0') * f; f /= 10; any = 1; } }
  if (p < end && (*p == 'e' || *p == 'E')) {
    p++; int es = 1, e = 0; if (p < end && (*p == '+' || *p == '-')) { if (*p == '-') es = -1; p++; }
    while (p < end && *p >= '0' && *p <= '9') e = e * 10 + (*p++ - '0');
    while (e-- > 0) x = es > 0 ? x * 10 : x / 10;
  }
  *v = sign * x; return any;
}
static int expect(u8 c) { ws(); if (p < end && *p == c) { p++; return 1; } return 0; }
static int find(const char *key) {
  for (const u8 *q = p; q < end; q++) {
    const char *k = key; const u8 *r = q;
    while (*k && r < end && *r == (u8)*k) { k++; r++; }
    if (!*k) { p = r; return 1; }
  }
  return 0;
}

#define MAXN 2000
static double xs[MAXN], ys[MAXN];

u32 handle(u32 ptr, u32 len) {
  p = (const u8 *)ptr; end = p + len; heap_top = 0; out_len = 0;
  if (!find("\"points\":")) return fail("points are missing");
  if (!expect('[')) return fail("points must be a list");
  u32 n = 0;
  while (!expect(']')) {
    if (n && !expect(',')) return fail("points must be a list of [x, y] pairs");
    if (n >= MAXN) return fail("at most 2000 points");
    if (!expect('[') || !number(&xs[n]) || !expect(',') || !number(&ys[n]) || !expect(']')) return fail("each point must be [x, y]");
    n++;
  }
  if (n < 2) return fail("need at least 2 points");
  double sx = 0, sy = 0, minx = xs[0], maxx = xs[0], miny = ys[0], maxy = ys[0];
  for (u32 i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    if (xs[i] < minx) minx = xs[i]; if (xs[i] > maxx) maxx = xs[i];
    if (ys[i] < miny) miny = ys[i]; if (ys[i] > maxy) maxy = ys[i];
  }
  double mx = sx / n, my = sy / n, sxx = 0, sxy = 0, syy = 0;
  for (u32 i = 0; i < n; i++) { double dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx == 0) return fail("all x values are equal; a line y = a + bx cannot be fitted");
  double slope = sxy / sxx, intercept = my - slope * mx;
  double r2 = syy == 0 ? 1 : (sxy * sxy) / (sxx * syy);
  double y0 = intercept + slope * minx, y1 = intercept + slope * maxx;
  if (y0 < miny) miny = y0; if (y1 < miny) miny = y1; if (y0 > maxy) maxy = y0; if (y1 > maxy) maxy = y1;
  double px = (maxx - minx) * 0.1, py = (maxy - miny) * 0.1; if (py == 0) py = 1;

  put("{\"summary\":\"Least-squares line over "); put_num(n); put(" points\",\"data\":{\"slope\":"); put_num(slope);
  put(",\"intercept\":"); put_num(intercept); put(",\"r2\":"); put_num(r2); put(",\"n\":"); put_num(n); put("},\"operations\":[");
  put("{\"op\":\"object.create\",\"ref\":\"ax\",\"type\":\"axes-2d\",\"props\":{\"title\":\"Least-squares fit\",\"xRange\":["); put_num(minx - px); put(","); put_num(maxx + px);
  put("],\"yRange\":["); put_num(miny - py); put(","); put_num(maxy + py); put("]}},");
  put("{\"op\":\"object.create\",\"type\":\"shape\",\"props\":{\"kind\":\"dots\",\"space\":\"frame\",\"frame\":\"$ax\",\"style\":{\"color\":\"blue\"},\"points\":[");
  for (u32 i = 0; i < n; i++) { if (i) put(","); put("["); put_num(xs[i]); put(","); put_num(ys[i]); put("]"); }
  put("]}},{\"op\":\"object.create\",\"type\":\"shape\",\"props\":{\"kind\":\"polyline\",\"space\":\"frame\",\"frame\":\"$ax\",\"style\":{\"color\":\"red\",\"width\":2},\"points\":[[");
  put_num(minx); put(","); put_num(y0); put("],["); put_num(maxx); put(","); put_num(y1); put("]]}},");
  put("{\"op\":\"object.create\",\"type\":\"info-card\",\"props\":{\"title\":\"Line fit\",\"rows\":[{\"label\":\"slope\",\"value\":\""); put_num(slope);
  put("\"},{\"label\":\"intercept\",\"value\":\""); put_num(intercept); put("\"},{\"label\":\"R squared\",\"value\":\""); put_num(r2);
  put("\"},{\"label\":\"points\",\"value\":\""); put_num(n); put("\"}]}}]}");
  return finish();
}

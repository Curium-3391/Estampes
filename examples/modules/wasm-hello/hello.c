// Example WebAssembly module for Estampes (ABI estampes.wasm/1).
// Build: clang --target=wasm32 -O2 -nostdlib -ffreestanding \
//   -Wl,--no-entry -Wl,--export=alloc -Wl,--export=handle \
//   -Wl,--initial-memory=262144 -Wl,--max-memory=1048576 -o hello.wasm hello.c
// It imports nothing. `handle` receives the request JSON and returns a
// 4-byte little-endian length followed by the JSON reply.
typedef unsigned int u32;
typedef unsigned char u8;

static u8 heap[65536];
static u32 heap_top;
static u8 reply[2048];

u32 alloc(u32 len) {
  u32 at = heap_top;
  heap_top += (len + 7u) & ~7u;
  return (u32)(heap + at);
}

static u32 length(const char *s) { u32 n = 0; while (s[n]) n++; return n; }

static int contains(const u8 *hay, u32 hl, const char *needle) {
  u32 nl = length(needle);
  for (u32 i = 0; i + nl <= hl; i++) {
    u32 j = 0;
    while (j < nl && hay[i + j] == (u8)needle[j]) j++;
    if (j == nl) return 1;
  }
  return 0;
}

static u32 reply_with(const char *json) {
  u32 n = length(json);
  reply[0] = n & 255; reply[1] = (n >> 8) & 255; reply[2] = (n >> 16) & 255; reply[3] = (n >> 24) & 255;
  for (u32 i = 0; i < n; i++) reply[4 + i] = (u8)json[i];
  return (u32)reply;
}

u32 handle(u32 ptr, u32 len) {
  const u8 *in = (const u8 *)ptr;
  heap_top = 0;
  if (contains(in, len, "\"capability\":\"spin\"")) { volatile u32 x = 0; for (;;) x++; }
  if (contains(in, len, "\"capability\":\"grow\"")) {
    for (;;) if (__builtin_wasm_memory_grow(0, 16) == (u32)-1) break;
    return reply_with("{\"summary\":\"grew\"}");
  }
  if (contains(in, len, "\"capability\":\"trap\"")) __builtin_trap();
  if (contains(in, len, "\"capability\":\"huge\"")) {
    u32 n = 300000;
    reply[0] = n & 255; reply[1] = (n >> 8) & 255; reply[2] = (n >> 16) & 255; reply[3] = 0;
    return (u32)reply;
  }
  return reply_with("{\"summary\":\"Hello from WebAssembly\",\"operations\":[{\"op\":\"object.create\",\"type\":\"shape\",\"props\":{\"kind\":\"text\",\"x\":0.1,\"y\":0.1,\"text\":\"hello from wasm\"}}]}");
}

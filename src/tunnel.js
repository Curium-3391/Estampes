// Optional Cloudflare quick tunnel (compose profile "tunnel"): cloudflared
// gives this server a temporary https://<random>.trycloudflare.com address
// with no account, and reports it at <metrics>/quicktunnel. Estampes reads
// it so download links use it and the owner gets the ChatGPT connector URL
// in the log. The address changes whenever cloudflared restarts.
const FAST_MS = 3000, SLOW_MS = 30000;

export async function readQuickTunnel(metricsUrl, fetchImpl = fetch) {
  const response = await fetchImpl(metricsUrl.replace(/\/+$/, "") + "/quicktunnel", { signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  const host = String((await response.json())?.hostname ?? "").trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? "https://" + host : null;
}

// Polls quickly until the tunnel is up, then slowly to notice a new address.
// Returns a stop function.
export function watchQuickTunnel(metricsUrl, onChange, { fetchImpl = fetch } = {}) {
  // Without the tunnel profile the host never resolves; after two minutes
  // of that, only check now and then.
  let current = null, timer = null, stopped = false, tries = 0;
  const tick = async () => {
    let next = null;
    try { next = await readQuickTunnel(metricsUrl, fetchImpl); } catch {}
    if (next && next !== current) { current = next; onChange(next); }
    if (!stopped) timer = setTimeout(tick, current || ++tries * FAST_MS > 120000 ? SLOW_MS : FAST_MS);
    timer?.unref?.();
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

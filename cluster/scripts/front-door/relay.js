// Plain-WebSocket -> HotPocket user-port relay for a bridge front door.
// nginx terminates the public TLS (Let's Encrypt) and proxies plain WebSocket here; this end dials
// the node the way hotpocket-js-client does (Node's TLS client, upgrade sent at once), which hpws
// answers reliably. nginx's own upstream TLS client only got through ~40% of the time (2026-09-09):
// hpws reads the upgrade request right after the TLS handshake and gives up when it is not there yet.
// Never put `proxy_pass https://` in front of a node's user port; that is what this file exists to avoid.
//
// One listener per node, any number of nodes. The default is the dev front door's three:
//   127.0.0.1:9081 -> wss://127.0.0.1:8081, 9082 -> 8082, 9083 -> 8083
//
// Configuration, all environment, nothing else:
//   RELAY_NODES          how many nodes (default 3)
//   RELAY_LISTEN_BASE    first local port nginx proxies to (default 9081); node i listens on base + i - 1
//   RELAY_UPSTREAM_BASE  first node user port (default 8081); node i is at base + i - 1
//   RELAY_UPSTREAM_HOST  where the nodes are (default 127.0.0.1)
//   RELAY_PAIRS          instead of the three above, an explicit list: "9091:8091,9092:10.0.0.7:8092"
//                        (listen:upstreamPort or listen:upstreamHost:upstreamPort, comma separated)
//   RELAY_LISTEN_HOST    the address the relays listen on (default 127.0.0.1). Only for a relay whose nginx is on another
//                        machine: in the cluster host it is the VM's own private address (10.0.0.13), because
//                        the host's nginx terminates TLS outside the VM. Never a public address.
//   RELAY_ALLOW_PUBLIC_UPSTREAM  1 to relay to a node on a public address. Refused otherwise: the relay-to-node leg is unauthenticated.
//                        A node on a public HOST NAME is checked the way a browser checks a site: its certificate must chain to a
//                        public CA and name that host, or the connection fails before anything is relayed. Evernode hosts serve
//                        their domain's Let's Encrypt certificate on instance ports (checked 2026-10-18), so this needs nothing set.
//   RELAY_PINS           for a node with no usable name (a public IP address, or a self-signed certificate): its certificate by listen
//                        port, "9091=<sha256>,9092=<sha256>" (the SHA-256 fingerprint as `openssl x509 -noout -fingerprint -sha256`
//                        prints it; colons and case do not matter). A pinned node that shows any other certificate is closed before
//                        anything is relayed. A pin does not survive the node's certificate being renewed, so prefer a name.
//   RELAY_ALLOW_UNPINNED 1 to relay to a public node with neither check (the old, unauthenticated way). Say it out loud.
//   RELAY_MAX_PAYLOAD    bytes per message (default 5242880)
//
// The relay listens on 127.0.0.1 unless RELAY_LISTEN_HOST says otherwise. The connection to a node is not authenticated
// (hpws certificates are self-signed), so keep the nodes on this machine or on a private network.
//
//   RELAY_NODES=5 RELAY_LISTEN_BASE=9091 RELAY_UPSTREAM_BASE=8091 pm2 start relay.js --name bridge-front-main
const { WebSocketServer, WebSocket } = require("ws")

const DEFAULT_MAX = 5 * 1024 * 1024
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

function port(value, what) {
  const text = String(value).trim()
  const n = Number(text)
  if (!/^[0-9]+$/.test(text) || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${what} must be a port number (1 to 65535), got '${value}'`)
  return n
}

function host(value, what) {
  if (!HOST_RE.test(value)) throw new Error(`${what} must be a host name or an IPv4 address, got '${value}'`)
  return value
}

/** The address the relays listen on: RELAY_LISTEN_HOST, default 127.0.0.1. Throws a message that names the setting. */
function listenHost(env) {
  return host(env.RELAY_LISTEN_HOST ?? "127.0.0.1", "RELAY_LISTEN_HOST")
}

/** Loopback, RFC 1918, carrier-grade NAT (Tailscale and the like) and link-local IPv4 addresses, and `localhost`. A name that is not `localhost` could point anywhere. */
function privateHost(h) {
  if (h === "localhost") return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
}

/** A SHA-256 certificate fingerprint as 64 lower-case hex digits, from "AB:CD:…" or "abcd…". Throws a message that names the setting. */
function fingerprint(value, what) {
  const hex = String(value).trim().replace(/:/g, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${what} must be a SHA-256 certificate fingerprint (64 hex digits, colons allowed), got '${value}'`)
  return hex
}

/** RELAY_PINS as a map from listen port to fingerprint. */
function parsePins(raw) {
  const pins = new Map()
  for (const part of String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf("=")
    if (at < 0) throw new Error(`RELAY_PINS entry '${part}' must look like 9091=<sha256 fingerprint>`)
    const listen = port(part.slice(0, at), "RELAY_PINS port")
    if (pins.has(listen)) throw new Error(`RELAY_PINS names port ${listen} twice`)
    pins.set(listen, fingerprint(part.slice(at + 1), `RELAY_PINS for ${listen}`))
  }
  return pins
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** The listeners to run, from the environment: [{ listen, host, port, pin?, verify? }]. Throws a message that names the setting. */
function parseConfig(env) {
  const out = []
  if (env.RELAY_PAIRS && env.RELAY_PAIRS.trim()) {
    for (const part of env.RELAY_PAIRS.split(",").map((s) => s.trim()).filter(Boolean)) {
      const bits = part.split(":")
      if (bits.length !== 2 && bits.length !== 3) throw new Error(`RELAY_PAIRS entry '${part}' must look like 9091:8091 or 9091:10.0.0.7:8091`)
      out.push({ listen: port(bits[0], "RELAY_PAIRS listen port"), host: bits.length === 3 ? host(bits[1], "RELAY_PAIRS host") : "127.0.0.1", port: port(bits[bits.length - 1], "RELAY_PAIRS upstream port") })
    }
  } else {
    const nodes = Number(env.RELAY_NODES ?? 3)
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 64) throw new Error(`RELAY_NODES must be a whole number from 1 to 64, got '${env.RELAY_NODES}'`)
    const listenBase = port(env.RELAY_LISTEN_BASE ?? 9081, "RELAY_LISTEN_BASE")
    const upstreamBase = port(env.RELAY_UPSTREAM_BASE ?? 8081, "RELAY_UPSTREAM_BASE")
    const upstreamHost = host(env.RELAY_UPSTREAM_HOST ?? "127.0.0.1", "RELAY_UPSTREAM_HOST")
    if (listenBase + nodes - 1 > 65535 || upstreamBase + nodes - 1 > 65535) throw new Error(`${nodes} nodes do not fit above the base ports`)
    for (let i = 0; i < nodes; i++) out.push({ listen: listenBase + i, host: upstreamHost, port: upstreamBase + i })
  }
  if (!out.length) throw new Error("no listeners configured")
  // The leg from here to a node is not authenticated (hpws certificates are self-signed): anyone who can sit on that path can answer for the node.
  // Keep it on this machine or a private network; a node on a public address (an Evernode instance) is a choice to make out loud.
  if (env.RELAY_ALLOW_PUBLIC_UPSTREAM !== "1") {
    for (const p of out) {
      if (!privateHost(p.host)) throw new Error(`upstream ${p.host} is not a loopback or private address, and the relay's connection to a node is not authenticated; set RELAY_ALLOW_PUBLIC_UPSTREAM=1 to relay to it anyway`)
    }
  }
  const seen = new Set()
  for (const p of out) {
    if (seen.has(p.listen)) throw new Error(`local port ${p.listen} is used twice`)
    seen.add(p.listen)
  }
  // The leg to a node on a public address is authenticated one of two ways: its host name's certificate is checked like a browser
  // would (the default for a name), or the node has to show the very certificate it is pinned to.
  const pins = parsePins(env.RELAY_PINS)
  for (const listen of pins.keys()) if (!seen.has(listen)) throw new Error(`RELAY_PINS names port ${listen}, which no relay listens on`)
  for (const p of out) {
    if (pins.has(p.listen)) p.pin = pins.get(p.listen)
    else if (!privateHost(p.host) && env.RELAY_ALLOW_UNPINNED !== "1") {
      if (IPV4_RE.test(p.host)) throw new Error(`upstream ${p.host}:${p.port} is a public IP address, so its certificate cannot be checked against a name; use the node's host name, pin it in RELAY_PINS (${p.listen}=<sha256>), or set RELAY_ALLOW_UNPINNED=1 to relay to it unauthenticated`)
      p.verify = true
    }
  }
  return out
}

/** Starts one listener per entry. Returns the servers (tests close them). */
function start(pairs, opts = {}) {
  const max = opts.maxPayload ?? DEFAULT_MAX
  const log = opts.log ?? console.log
  const bind = opts.listenHost ?? "127.0.0.1"
  const servers = []
  for (const { listen, host: upstreamHost, port: upstream, pin, verify } of pairs) {
    const wss = new WebSocketServer({ host: bind, port: listen, perMessageDeflate: false, maxPayload: max })
    wss.on("connection", (client) => {
      // A named public node: the full check (public CA, host name). Otherwise the certificate is self-signed or the node is local, and
      // either the pin below is the check or there is none (a node on this machine or a private network).
      const up = new WebSocket(`wss://${upstreamHost}:${upstream}`, { rejectUnauthorized: verify === true, perMessageDeflate: false, maxPayload: max })
      const queue = []
      let verified = !pin
      const closeBoth = () => { try { client.close() } catch {} try { up.terminate() } catch {} }
      up.on("upgrade", (res) => {
        if (!pin) return
        const seenCert = res.socket && typeof res.socket.getPeerCertificate === "function" ? res.socket.getPeerCertificate().fingerprint256 || "" : ""
        if (seenCert.replace(/:/g, "").toLowerCase() === pin) {
          verified = true
          return
        }
        log(`relay ${listen}: wss://${upstreamHost}:${upstream} showed certificate ${seenCert || "(none)"}, not its pin; closed, nothing relayed`)
        closeBoth()
      })
      up.on("open", () => {
        if (!verified) return closeBoth()
        for (const [d, b] of queue) up.send(d, { binary: b })
        queue.length = 0
      })
      client.on("message", (d, isBinary) => { if (up.readyState === WebSocket.OPEN) up.send(d, { binary: isBinary }); else if (up.readyState === WebSocket.CONNECTING) queue.push([d, isBinary]) })
      up.on("message", (d, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: isBinary }) })
      client.on("close", closeBoth); up.on("close", closeBoth)
      client.on("error", closeBoth); up.on("error", closeBoth)
    })
    wss.on("error", (e) => console.error(`listen ${listen}: ${e.message}`))
    log(`relay ${bind}:${listen} -> wss://${upstreamHost}:${upstream}${pin ? ` (pinned ${pin.slice(0, 16)}…)` : verify ? " (certificate checked)" : ""}`)
    servers.push(wss)
  }
  return servers
}

module.exports = { parseConfig, parsePins, listenHost, privateHost, start }

if (require.main === module) {
  let pairs, bind
  try {
    pairs = parseConfig(process.env)
    bind = listenHost(process.env)
  } catch (e) {
    console.error(`relay: ${e.message}`)
    process.exit(1)
  }
  start(pairs, { maxPayload: Number(process.env.RELAY_MAX_PAYLOAD) || DEFAULT_MAX, listenHost: bind })
}

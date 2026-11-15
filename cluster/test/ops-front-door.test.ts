import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

const req = createRequire(__filename)
const relay = req('../scripts/front-door/relay.js') as { parseConfig(env: Record<string, string | undefined>): { listen: number; host: string; port: number; pin?: string; verify?: boolean }[]; listenHost(env: Record<string, string | undefined>): string; start(pairs: { listen: number; host: string; port: number }[], opts?: { log?: (l: string) => void; listenHost?: string }): { close(): void }[] }
const gen = req('../scripts/front-door/gen-nginx.js') as { generate(opts: Record<string, unknown>): string; parseArgs(argv: string[]): Record<string, unknown> }
// ws ships no types here and the test only needs its two classes
const { WebSocket, WebSocketServer } = req('ws') as { WebSocket: any; WebSocketServer: any } 

afterAll(cleanupTmp)
const FD = path.join(PKG, 'scripts/front-door')

describe('relay.js configuration', () => {
  it('defaults to the dev front door: three nodes, 9081-9083 to 8081-8083', () => {
    expect(relay.parseConfig({})).toEqual([
      { listen: 9081, host: '127.0.0.1', port: 8081 },
      { listen: 9082, host: '127.0.0.1', port: 8082 },
      { listen: 9083, host: '127.0.0.1', port: 8083 },
    ])
  })

  it('serves any number of nodes from three numbers', () => {
    const five = relay.parseConfig({ RELAY_NODES: '5', RELAY_LISTEN_BASE: '9091', RELAY_UPSTREAM_BASE: '8091' })
    expect(five.map((p) => [p.listen, p.port])).toEqual([[9091, 8091], [9092, 8092], [9093, 8093], [9094, 8094], [9095, 8095]])
    expect(relay.parseConfig({ RELAY_NODES: '1' })).toHaveLength(1)
    expect(relay.parseConfig({ RELAY_NODES: '7', RELAY_UPSTREAM_HOST: '10.0.0.9' }).every((p) => p.host === '10.0.0.9')).toBe(true)
  })

  it('will not relay to a node on a public address, or a name that could point anywhere, unless told to', () => {
    for (const host of ['203.0.113.7', '8.8.8.8', 'nodes.internal', 'evr001.example.com', '172.32.0.1', '100.128.0.1', '192.169.0.1']) {
      expect(() => relay.parseConfig({ RELAY_UPSTREAM_HOST: host }), host).toThrow(/RELAY_ALLOW_PUBLIC_UPSTREAM=1/)
      expect(() => relay.parseConfig({ RELAY_PAIRS: `9091:${host}:8091` }), host).toThrow(/RELAY_ALLOW_PUBLIC_UPSTREAM=1/)
      // and then the leg is authenticated: a name's certificate is checked like a browser would, a bare IP has to be pinned
      if (/^[0-9.]+$/.test(host)) expect(() => relay.parseConfig({ RELAY_UPSTREAM_HOST: host, RELAY_ALLOW_PUBLIC_UPSTREAM: '1' }), host).toThrow(/public IP address/)
      else expect(relay.parseConfig({ RELAY_UPSTREAM_HOST: host, RELAY_ALLOW_PUBLIC_UPSTREAM: '1' }).every((p) => p.host === host && p.verify === true), host).toBe(true)
      expect(relay.parseConfig({ RELAY_UPSTREAM_HOST: host, RELAY_ALLOW_PUBLIC_UPSTREAM: '1', RELAY_ALLOW_UNPINNED: '1' }).every((p) => p.host === host && !p.verify), host).toBe(true)
    }
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.7', '172.16.5.5', '172.31.255.1', '192.168.1.20', '100.64.0.1', '169.254.1.1']) {
      expect(relay.parseConfig({ RELAY_UPSTREAM_HOST: host }).every((p) => p.host === host), host).toBe(true)
    }
  })

  it('pins a node by its certificate fingerprint, and wants one for every node on a public address', () => {
    const fp = 'AB:'.repeat(31) + 'AB'
    const pairs = '9091:203.0.113.7:26202,9092:198.51.100.4:26423'
    const pinned = relay.parseConfig({ RELAY_PAIRS: pairs, RELAY_ALLOW_PUBLIC_UPSTREAM: '1', RELAY_PINS: `9091=${fp}, 9092=${'cd'.repeat(32)}` })
    expect(pinned).toEqual([
      { listen: 9091, host: '203.0.113.7', port: 26202, pin: 'ab'.repeat(32) },
      { listen: 9092, host: '198.51.100.4', port: 26423, pin: 'cd'.repeat(32) },
    ])
    expect(() => relay.parseConfig({ RELAY_PAIRS: pairs, RELAY_ALLOW_PUBLIC_UPSTREAM: '1', RELAY_PINS: `9091=${fp}` })).toThrow(/198\.51\.100\.4:26423 is a public IP address/)
    // a named node needs no pin: its certificate is checked against public CAs and the name; a pin, when given, takes over
    const named = relay.parseConfig({ RELAY_PAIRS: '9091:node1.evernode.hostone.io:26202,9092:node3.hostthree.com:26204', RELAY_ALLOW_PUBLIC_UPSTREAM: '1', RELAY_PINS: `9092=${fp}` })
    expect(named.map((p) => [p.verify === true, p.pin ?? null])).toEqual([[true, null], [false, 'ab'.repeat(32)]])
    expect(() => relay.parseConfig({ RELAY_PAIRS: pairs, RELAY_ALLOW_PUBLIC_UPSTREAM: '1', RELAY_PINS: `9091=${fp},9092=${fp},9093=${fp}` })).toThrow(/port 9093, which no relay listens on/)
    expect(() => relay.parseConfig({ RELAY_PAIRS: '9091:8091', RELAY_PINS: '9091=not-a-fingerprint' })).toThrow(/SHA-256 certificate fingerprint/)
    expect(() => relay.parseConfig({ RELAY_PAIRS: '9091:8091', RELAY_PINS: `9091=${fp},9091=${fp}` })).toThrow(/twice/)
    expect(() => relay.parseConfig({ RELAY_PAIRS: '9091:8091', RELAY_PINS: fp })).toThrow(/9091=<sha256 fingerprint>/)
    // a node on this machine may be pinned too, and needs nothing when it is not
    expect(relay.parseConfig({ RELAY_PAIRS: '9091:8091', RELAY_PINS: `9091=${fp}` })[0].pin).toBe('ab'.repeat(32))
  })

  it('takes an explicit list, with a host per node for nodes on other machines', () => {
    expect(relay.parseConfig({ RELAY_PAIRS: '9091:8091, 9092:10.0.0.7:8092' })).toEqual([
      { listen: 9091, host: '127.0.0.1', port: 8091 },
      { listen: 9092, host: '10.0.0.7', port: 8092 },
    ])
    // the list wins over the counted form
    expect(relay.parseConfig({ RELAY_PAIRS: '9091:8091', RELAY_NODES: '5' })).toHaveLength(1)
  })

  it('refuses what would listen nowhere sensible, naming the setting', () => {
    const bad = (env: Record<string, string>, re: RegExp) => expect(() => relay.parseConfig(env), JSON.stringify(env)).toThrow(re)
    bad({ RELAY_NODES: '0' }, /RELAY_NODES/)
    bad({ RELAY_NODES: 'three' }, /RELAY_NODES/)
    bad({ RELAY_NODES: '' }, /RELAY_NODES/)
    bad({ RELAY_NODES: '65' }, /RELAY_NODES/)
    bad({ RELAY_LISTEN_BASE: '99999' }, /RELAY_LISTEN_BASE/)
    bad({ RELAY_NODES: '10', RELAY_LISTEN_BASE: '65530' }, /do not fit/)
    bad({ RELAY_UPSTREAM_HOST: 'a b' }, /RELAY_UPSTREAM_HOST/)
    bad({ RELAY_UPSTREAM_HOST: '$(reboot)' }, /RELAY_UPSTREAM_HOST/)
    bad({ RELAY_PAIRS: '9091' }, /RELAY_PAIRS entry/)
    bad({ RELAY_PAIRS: '9091:8091,9091:8092' }, /used twice/)
    bad({ RELAY_PAIRS: '9091:host:99999' }, /upstream port/)
    bad({ RELAY_PAIRS: 'x:8091' }, /listen port/)
  })

  it('exits with the message when run with a bad setting', () => {
    const r = run('node', [path.join(FD, 'relay.js')], { env: { RELAY_NODES: 'x' } })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/relay: RELAY_NODES must be a whole number/)
  })

  it('listens on 127.0.0.1 unless RELAY_LISTEN_HOST names another address (the blume VM: its private address)', () => {
    expect(relay.listenHost({})).toBe('127.0.0.1')
    expect(relay.listenHost({ RELAY_LISTEN_HOST: '10.0.0.13' })).toBe('10.0.0.13')
    expect(() => relay.listenHost({ RELAY_LISTEN_HOST: '$(reboot)' })).toThrow(/RELAY_LISTEN_HOST/)
    const r = run('node', [path.join(FD, 'relay.js')], { env: { RELAY_LISTEN_HOST: 'a b' } })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/relay: RELAY_LISTEN_HOST must be a host name or an IPv4 address/)
  })
})

describe('relay.js relays', () => {
  const dir = tmpDir()
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
      })
    })
  const closers: (() => void)[] = []
  afterAll(() => closers.forEach((c) => c()))

  /** n fake nodes with self-signed TLS, each answering "node-i:<message>", and a relay in front of them. */
  async function setup(n: number) {
    const pairs: { listen: number; host: string; port: number }[] = []
    const seen: string[][] = Array.from({ length: n }, () => [])
    for (let i = 0; i < n; i++) {
      const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) })
      const wss = new WebSocketServer({ server })
      wss.on('connection', (ws: any) => {
        seen[i].push('open')
        ws.on('message', (d: Buffer, isBinary: boolean) => ws.send(isBinary ? Buffer.concat([Buffer.from(`node-${i + 1}:`), d]) : `node-${i + 1}:${d}`, { binary: isBinary }))
        ws.on('close', () => seen[i].push('close'))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      closers.push(() => {
        wss.close()
        server.close()
      })
      pairs.push({ listen: await freePort(), host: '127.0.0.1', port: (server.address() as net.AddressInfo).port })
    }
    const servers = relay.start(pairs, { log: () => {} })
    closers.push(() => servers.forEach((s) => s.close()))
    await new Promise((r) => setTimeout(r, 100))
    return { pairs, seen }
  }
  const exchange = (port: number, send: (ws: any) => void) => 
    new Promise<{ data: string; isBinary: boolean }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.on('open', () => send(ws))
      ws.on('message', (d: Buffer, isBinary: boolean) => {
        resolve({ data: String(d), isBinary })
        ws.close()
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('no answer')), 5000)
    })

  it('five relays, each reaching its own node, text and binary', async () => {
    const { pairs } = await setup(5)
    for (let i = 0; i < 5; i++) {
      const text = await exchange(pairs[i].listen, (ws) => ws.send('hello'))
      expect(text).toEqual({ data: `node-${i + 1}:hello`, isBinary: false })
      const bin = await exchange(pairs[i].listen, (ws) => ws.send(Buffer.from([1, 2, 3]), { binary: true }))
      expect(bin.isBinary).toBe(true)
      expect(Buffer.from(bin.data, 'latin1').subarray(0, 7).toString()).toBe(`node-${i + 1}:`)
    }
  })

  it('a message sent the instant the client connects is held until the node is ready, and arrives', async () => {
    const { pairs } = await setup(1)
    const r = await exchange(pairs[0].listen, (ws) => {
      ws.send('one')
    })
    expect(r.data).toBe('node-1:one')
  })

  it('closing the client closes the connection to the node', async () => {
    const { pairs, seen } = await setup(1)
    await exchange(pairs[0].listen, (ws) => ws.send('x'))
    await new Promise((r) => setTimeout(r, 200))
    expect(seen[0]).toEqual(['open', 'close'])
  })

  it('relays to a pinned node that shows its own certificate, and closes one that shows any other before anything passes', async () => {
    const realPin = new (req('node:crypto').X509Certificate)(fs.readFileSync(cert)).fingerprint256 as string
    const make = async (pin: string) => {
      const heard: string[] = []
      const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) })
      const wss = new WebSocketServer({ server })
      wss.on('connection', (ws: any) => ws.on('message', (d: Buffer) => { heard.push(String(d)); ws.send(`node:${d}`) }))
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      const listen = await freePort()
      const pairs = relay.parseConfig({ RELAY_PAIRS: `${listen}:127.0.0.1:${(server.address() as net.AddressInfo).port}`, RELAY_PINS: `${listen}=${pin}` })
      const servers = relay.start(pairs, { log: () => {} })
      closers.push(() => { servers.forEach((s) => s.close()); wss.close(); server.close() })
      await new Promise((r) => setTimeout(r, 100))
      return { listen, heard }
    }
    const good = await make(realPin)
    expect(await exchange(good.listen, (ws) => ws.send('hello'))).toEqual({ data: 'node:hello', isBinary: false })

    const bad = await make('00'.repeat(32))
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bad.listen}`)
      ws.on('open', () => ws.send('secret'))
      ws.on('message', () => resolve('got a message'))
      ws.on('close', () => resolve('closed'))
      ws.on('error', () => resolve('closed'))
      setTimeout(() => resolve('hung'), 5000)
    })
    expect(outcome).toBe('closed')
    await new Promise((r) => setTimeout(r, 200))
    expect(bad.heard).toEqual([])
  })

  it('a node that is not there closes the client instead of hanging it', async () => {
    const port = await freePort()
    const deadUpstream = await freePort()
    const servers = relay.start([{ listen: port, host: '127.0.0.1', port: deadUpstream }], { log: () => {} })
    closers.push(() => servers.forEach((s) => s.close()))
    await new Promise((r) => setTimeout(r, 100))
    const closed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.on('open', () => ws.send('anyone there'))
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(true))
      setTimeout(() => resolve(false), 5000)
    })
    expect(closed).toBe(true)
  })
})

// ------------------------------------------------------------------ nginx

/** Comments and layout do not matter to nginx; the directives do. */
const directives = (conf: string) =>
  conf
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)

/** A small structural check: braces balance and every line is a block opener, a closer or a directive ending in a semicolon. */
function structurallySound(conf: string): string[] {
  const problems: string[] = []
  let depth = 0
  for (const line of directives(conf)) {
    if (line.endsWith('{')) depth++
    else if (line === '}') depth--
    else if (/\{[^{}]*\}$/.test(line)) {
      // one-line block: location /x/ { root /y; }
      if (!/;\s*\}$/.test(line) && !/return \d+;\s*\}$/.test(line)) problems.push(`one-line block without a terminated directive: ${line}`)
    } else if (!line.endsWith(';')) problems.push(`directive without a semicolon: ${line}`)
    if (depth < 0) problems.push('closing brace without an opener')
  }
  if (depth !== 0) problems.push(`unbalanced braces (${depth})`)
  return problems
}

describe('gen-nginx.js', () => {
  const dev = fs.readFileSync(path.join(FD, 'nginx-bridge-dev.blumefi.com.conf'), 'utf8')

  it('reproduces the dev front door that is known to work, for three nodes', () => {
    const out = gen.generate({ host: 'bridge-dev.blumefi.com', nodes: 3, relayBase: 9081 })
    expect(directives(out)).toEqual(directives(dev))
  })

  it('writes five nodes for a second hostname: ports, relays and the plain-websocket pattern', () => {
    const out = gen.generate({ host: 'bridge-main.blumefi.com', nodes: 5, relayBase: 9091 })
    expect(out.match(/listen \d+ ssl;/g)).toEqual(['listen 8443 ssl;', 'listen 8444 ssl;', 'listen 8445 ssl;', 'listen 8446 ssl;', 'listen 8447 ssl;'])
    const conf = directives(out).join('\n')
    expect(conf.match(/proxy_pass [^;]+;/g)).toEqual([9091, 9092, 9093, 9094, 9095].map((p) => `proxy_pass http://127.0.0.1:${p};`))
    expect(conf).not.toMatch(/proxy_pass\s+https/)
    expect(out.match(/server_name bridge-main\.blumefi\.com;/g)).toHaveLength(6)
    expect(out.match(/proxy_set_header Upgrade \$http_upgrade;/g)).toHaveLength(5)
    expect(out.match(/proxy_set_header Connection "Upgrade";/g)).toHaveLength(5)
    expect(out.match(/proxy_read_timeout 3600s;/g)).toHaveLength(5)
    expect(out).toContain('ssl_certificate /etc/letsencrypt/live/bridge-main.blumefi.com/fullchain.pem;')
    expect(out).toContain('location /.well-known/acme-challenge/ { root /var/www/html; }')
    expect(structurallySound(out)).toEqual([])
    expect(structurallySound(dev)).toEqual([])
  })

  it('the example file in the repo is what the generator writes', () => {
    const example = fs.readFileSync(path.join(FD, 'nginx-bridge-main.blumefi.com.conf.example'), 'utf8')
    expect(example).toBe(gen.generate({ host: 'bridge-main.blumefi.com', nodes: 5, relayBase: 9091 }))
  })

  it('works for any n, and says so in the comment', () => {
    for (const n of [1, 2, 7, 12]) {
      const out = gen.generate({ host: 'f.example.com', nodes: n, relayBase: 9100 })
      expect(out.match(/listen \d+ ssl;/g)).toHaveLength(n)
      expect(structurallySound(out), `n=${n}`).toEqual([])
    }
    expect(gen.generate({ host: 'f.example.com', nodes: 1 })).toContain('1 node.')
    expect(gen.generate({ host: 'f.example.com', nodes: 3 })).toContain('3 nodes.')
  })

  it('takes a certificate name, a webroot and different ports', () => {
    const out = gen.generate({ host: 'f.example.com', nodes: 2, publicBase: 9443, relayBase: 9700, certName: 'f.example.com-0001', acmeRoot: '/srv/acme' })
    expect(out).toContain('listen 9443 ssl;')
    expect(out).toContain('listen 9444 ssl;')
    expect(out).toContain('/etc/letsencrypt/live/f.example.com-0001/fullchain.pem')
    expect(out).toContain('root /srv/acme;')
    expect(out).toContain('http://127.0.0.1:9701;')
  })

  it('--acme-only is the port 80 block alone, and needs no node count', () => {
    const out = gen.generate({ host: 'bridge-main.blumefi.com', acmeOnly: true })
    expect(out.match(/^server \{/gm)).toHaveLength(1)
    expect(out).not.toContain('ssl')
    expect(structurallySound(out)).toEqual([])
  })

  it('refuses nonsense instead of writing a config that nginx would reject or that exposes the wrong thing', () => {
    const bad = (opts: Record<string, unknown>, re: RegExp) => expect(() => gen.generate(opts), JSON.stringify(opts)).toThrow(re)
    bad({ nodes: 3 }, /--host/)
    bad({ host: 'nodot', nodes: 3 }, /--host/)
    bad({ host: 'x.example.com; evil', nodes: 3 }, /--host/)
    bad({ host: 'x.example.com' }, /--nodes is required/)
    bad({ host: 'x.example.com', nodes: 0 }, /--nodes/)
    bad({ host: 'x.example.com', nodes: 65 }, /--nodes/)
    bad({ host: 'x.example.com', nodes: 3, publicBase: 8443, relayBase: 8444 }, /overlap/)
    bad({ host: 'x.example.com', nodes: 100, publicBase: 65500, relayBase: 9000 }, /--nodes/)
    bad({ host: 'x.example.com', nodes: 30, publicBase: 65530, relayBase: 9000 }, /do not fit/)
    bad({ host: 'x.example.com', nodes: 3, certName: '../../etc' }, /--cert-name/)
    bad({ host: 'x.example.com', nodes: 3, acmeRoot: 'relative' }, /--acme-root/)
    bad({ host: 'x.example.com', nodes: 3, acmeRoot: '/srv/a; rm' }, /--acme-root/)
  })

  it('runs from the command line', () => {
    const ok = run('node', [path.join(FD, 'gen-nginx.js'), '--host', 'bridge-main.blumefi.com', '--nodes', '5', '--relay-base', '9091'])
    expect(ok.status, ok.out).toBe(0)
    expect(ok.stdout).toBe(fs.readFileSync(path.join(FD, 'nginx-bridge-main.blumefi.com.conf.example'), 'utf8'))
    expect(run('node', [path.join(FD, 'gen-nginx.js'), '--acme-only', '--host', 'bridge-main.blumefi.com']).stdout).toContain('listen 80;')
    const bad = run('node', [path.join(FD, 'gen-nginx.js'), '--nodes', '5'])
    expect(bad.status).toBe(1)
    expect(bad.out).toMatch(/gen-nginx: --host/)
    expect(run('node', [path.join(FD, 'gen-nginx.js'), '--bogus', 'x']).out).toMatch(/unknown or incomplete argument/)
  })
  it('includes the TLS settings file of the box in every TLS block when asked, and adds nothing otherwise', () => {
    const plain = gen.generate({ host: 'bridge-main.blumefi.com', nodes: 3, relayBase: 9091 })
    expect(plain).not.toContain('include ')
    const withOptions = gen.generate({ host: 'bridge-main.blumefi.com', nodes: 3, relayBase: 9091, sslOptions: '/etc/letsencrypt/options-ssl-nginx.conf' })
    expect(withOptions.match(/include \/etc\/letsencrypt\/options-ssl-nginx\.conf;/g)).toHaveLength(3)
    // the same file, plus those three lines and nothing else
    expect(withOptions.split('\n').filter((l) => !l.includes('include ')).join('\n')).toBe(plain)
    expect(gen.parseArgs(['--host', 'h.example.com', '--ssl-options', '/etc/x.conf'])).toMatchObject({ sslOptions: '/etc/x.conf' })
    expect(() => gen.generate({ host: 'bridge-main.blumefi.com', nodes: 3, relayBase: 9091, sslOptions: 'options.conf; evil' })).toThrow(/--ssl-options/)
  })
})

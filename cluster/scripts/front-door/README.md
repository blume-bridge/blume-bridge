# The front door

What lets a browser talk to the bridge's nodes. HotPocket speaks WebSocket only, and its user port serves a self-signed certificate, so each node gets a public TLS port with a real certificate and a relay in between:

```
browser --wss--> nginx :8443.. (Let's Encrypt) --plain ws--> relay.js 127.0.0.1:9091.. --wss, self-signed--> node user port 8091..
```

**Never `proxy_pass https://` to a node's user port.** hpws reads the upgrade request right after the TLS handshake and gives up when it is not there yet; nginx's own TLS client got through about 4 times in 10 when measured, while Node's client got through every time. `relay.js` is the 30-line Node client that makes it work, and the pattern is proven on the dev front door.

Everything here is a template or a note: nothing is applied by these files.

| File | What |
|---|---|
| `relay.js` | The relay, for any number of nodes. Environment only: `RELAY_NODES` (3), `RELAY_LISTEN_BASE` (9081), `RELAY_UPSTREAM_BASE` (8081), `RELAY_UPSTREAM_HOST` (127.0.0.1), or an explicit `RELAY_PAIRS=9091:8091,9092:10.0.0.7:8092`. The defaults are the dev front door's. Listens on 127.0.0.1 only |
| `gen-nginx.js` | Prints the nginx server blocks for N nodes and a hostname: `node gen-nginx.js --host H --nodes N [--public-base 8443] [--relay-base 9081] [--cert-name C] [--acme-root /var/www/html] [--ssl-options /etc/letsencrypt/options-ssl-nginx.conf]`. `--acme-only` prints just the port 80 block; `--ssl-options` adds an `include` of the box's TLS settings to each TLS block |
| `nginx-bridge-dev.blumefi.com.conf` | A dev front door with nginx and the relay on one machine (nodes 1-3, public 8443-8445, relays 9081-9083). `gen-nginx.js --host bridge-dev.blumefi.com --nodes 3` reproduces it, and a test holds the two together |
| `nginx-bridge-main.blumefi.com.conf.example` | The mainnet front door for five nodes, a second hostname beside the dev one: public 8443-8447, relays 9091-9095. A test keeps it equal to the generator's output |

## A mainnet front door (a second hostname beside the dev one)

Server blocks that share a listen port are told apart by SNI, so `bridge-main.blumefi.com` can use 8443-8445 beside `bridge-dev.blumefi.com`, and two more ports (8446, 8447) for nodes 4 and 5. The relay ports must differ from the dev relay's (9091.. against 9081..). Steps, on the box that holds the front door, as root:

1. **DNS.** An A record for `bridge-main` at your DNS provider, pointing at the box.
2. **The first file is port 80 only**, because nginx will not load a TLS block whose certificate does not exist yet:
   ```bash
   node gen-nginx.js --acme-only --host bridge-main.blumefi.com > /etc/nginx/sites-available/bridge-main.blumefi.com
   ln -s ../sites-available/bridge-main.blumefi.com /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
   ```
3. **The certificate, with a deploy hook** (below, so it is reloaded after every renewal):
   ```bash
   certbot certonly --webroot -w /var/www/html -d bridge-main.blumefi.com --deploy-hook "systemctl reload nginx"
   ```
4. **The full file**, then reload:
   ```bash
   node gen-nginx.js --host bridge-main.blumefi.com --nodes 5 --relay-base 9091 > /etc/nginx/sites-available/bridge-main.blumefi.com
   nginx -t && systemctl reload nginx
   ```
5. **The relay**, from this directory copied to `/opt/bridge-front/` with `ws` installed (`npm i ws`):
   ```bash
   RELAY_NODES=5 RELAY_LISTEN_BASE=9091 RELAY_UPSTREAM_BASE=8091 pm2 start relay.js --name bridge-front-main && pm2 save
   ```
   Nodes on other machines: `RELAY_PAIRS=9091:10.0.0.11:8091,9092:10.0.0.12:8091,...` Each node is checked by its certificate (below), so this leg can cross the internet.
6. **Open** 80 and the public ports (8443-8447). The nodes' user ports (8091-8095) stay closed to the world: bound to 127.0.0.1 or firewalled to the relay.
7. **Check** each port from outside, the way the site does (`client/query/index.js` is `dist-client/query/index.js` from `npm run build:client`, rsynced to the box by the deploy as `/root/bridge-cluster/client/`):
   ```bash
   for p in 8443 8444 8445 8446 8447; do node client/query/index.js bridge-main.blumefi.com:$p '{"type":"ping"}'; done
   echo | openssl s_client -connect bridge-main.blumefi.com:8443 -servername bridge-main.blumefi.com 2>/dev/null | openssl x509 -noout -subject -enddate
   ```
8. **The site**: `NEXT_PUBLIC_BRIDGE_NODES=wss://bridge-main.blumefi.com:8443,...:8447` on the Vercel project, for the website.

The watchdog (`../../WATCHDOG.md`) takes the same five endpoints as `WATCHDOG_NODES`.

## The relay checks which node it is talking to

**How it is fixed.** Evernode hosts serve their own domain's Let's Encrypt certificate on instance ports (they verify against public CAs). So a node reached by its host name is now checked the way a browser checks a site: public CA and host name, or the connection fails before anything is relayed. That is the default for any public host name and needs no setting. A node with no usable name (a bare IP, or a self-signed certificate) has to be pinned instead (`RELAY_PINS`, its SHA-256 fingerprint); a pin breaks when the certificate is renewed, which is why names are preferred. `RELAY_ALLOW_UNPINNED=1` is the old unauthenticated way and has to be said out loud. Tested in `test/ops-front-door.test.ts` (a pinned node with the wrong certificate is closed and hears nothing).

What is still trusted: the host operator, who controls the machine an instance runs on (the same trust as before; Decision 3).

## Certificates must be reloaded, and the dev one is not

nginx reads a certificate when it starts or reloads, not when the file changes. certbot renews the files about every 60 days, and **an nginx that is never reloaded keeps serving the old certificate until it expires**: every browser then refuses the front door. Fix it once for every certificate on the host with a global deploy hook, and give new certificates theirs at issue time.

```bash
# once, on the host: certbot runs every executable here after any successful renewal
install -m 755 /dev/stdin /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
certbot renew --dry-run                                  # renewal itself still works
/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh    # and the hook does: no error, nginx still up
systemctl status nginx --no-pager | head -5
certbot certificates                                     # expiry dates; compare with what nginx serves (the openssl line above)
```

A certificate issued with `--deploy-hook "systemctl reload nginx"` has the hook saved in its renewal file (`/etc/letsencrypt/renewal/<name>.conf`), so it needs no global hook, but the global one covers certificates made without. The `certbot renew --dry-run` line proves renewal; run the hook script once by hand to prove the reload. Check `systemctl list-timers | grep certbot` (or the cron entry) to see that renewals run at all. The watchdog notices a lapsed certificate as a front door that stops answering, which is late: renew first.


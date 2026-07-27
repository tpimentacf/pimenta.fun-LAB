# mtls-inspector

An edge-rendered **mTLS / SSL-TLS inspector** page for a Cloudflare hostname that
has client certificates (mTLS) enabled — e.g. `mtls.pimenta.fun`.

Visit the route in a browser and the page prints **everything the Cloudflare
edge sees about your connection**:

1. **Client certificate** — the full `request.cf.tlsClientAuth` object
   (`certPresented`, `certVerified`, `certRevoked`, subject & issuer DN, serial,
   SKI, SHA-1/SHA-256 fingerprints, `certNotBefore`/`certNotAfter`, …), a
   verification banner and a days-until-expiry countdown.
2. **cf-client-cert-\*** request headers (the *mTLS client certificate headers*
   Managed Transform), if enabled.
3. **TLS / SSL connection** — `tlsVersion`, `tlsCipher`, SNI, `httpProtocol`,
   `clientTcpRtt`, ClientHello length, client random, JA3 / JA4.
4. **All of `request.cf`** — the complete Cloudflare edge object.
5. **All request headers** — including the CF-injected ones.

## Why this is a Worker and not a static `.html`

A static HTML file **cannot** read the client certificate, the negotiated TLS
version/cipher, the JA3/JA4 fingerprints, or the `request.cf` object. Those only
exist at the Cloudflare edge, or as CF-injected request headers that browser
JavaScript is not allowed to read. This Worker renders the page **server-side at
the edge** with every value already filled in, and also exposes the same data as
JSON.

## Endpoints

| Request | Response |
|---|---|
| `GET <route>` | Self-contained HTML page (dark lab theme) |
| `GET <route>?format=json` | `application/json` with the full payload |
| `GET <route>?format=raw` | Alias of `?format=json` |

Responses are `Cache-Control: no-store`; CORS is open for `GET`.

## Deploy

```sh
cd workers/mtls-inspector
npx wrangler deploy
```

Default route (see `wrangler.toml`): `mtls.pimenta.fun/cert-info*`
→ page at `https://mtls.pimenta.fun/cert-info`.

## Cloudflare prerequisites (important)

- **Associate the hostname for mTLS** so Cloudflare *requests* a client cert in
  the TLS handshake: **SSL/TLS → Client Certificates** (or **API Shield → mTLS**)
  → add/upload your CA → enable the hostname. Without this, `tlsClientAuth` is
  empty and the browser is never prompted for a certificate.
- **Do not hard-block this path.** If a WAF rule blocks
  `not cf.tls_client_auth.cert_verified` on this hostname, the inspector returns
  `403` before it can report "no cert presented". Skip/allow the inspector path,
  or run the rule in **Log** mode while testing.
- **Enable the "mTLS client certificate headers" Managed Transform** to populate
  the `cf-client-cert-*` headers section (optional; the `tlsClientAuth` object is
  populated regardless).

## Test from the CLI

```sh
# No cert -> status.presented = false
curl -s "https://mtls.pimenta.fun/cert-info?format=json" | jq .status

# With a CA-signed client cert -> status.verified = SUCCESS
curl -s --cert client.crt --key client.key \
  "https://mtls.pimenta.fun/cert-info?format=json" | jq .status
```

Generate a test client cert from your CA:

```sh
openssl genrsa -out client.key 2048
openssl req -new -key client.key -subj "/CN=lab-client" -out client.csr
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key \
  -CAcreateserial -days 365 -sha256 -out client.crt
```

See the full walkthrough at <https://www.pimenta.fun/mtls-guide/>.

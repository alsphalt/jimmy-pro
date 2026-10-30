# Jimmy Pro

An installable (PWA) M-Pesa payment app: send a real Lipa na M-Pesa **STK prompt** to any phone, share a **pay link** the other person opens themselves, and watch every request settle live.

- **Backend:** Node + Express, real Safaricom Daraja calls (OAuth → STK Push → STK Query → callback), JSON persistence, Server-Sent Events.
- **Frontend:** single-page app, no build step, every control wired to a real endpoint.
- **PWA:** manifest, service worker, offline shell, install prompt, home-screen shortcuts.

---

## Quick start

```bash
cd jimmy-pro
npm install
npm start
# open http://localhost:3000
```

It starts in **demo mode**: every screen and every button works, prompts resolve in ~7 seconds, and **no money moves and no Safaricom call is made**. Use this to trial the flow end to end.

To go live, add Daraja credentials (next section). No code changes needed.

---

## 1. Get Daraja credentials (free)

1. Sign up at <https://developer.safaricom.co.ke>.
2. **My Apps → Add a new app**, tick *Lipa na M-Pesa Sandbox*.
3. Copy the **Consumer Key** and **Consumer Secret**.
4. Sandbox defaults (already prefilled for you):
   - Shortcode: `174379`
   - Passkey: `bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919`

## 2. Configure

Either paste them into the app under **Settings**, or copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

```ini
MPESA_ENV=sandbox
MPESA_CONSUMER_KEY=your_key
MPESA_CONSUMER_SECRET=your_secret
MPESA_PASSKEY=bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919
MPESA_SHORTCODE=174379
MPESA_CALLBACK_URL=https://your-public-host/api/mpesa/callback
BUSINESS_NAME=Jimmy Pro
```

`.env` always wins over values saved in the UI. Save settings then press **Test connection** — it fetches a real OAuth token and tells you if Safaricom accepted the credentials.

## 3. Make the callback reachable

Safaricom must POST the result to a public **https** URL.

```bash
ngrok http 3000
# e.g. https://a1b2c3.ngrok-free.app  ->  https://a1b2c3.ngrok-free.app/api/mpesa/callback
```

Put that URL into **Settings → Callback URL** (the app shows the correct path) and save.

---

## Trial: prompt another person

There are two ways, and both work today:

**A. Prompt a phone directly** — *New → Send to phone*. Enter their Safaricom number and amount. In live mode their phone rings with the M-Pesa PIN prompt immediately; in demo mode the request resolves on its own so you can see the whole lifecycle.

**B. Share a link (works even before you have credentials)** — *New → Share a link*, set an amount, then **Copy** / **Share**. The other person opens `https://your-host/pay/JP-XXXXXX`, types their own number, and gets the prompt on their phone. The owner's dashboard updates live via SSE.

To let someone else trial the web app itself, expose port 3000 with ngrok and send them the https URL — the PWA is installable from there too.

---

## Business APIs: B2B payments + KYC validation

Two more Daraja products are wired in and share the OAuth token from the same
credentials. All three URLs live in `server/endpoints.js`:

| Product | Method | URL |
| --- | --- | --- |
| OAuth token | `GET` | `/oauth/v1/generate?grant_type=client_credentials` |
| B2B payment | `POST` | `/mpesa/b2b/v1/paymentrequest` |
| KYC validation | `POST` | `/v1/KYC-validation/validateID` |

They run side by side with STK Push: same settings, same sandbox, no extra app.

### What B2B needs

| Setting | Where | Notes |
| --- | --- | --- |
| `MPESA_INITIATOR_NAME` | `.env` or Settings → B2B & KYC | The API operator username from Daraja |
| `MPESA_INITIATOR_PASSWORD` | `.env` | Encrypted server-side, never stored in the app database |
| Safaricom certificate | `certs/safaricom.cer` | See `certs/README.md` |
| `MPESA_B2B_PARTY_A` | `.env` or Settings | Your sending shortcode (defaults to your STK shortcode) |
| `MPESA_RESULT_URL` / `MPESA_TIMEOUT_URL` | `.env` or Settings | Public https URLs for the async result |

`server/security.js` builds the `SecurityCredential` exactly the way Safaricom
expects: your initiator password RSA-encrypted (PKCS#1 v1.5) with their public
certificate, then base64. It caches the result, and tells you plainly what is
missing instead of failing mid-payment. If you already have a base64
credential, set `MPESA_SECURITY_CREDENTIAL` and skip the encryption.

**B2B is asynchronous.** The request returns a `ConversationID` (accepted), and
Safaricom later posts the outcome to `/api/b2b/callback`, which flips the record
to `success` with a `TransactionID`. The UI polls while it waits, so the card
updates on its own.

```bash
curl -X POST http://localhost:3000/api/b2b/payments \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": 1200,
    "partyB": "600000",
    "commandId": "BusinessPayBill",
    "accountReference": "SUP-88",
    "remarks": "Supplier payout"
  }'
```

```json
{
  "payment": {
    "ref": "BP-4A2K7D",
    "amount": 1200,
    "partyA": "174379",
    "partyB": "600000",
    "commandId": "BusinessPayBill",
    "status": "pending",
    "conversationId": "AG_20261030_...",
    "resultDesc": "Acceptable to process B2B API request"
  }
}
```

### What KYC needs

Only `MPESA_KYC_SHORTCODE` (defaults to your normal shortcode) and a live
credential set. Every check is billed by Safaricom, so the form is a deliberate
single-shot action rather than a background job.

```bash
curl -X POST http://localhost:3000/api/kyc/validate \
  -H 'Content-Type: application/json' \
  -d '{"msisdn": "0712345678", "idNumber": "12345678", "idType": "01"}'
```

```json
{
  "check": {
    "ref": "KY-H5MKGN",
    "msisdn": "254712345678",
    "status": "valid",
    "code": "0",
    "description": "ID validated successfully",
    "idNumberMasked": "****5678"
  }
}
```

The response is normalised because Safaricom does not publish a fixed schema for
this endpoint — whatever comes back is kept in `raw` and shown in the UI under
"Raw response".

### Trying them without credentials

Both screens work in demo mode: B2B returns a simulated `ConversationID` and
settles after ~4 seconds, KYC returns a simulated `valid` result labelled as
demo. Nothing is sent to Safaricom, so you can rehearse the flow first. The
moment credentials are saved they switch to real calls with no code change.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Uptime, mode, environment |
| `GET` | `/api/settings` | Sanitised config (secrets never returned) |
| `PUT` | `/api/settings` | Save config (`x-admin-pin` if `ADMIN_PIN` set) |
| `POST` | `/api/settings/test` | Live OAuth token check |
| `POST` | `/api/settings/reset` | Back to demo |
| `POST` | `/api/payments` | Create prompt `{phone, amount, accountReference, description}` or link `{mode:"link", amount}` |
| `GET` | `/api/payments?status=&q=` | List / search |
| `GET` | `/api/payments/:id` | One payment |
| `POST` | `/api/payments/:id/query` | STK status query |
| `POST` | `/api/payments/:id/retry` | Prompt again (new record) |
| `POST` | `/api/payments/:id/outcome` | Demo-only manual resolution |
| `DELETE` | `/api/payments/:id` | Delete record |
| `GET` | `/api/stats` | Totals, success rate, 7-day series |
| `GET` | `/api/events` | SSE: `payment`, `payment_deleted` |
| `POST` | `/api/mpesa/callback` | Safaricom STK result |
| `POST` | `/api/mpesa/timeout` | Queue timeout |
| `GET` | `/api/public/pay/:ref` | Public link data |
| `POST` | `/api/public/pay/:ref/prompt` | Payer sends themselves the prompt (rate-limited) |
| `GET` | `/api/export.csv` | CSV export |
| `GET` | `/api/endpoints` | Every Safaricom URL, plus B2B defaults |
| `POST` | `/api/b2b/payments` | Send a B2B payment |
| `GET` | `/api/b2b/payments` | B2B history |
| `DELETE` | `/api/b2b/payments/:id` | Delete a B2B record |
| `POST` | `/api/b2b/callback` | Async B2B result from Safaricom |
| `POST` | `/api/b2b/timeout` | B2B queue timeout |
| `POST` | `/api/kyc/validate` | Validate an ID against an MSISDN |
| `GET` | `/api/kyc/checks` | KYC history |
| `DELETE` | `/api/kyc/checks/:id` | Delete a KYC record |
| `GET` | `/pay/:ref` | Payer-facing page |

---

## Project layout

```
jimmy-pro/
├── server/
│   ├── index.js      routes, SSE, demo simulation, callbacks
│   ├── mpesa.js      OAuth, STK push, STK query, callback parsing
│   ├── b2b.js        B2B payment request + async result parsing
│   ├── kyc.js        KYC / validateID with normalised responses
│   ├── security.js   SecurityCredential (RSA + Safaricom certificate)
│   ├── endpoints.js  every Safaricom URL in one place
│   ├── store.js      atomic JSON store
│   ├── env.js        .env loader
│   └── data/db.json  created on first run
├── public/
│   ├── index.html    owner app
│   ├── pay.html      payer page
│   ├── css/styles.css
│   ├── js/app.js     owner app logic
│   ├── js/pay.js     payer logic
│   ├── sw.js         service worker
│   ├── manifest.webmanifest
│   └── icons/
├── certs/                Safaricom public certificate goes here
├── tools/make-icons.js   regenerates the icon set
└── .env.example
```

## PWA install

- **Android / Chrome / Edge:** Install icon in the header, or browser menu → *Install app*.
- **iOS Safari:** Share → *Add to Home Screen* (the app shows this hint automatically).
- **Desktop:** install icon appears in the address bar.

Service worker caches the shell only; every `/api/` call bypasses the cache so balances and statuses are never stale.

---

## Before you take real money

- Serve over **https** (Safaricom rejects plain http callbacks).
- Set `ADMIN_PIN` so nobody else can change your shortcode through the UI. The app sends it as `x-admin-pin` and remembers it in the browser.
- Put the app behind your own auth if it is publicly reachable — this build ships without user accounts on purpose.
- `server/data/db.json` is the database. Back it up; swap `store.js` for Postgres when you outgrow it.
- Go-live on Daraja requires a production passkey and an approved shortcode.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Safaricom rejected the credentials` | Wrong consumer key/secret, or an app without the Lipa na M-Pesa product |
| `Callback URL is missing` | Set a public https callback in Settings |
| Request stays *pending* forever | Customer ignored the prompt; query status, then retry |
| Result code `1032` | Customer cancelled |
| Result code `1037` | No response / timeout |
| `2001` | Wrong M-Pesa PIN |
| `1` | Insufficient funds |
| Works locally, not on a phone | Callback URL must be public https — use ngrok |
| `SecurityCredential is missing` | Set `MPESA_INITIATOR_PASSWORD` and drop the certificate in `certs/` |
| `Initiator name is missing` | Set `MPESA_INITIATOR_NAME` to your Daraja API operator username |
| B2B stays *pending* | Safaricom never posted the result — check `MPESA_RESULT_URL` is public |
| KYC returns `invalid` | The ID and number do not match, or the product is not enabled on your app |

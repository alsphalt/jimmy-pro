# Running Jimmy Pro safely

This app can move real money. Read this before putting it on a URL and sending
that URL to anyone.

## 1. Credentials never live in the repo

Everything secret comes from the environment:

| Variable | Why it matters |
|---|---|
| `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` | Daraja identity. Anyone with these can act as your app. |
| `MPESA_PASSKEY` | Combined with the shortcode into the STK password. |
| `MPESA_INITIATOR_PASSWORD` / `MPESA_SECURITY_CREDENTIAL` | Lets a caller move money out of your shortcode (B2B). |

- `.env` is gitignored and chmod `600`. Never commit it, never paste it into a
  chat, a screenshot, or an issue.
- Values from the environment always win over anything saved in the UI.
- On a host (Vercel, Render, Fly), set them as environment variables and leave
  `.env` out of the deploy entirely.
- `db.json` (default `./data/db.json`) is written `0600` and is gitignored too.

If a secret has ever been pasted somewhere it does not belong: rotate it on the
Daraja portal (regenerate the app's key/secret) rather than assuming nobody saw it.

## 2. Where the money actually goes

An STK Push **settles to `MPESA_SHORTCODE`** — the paybill or till number. Daraja
has no parameter that redirects a customer payment to a personal handset.

`MPESA_OWNER_MSISDN` is the operator's own number. It is used for labelling and
as the default destination for payouts. It is **not** a settlement target, and
`POST /api/payments` rejects `settleToMsisdn` / `receiverMsisdn` / `payToMsisdn`
with a 400 rather than silently ignoring the field.

To have funds land on a personal number, pick one:

1. **B2C payout after collection** — enable the B2C product on the Daraja app
   (needs approval), then disburse from the shortcode to the handset.
2. **Buy Goods till registered to that number** — set
   `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` and `MPESA_SHORTCODE` to the
   till, so settlement itself is the owner's number.

## 3. Before sharing the link with other people

- Set `ADMIN_PIN` (or put the whole app behind your own auth). Without it every
  settings change is unauthenticated.
- Set `MPESA_CALLBACK_URL` to a public https URL ending in
  `/api/mpesa/callback`. Safaricom will not call back over plain http.
- Anyone who can reach `/api/b2b/payments` can move money out of your shortcode.
  Do not expose the owner API publicly without auth.
- The payer-facing page (`/pay/:ref`) and `POST /api/public/pay/:ref/prompt`
  are meant to be public; everything else is not.

## 4. Deploying to a host (the short version)

Set these six, then redeploy. Nothing else is required — the callback URL is
derived from `PUBLIC_URL`.

| Variable | Example |
|---|---|
| `MPESA_ENV` | `sandbox` |
| `MPESA_CONSUMER_KEY` | from the Daraja portal |
| `MPESA_CONSUMER_SECRET` | from the Daraja portal |
| `MPESA_PASSKEY` | the passkey for your shortcode |
| `MPESA_SHORTCODE` | `174379` |
| `PUBLIC_URL` | `https://your-app.vercel.app` (no trailing slash) |

Check the result with `GET /api/health`. It reports `mode`, the exact `missing`
list, whether a callback URL resolved, and whether the values came from
`environment` or app settings — so "keys are wrong" and "keys never reached the
process" stop looking the same.

Saving credentials through the Settings screen also works, but on hosts with an
ephemeral filesystem that data disappears on the next deploy; environment
variables are the durable path.

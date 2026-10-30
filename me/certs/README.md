# Safaricom certificate

B2B (and other operator APIs) need a **SecurityCredential**: your initiator
password RSA-encrypted with Safaricom's public certificate.

1. Download the certificate from the Daraja portal
   (<https://developer.safaricom.co.ke>) — the file is usually named
   `ProductionCertificate.cer` or `SafaricomCertificate.cer`.
2. Save it here as `safaricom.cer` (`.pem` and `.crt` are also picked up).
3. Put the initiator password in `.env`:

   ```ini
   MPESA_INITIATOR_NAME=your_api_operator
   MPESA_INITIATOR_PASSWORD=your_password
   ```

The server encrypts it on first use (RSA PKCS#1 v1.5) and caches the result.
You can confirm it worked under **Settings → B2B & KYC** — it says
"Security credential ready" once the certificate is readable.

The same certificate is used for sandbox and production.

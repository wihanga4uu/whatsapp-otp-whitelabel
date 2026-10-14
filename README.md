# WhatsApp OTP White-Label Platform — V2.4

A reusable white-label WhatsApp OTP and transactional messaging service for
Windows/RDP or other Node.js servers.

## Features

- WhatsApp QR/device linking with Baileys
- 6-digit OTP generation and verification
- OTP expiry, resend cooldown, attempt limits
- Auto reconnect and connection health monitoring
- Single-recipient transactional message API
- Password-protected admin panel
- Editable brand/organization settings
- Editable OTP message template
- Saved normal-message templates
- Template placeholders such as:
  - `{{OTP}}`
  - `{{BUSINESS_NAME}}`
  - `{{MINUTES}}`
  - `{{WEBSITE}}`
  - `{{SUPPORT}}`
  - `{{NAME}}`
  - `{{PHONE}}`
- Runtime settings stored outside Git
- Windows BAT/PowerShell helper files

## White-label use

The same codebase can be reused for different organizations such as:

- CROWN ASIA
- Southland International
- Another school/company/client

Each installation can keep its own `.env`, WhatsApp session, branding, and
templates without modifying the Git repository.

## Requirements

- Node.js 20+
- Windows Server/RDP or another Node.js-capable server
- A WhatsApp account that can link a device
- Internet access

## Quick start

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`, then run:

```powershell
node server.mjs
```

Or use the included Windows helper scripts.

After startup, scan the QR code from:

**WhatsApp → Linked devices → Link a device**

## Admin panel

Local:

```text
http://127.0.0.1:3000/admin
```

Use the `ADMIN_PASSWORD` configured in `.env`.

From the admin panel you can customize branding and message templates without
editing source code.

## API

### Send OTP

```http
POST /api/request-otp
x-api-key: YOUR_API_KEY
Content-Type: application/json
```

```json
{
  "phone": "94771234567"
}
```

### Verify OTP

```http
POST /api/verify-otp
x-api-key: YOUR_API_KEY
Content-Type: application/json
```

```json
{
  "phone": "94771234567",
  "otp": "123456"
}
```

### Send a normal transactional message

```http
POST /api/send-message
x-api-key: YOUR_API_KEY
Content-Type: application/json
```

```json
{
  "phone": "94771234567",
  "message": "Your account has been approved."
}
```

## Files intentionally excluded from GitHub

The following are **local/runtime secrets** and are ignored:

```text
.env
baileys_auth_info/
brand-settings.json
.otp-bot.lock
node_modules/
```

Do not override these ignore rules.

## Backup strategy

GitHub stores the reusable source code.

For security, GitHub should **not** be used as a backup for the live WhatsApp
session, `.env` secrets, or client-specific runtime settings. Store those in a
secure private backup separately if required.

## GitHub setup

See:

`GITHUB-UPLOAD.md`

## Security

See:

`SECURITY.md`

## Important note

This project uses an unofficial WhatsApp Web integration. It is not the
official Meta WhatsApp Business Platform. WhatsApp protocol changes can affect
operation and linked sessions can be invalidated. Use the system for
user-requested OTPs and expected transactional notifications, not unsolicited
bulk messaging.

# GitHub Upload Guide

## Recommended repository

Create a **Private** repository, for example:

`whatsapp-otp-whitelabel`

Do not initialize the GitHub repository with a README, .gitignore, or license
if you plan to push this folder directly.

## First push from Windows PowerShell

Open PowerShell inside this project folder:

```powershell
git init
git branch -M main
git add .
git status
```

Before committing, confirm these do **NOT** appear in `git status`:

```text
.env
baileys_auth_info/
brand-settings.json
node_modules/
.otp-bot.lock
```

Then commit:

```powershell
git commit -m "Initial white-label WhatsApp OTP platform v2.4"
```

Add your GitHub repository:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/whatsapp-otp-whitelabel.git
git push -u origin main
```

## Future updates

```powershell
git add .
git status
git commit -m "Update WhatsApp OTP platform"
git push
```

## Restore on a new server

After cloning:

```powershell
npm install
Copy-Item .env.example .env
```

Then edit `.env`, run the application, and link WhatsApp using a fresh QR code.
Do not expect WhatsApp session credentials to be restored from GitHub because
they are intentionally excluded.

# Security

This repository is designed to keep credentials out of Git.

## Never commit

- `.env`
- `baileys_auth_info/`
- `brand-settings.json`
- API keys
- Admin passwords
- WhatsApp session credentials
- Cloudflare tunnel tokens or credentials

These paths are already included in `.gitignore`.

## If a secret is accidentally committed

1. Rotate the exposed API key/password immediately.
2. Revoke and re-link the WhatsApp session if session files were exposed.
3. Remove the secret from Git history before making the repository public.

## Repository visibility

A **Private** GitHub repository is strongly recommended for this project.

## WhatsApp integration

This project uses an unofficial WhatsApp Web integration. Protocol changes,
session invalidation, or account restrictions can occur. Use it only for
messages users expect to receive, such as OTPs and transactional notifications.

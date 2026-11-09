# Gildiusz

[Wersja polska](README.md)

A Discord community bot with a Polish interface: temporary voice rooms, reports to moderators, attachment format checks, and a server-specific bot nickname and avatar.

This is an early, self-hosted version. One process can serve several guilds, each with a separate database and settings. It needs a continuously running host. When public mode is enabled, administrators choose their own channels, roles and modules in the web panel. Public service availability and its address depend on the operator deployment.


## Features

- Personal voice rooms created through a technical entry channel, configurable room limits, creation cooldowns, and empty-room cleanup.
- `/pokoj`: rename, lock, unlock, and invite a participant.
- `/zglos`: send a private report to moderators.
- Interest roles through reactions on the bot's selection panel: adding a reaction grants its role, removing it revokes that role. Selections are reconciled on restart and every five minutes; rules acceptance remains separate.
- `/ustawienia` and `/panel`: a private administration panel, also available through a persistent channel button.
- A per-server nickname and avatar with preview, confirmation, cancellation, and reset to defaults. PNG, JPG, and GIF images up to 2 MB.
- An attachment format allowlist covering PDF, PNG, JPG, JPEG, WebP, and GIF, with file header checks after a message is posted.
- A configurator for channels, roles, forums, onboarding, and AutoMod, with a reviewable plan before changes are applied.

The bot does not record conversations or use AI services. Format checks are not antivirus scanning. Member uploads are disabled by default until the filter has been accepted on the target server.

## Website and web panel: local preview



The editor validates modules, channels, roles, formats and room limits before saving. Preview settings and sessions persist in the private .gildiusz-web directory outside source control; GILDIUSZ_WEB_DATA_DIR can select another private directory. Preview writes never change Discord or the bot's databases.

The server-side OAuth flow requires private credentials, the /api/auth/callback redirect and a SESSION_SECRET containing 32 random base64-encoded bytes. It lists guilds owned or managed by the signed-in account. Real writes are rejected until a bot-worker connection is implemented. Public invites have a separate DISCORD_INSTALL_ENABLED=0 gate. Legal pages are explicitly marked as local drafts.

Run npm run web:check and npm run web:build for website checks. CI has a separate web job; the existing hosting artifact still contains only the bot.

## Getting started

Node.js 24 LTS, version 24.17.0 or newer, and npm are required. SQLite is built into Node.js.

```sh
git clone https://github.com/K44DEUSZ/gildiusz.git
cd gildiusz
npm ci --ignore-scripts
npm run check
npm test
npm run cli -- validate
```


`config/server.json` and `content/` contain the Kampus Projektów community example. Review and adapt these files before applying a plan to your server. Validation alone does not change Discord.

After setup:

```sh
npm run build
npm start
```


Shared hosting can use a separate worker supervised through CRON. The
private state, recovery and explicitly enabled updates from checked pushes to `main`.

After a successful deployment, the installer keeps the current and previous packages; CRON rotates logs exceeding 5 MiB. Private database backups are retained separately.

## License

MIT. Copyright 2026 Bartosz Golat. Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

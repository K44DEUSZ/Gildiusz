# Gildiusz

[Wersja polska](README.md)

A Discord community bot with a Polish interface: temporary voice rooms, reports to moderators, attachment format checks, and a server-specific bot nickname and avatar.

This is an early, self-hosted version. One process can serve several explicitly configured guilds, each with a separate database and settings. It needs a continuously running host. New guilds require operator setup; public self-service installation is not implemented.


## Features

- Personal voice rooms created through a technical entry channel, configurable room limits, creation cooldowns, and empty-room cleanup.
- `/pokoj`: rename, lock, unlock, and invite a participant.
- `/zglos`: send a private report to moderators.
- `/ustawienia` and `/panel`: a private administration panel, also available through a persistent channel button.
- A per-server nickname and avatar with preview, confirmation, cancellation, and reset to defaults. PNG, JPG, and GIF images up to 2 MB.
- An attachment format allowlist covering PDF, PNG, JPG, JPEG, WebP, and GIF, with file header checks after a message is posted.
- A configurator for channels, roles, forums, onboarding, and AutoMod, with a reviewable plan before changes are applied.

The bot does not record conversations or use AI services. Format checks are not antivirus scanning. Member uploads are disabled by default until the filter has been accepted on the target server.

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

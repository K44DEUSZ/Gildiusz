# Gildiusz

A Discord community bot with a Polish interface: temporary voice rooms, reaction roles, attachment format checks and reports to moderators.

## Features

- **Voice rooms:** create a personal room through an entry channel, rename it, lock it, invite members and clean it up after the conversation.
- **Reaction roles:** select several roles using emoji; removing a reaction removes its role.
- **File filtering:** choose formats for each channel and check file headers after a message is sent. PDF, PNG, JPG, JPEG, WebP and GIF are allowed by default; additional image, audio, video and archive formats can be selected. Format validation is not antivirus scanning.
- **Reports:** privately forward a problem description to the moderation channel chosen by the guild administrators.

Every guild has independent settings. Modules can be enabled separately and connected to existing channels and roles. The bot does not record voice conversations.

## Guild settings

The owner or a member with **Manage Server** can configure the bot. Use `/ustawienia` for the Discord settings panel. `/konfiguracja` opens the web panel when its operator has provided a public address. Members use `/pokoj` and `/zglos`. Self-selected roles must remain below the bot; rules acceptance is separate.

## Project status

This is an early version. The website and panel are developed separately; the shared public service is being prepared. This repository contains the bot source for self-hosting.

The `test` branch includes work on meetings, reports with conversation history, suggestions, scheduled announcements, Twitch integration and server rules acceptance with a member role. These features still require acceptance testing before release in the shared service. Activity points and ranks are planned.

<details>
<summary>Run your own instance</summary>

Use Node.js 24 LTS, version 24.17 or newer, and your own Discord application with Message Content Intent enabled.

```sh
git clone https://github.com/K44DEUSZ/Gildiusz.git
cd Gildiusz
npm ci --ignore-scripts
npm run build
npm run cli -- validate
```

Copy `.env.example` to `.env` and provide your application and guild settings. Keep the token private. The example community layout is in `config/server.json`; message content is in `content/`.

Review a plan before applying each phase: `core`, `community`, then `content`. Approval uses the exact plan hash.

```sh
npm run cli -- plan --phase core
npm run cli -- apply --file reports/deployment-plan.json --approve HASH_FROM_PLAN
```

The bot does not need Administrator. Check permissions and role hierarchy, use persistent storage and run one worker instance. Start the prepared bot with `npm start`, or use `docker compose up -d`.

</details>

## Help and license

Report bugs through [Issues](https://github.com/K44DEUSZ/Gildiusz/issues), without tokens or member data. See [SECURITY.md](SECURITY.md) for security reports.

The code uses the [MIT license](LICENSE). [Dependencies](THIRD_PARTY_NOTICES.md) retain their licenses. [Polski](README.md).

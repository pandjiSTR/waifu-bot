# Public Release Plan

Make this repo clone-able and reusable by anyone — remove all hardcoded persona traces.

## Phase 1 — BOT_NAME Env Var

| File | Change |
|---|---|
| `.env.example` | Add `BOT_NAME=ara` (default: `bot`) |
| `src/gatekeeper.js:135` | `/\bara+\b/i` → `new RegExp('\\b' + BOT_NAME + '+\\b', 'i')` |
| `src/gatekeeper.js:143` | `'ara fresh'` / `'ara status'` → `` `${BOT_NAME} fresh` `` / `` `${BOT_NAME} status` `` |
| `src/baileys.js:161` | `browser: ['Ara (Chrome)', ...]` → `` [`${BOT_NAME} (Chrome)`, ...] `` |
| `src/sticker.js:40` | `STICKER_PACK = 'ara bikin stiker'` → `` `${BOT_NAME} bikin stiker` `` |
| `src/sticker.js:64-65` | `ara-sticker-*` → `waifu-sticker-*` |

## Phase 2 — Dashboard & Auth Generic

| File | Change |
|---|---|
| `dashboard/index.html:6` | `<title>Ara -- Personal AI Chatbot</title>` → `<title>Waifu Bot</title>` |
| `dashboard/login.html:6` | Same |
| `dashboard/settings.html:21` | `Ara mengirim pesan proaktif` → `Bot mengirim pesan proaktif` |
| `dashboard/settings.html:46` | `mengakses Ara` → `mengakses bot` |
| `src/auth.js:9` | `COOKIE_NAME = 'ara_session'` → `'waifu_session'` |
| `src/autochat.js:159` | `sender: 'ara'` → `sender: 'bot'` |

## Phase 3 — Code Cleanup

| File | Change |
|---|---|
| `src/pipeline.js` | `araRecentLaughed` → `botRecentLaughed` |
| `src/context.js:155` | Comment update |
| `src/baileys.js:277` | Comment update |
| `src/media.js:22,27` | `VISION_FALLBACK` + `VISION_PROMPT` → English defaults |

## Phase 4 — personality.txt.example

- Add English template option alongside Indonesian
- Clearer instructions for first-time users

---

## Fork — Private Ara Version

1. Fork `pandjiSTR/waifu-bot` via GitHub UI → visibility **Private**
2. Fork brings all branches including `dev` (with `personality.txt`)
3. Delete `dev` from public repo: `git push origin --delete dev`

**Result:**
| Repo | Visibility | Use |
|---|---|---|
| `pandjiSTR/waifu-bot` | Public | Open source, anyone can clone |
| `pandjiSTR/ara-waifu-bot` | Private | Personal Ara version |

---

## Notes

- `BOT_NAME` env var default: `bot`. Users set it to their own bot's name.
- No breaking changes to Redis keys or data model.

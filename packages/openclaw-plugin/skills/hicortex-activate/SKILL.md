---
name: hicortex-activate
description: Activate a Hicortex license key. Use when the user says they purchased Hicortex, has a license key, or wants to upgrade from the free tier.
version: 0.2.0
user-invocable: true
disable-model-invocation: false
---

# Activate Hicortex License

When the user wants to activate their license key, guide them through it.

## If they provide the key (e.g. `/hicortex-activate hctx-abc123`)

Run this command to apply the key:

```bash
openclaw config set plugins.entries.hicortex.config.licenseKey "THE_KEY_HERE"
```

Then restart the gateway:

```bash
openclaw gateway restart
```

Tell the user: "License activated! Hicortex now has unlimited memory. Your agent will keep learning and improving from every session."

## If they don't have a key yet

Tell them:

"You can get a license key at https://hicortex.gamaze.com/ — after purchase, you'll receive your key by email. Then come back and tell me the key, and I'll activate it for you."

## If activation fails

If the `openclaw config set` command fails, fall back to telling the user to manually add it:

"Open ~/.openclaw/openclaw.json, find the hicortex plugin entry, and add your key:

```json
"config": {
  "licenseKey": "hctx-your-key-here"
}
```

Then restart: `openclaw gateway restart`"

## Rules

- Never ask the user to open a terminal or edit files unless the automatic method fails
- Always confirm the key was applied by checking the gateway log after restart
- Be encouraging — they just bought the product

---
name: telegram-custom-emoji-mosaic
description: "Use when мозаика из Telegram custom emoji: «сделай эмодзи-мозаику из картинки» — 100×100 WEBP-тайлы, custom_emoji set через Bot API, одним сообщением."
---

# Telegram Custom Emoji Mosaic

Turn a single image into a **genuine Telegram mosaic assembled from Premium custom emoji**: slice the picture, publish tiles as a real `custom_emoji` sticker set through the Bot API, send the reassembled picture as one message the user can forward or paste into a post.

Input: PNG/JPEG/WEBP. Output: a Telegram message + shareable pack link.

## Requirements
- Telegram Bot API token (from environment only — never log it or echo it)
- **Telegram Premium on the bot owner's account** (without it custom emoji cannot be sent)
- `ffmpeg`, Python 3 + `requests`
- The user must have opened a dialog with the bot first (bots can't write first)

## The main principle
**The deliverable is a real message made of custom emoji** — never a ZIP, preview render, or folder of tiles. A run producing tiles but no sent message is a failed run. Never add blur, letterbox bars, backgrounds, or visible crop unless the user asks (minimal symmetric crop of a few pixels allowed when proportions nearly match a grid).

## Grid selection — do not force a square
Pick the grid `columns × rows ≤ 100` minimizing aspect-ratio error vs the source (square→10×10, 4:5→8×10, wide 14:6→14×6). Build the canvas at `columns*100 × rows*100` so every tile lands on a 100×100 boundary.

## Telegram limits (all bind at once)
- max **100 custom emoji per message** (hard ceiling on grid size)
- up to **50 emoji** at set creation; the rest via `addStickerToSet`
- every static custom emoji exactly **100×100 px**
- bot owner needs Premium; user must have started the dialog

## Procedure
1. Read source dimensions → 2. find best grid → 3. build canvas → 4. slice WEBP tiles row-major → 5. verify count/dimensions/reconstruction → 6. upload via `uploadStickerFile` → 7. create `custom_emoji` set, add remaining tiles → 8. collect `custom_emoji_id` per tile → 9. assemble message with correct **UTF-16 offsets** for entities (outside-BMP emoji = 2 units; compute against UTF-16 encoding or the mosaic renders scrambled) → 10. send → 11. verify via API.

## Pack naming
Title = `<owner's channel handle> <8-char id>` where id = first 8 hex chars of a content hash (idempotent re-runs, no duplicate packs). Configure the channel handle once per installation, don't hardcode per run.

## Definition of done
Real `message_id` returned; pack type `custom_emoji`; emoji count = tile count; every `custom_emoji_id` exists and unique; message has the expected number of `custom_emoji` entities; `https://t.me/addemoji/<set_name>` opens with the correct title. Anything less = incomplete, report as such.

## Security
Bot token read at runtime from a protected environment only; never printed to logs, never echoed, never written into artifacts.

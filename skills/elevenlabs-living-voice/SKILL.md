---
name: elevenlabs-living-voice
description: "Use when текст готовится под озвучку ElevenLabs: «озвучить текст», voiceover — паузы/дыхание/audio-теги, выбор модели v2/v3, подстройка голосовых настроек через API (stability/speed), речь плоская/быстрая/монотонная. Смежные: другие TTS и распознавание речи — не этот скилл."
---

# ElevenLabs — Living Voice

Make TTS speech alive on two layers: (1) rewrite the text so the model naturally catches pauses, accents, breath and tempo shifts; (2) use API voice settings as working knobs for user feedback. Core idea: liveliness = right voice → right model → well-written text → careful feedback loop.

## Model split
- **Eleven Multilingual v2** — stable long-form (10k chars). Pauses via punctuation + moderate SSML `<break time="Xs" />` (practical ceiling 3s; too many tags → speech speeds up and artifacts appear).
- **Eleven v3** — most emotional/expressive. NO SSML break tags. Direct the delivery through text rhythm, punctuation and rare audio tags: `[whispers] [sighs] [laughs] [slow] [excited] [pause] [reflective]`. A tag affects roughly the next 4–5 words. One good tag beats ten chaotic ones.

## Canonical writing rule
- one phrase = one breathing unit; chunks of 4–12 words, not 35-word monoliths;
- commas = short breaths; dashes = a turn or semantic hit; ellipsis = hesitation/intimacy;
- important word near the end of a short phrase; different emotions → different sentences;
- **hard rule: every 1–3 sentences carries at least one anchor** (explicit pause, rhythm change, emotional marker, short accent phrase, or v3 pinpoint tag). Text readable in one flat tone = under-marked, rewrite it.

## Pause escalation (if pauses aren't audible)
1. comma → 2. period → 3. new line → 4. short standalone accent phrase (`Stop.` `Right here.`) → 5. `...` → 6. `... ...` (forced separation) → 7. for v2 — exact `<break time="..."/>`. The worse the model separates words by ear, the more script-like the text may become.

## Winning pattern from A/B tests
Build contrasting emotional states into the source text (neutral → harder → sadder → softer), keep strong pause structure but clean out sibilant/mechanical spots. Target: drama + sonic stability hybrid, not max expression.

## Feedback loop through API
User complaints are signals to adjust settings, endpoint `POST /v1/voices/{voice_id}/settings/edit` (`stability` 0.5, `similarity_boost` 0.75, `style` 0, `speed` 1.0):
- «too slow/fast» → speed ±0.03–0.08 (first clean the text);
- «too flat» → lower stability; for v3 fix text + tags first;
- «overacting» → lower style, raise stability, remove tags;
- «not enough similarity» → raise similarity_boost;
- «too chaotic» → raise stability, cut punctuation tricks and tags.
Change 1–2 parameters per pass, test on the same sample. When complaints stop, current config is canonical — don't reset to defaults.

## Pitfalls
No SSML in v3; not too many breaks in v2; bad text isn't cured by settings; don't change everything at once; don't over-tag v3; don't reset a good setting without reason.

## Preflight preprocessor
A deterministic `preflight.py` (normalize spacing/pauses; convert v3-unsupported `<break>` to textual pauses, keep them for v2) can run before synthesis. Env: `HERMES_TTS_PROVIDER=elevenlabs`, `HERMES_TTS_MODEL_ID=eleven_v3|eleven_multilingual_v2`. Ask the memory/DSH store (deploychan get_skill elevenlabs-living-voice) for the full script source when needed.

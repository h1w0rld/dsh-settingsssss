// messenger-ru TTS patch (2026-10): explicit voice-note export tool.
// The model supplies the text; synthesis (edge-tts) and conversion (ffmpeg) run on the Host.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { synthesizeSpeech, mp3ToOggOpus, TTS_BYTE_LIMIT } from './tts.js';

/** Explicit export only: the agent chooses to speak, recipients are current session bindings. */
export function installVoiceTool(ctx, getActiveBridges) {
    return ctx.tools.register(defineTool({
        name: 'messenger_send_voice',
        description: 'Speak text as a Telegram voice note to authorized messenger chats currently bound to your session. '
            + 'Synthesized on the Host with Edge neural voices (ru-RU by default); no keys needed. '
            + 'Use when the user asks you to answer by voice or read something aloud; never for secrets. '
            + 'Requires a top-level agent session and a bound chat; subagents are rejected. '
            + 'Reports sent, failed, and skipped chat counts, not read receipts; do not blindly retry partial failures.',
        parameters: {
            text: { type: 'string', required: true, description: 'Text to speak. Longer texts are split at sentence boundaries automatically (limit 10 000 characters).' },
            voice: { type: 'string', description: 'Voice name or preset: dmitry | svetlana | en-guy | en-aria, or a full Edge voice name like ru-RU-DmitryNeural.' },
            rate: { type: 'string', description: 'Optional speaking rate, e.g. "+10%" or "-15%".' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sent: { type: 'integer', required: true },
                    failed: { type: 'integer', required: true },
                    skipped: { type: 'integer', required: true },
                    voice: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute({ text, voice, rate }, exec) {
            if (exec.agent === undefined)
                throw new Error('messenger_send_voice requires an agent session.');
            if (exec.agent.session?.header.origin === 'subagent') {
                throw new Error('Voice messages must be sent by the top-level agent, not a subagent.');
            }
            if (typeof text !== 'string' || !text.trim())
                throw new Error('text must be a non-empty string.');
            const sessionId = String(exec.agent.id);
            const bridges = getActiveBridges();
            if (bridges.length === 0)
                throw new Error('Messenger is disabled or unavailable.');
            const bound = bridges.filter((bridge) => bridge.canSendVoice(sessionId))
                .map((bridge) => ({ bridge, version: bridge.imageBindingVersion(sessionId) }));
            if (bound.length === 0)
                throw new Error('No authorized messenger chats are bound to this session.');
            exec.signal.throwIfAborted();
            const speech = await synthesizeSpeech({ text, voice, rate, signal: exec.signal });
            exec.signal.throwIfAborted();
            const audio = await mp3ToOggOpus(speech.bytes, exec.signal);
            if (audio.bytes.byteLength > TTS_BYTE_LIMIT)
                throw new Error('Synthesized speech exceeds the 20 MB Telegram limit; use a shorter text.');
            exec.signal.throwIfAborted();
            // A reconfigured runtime or changed binding must not inherit an in-flight export.
            const current = getActiveBridges();
            const eligible = bound.filter(({ bridge, version }) => current.includes(bridge)
                && bridge.canSendVoice(sessionId) && bridge.imageBindingVersion(sessionId) === version);
            if (eligible.length === 0)
                throw new Error('The messenger binding changed before the voice could be sent.');
            const results = await Promise.all(eligible.map(({ bridge }) => bridge.sendVoice(sessionId, audio, exec.signal)));
            const counts = results.reduce((total, result) => ({
                sent: total.sent + result.sent,
                failed: total.failed + result.failed,
                skipped: total.skipped + result.skipped,
            }), { sent: 0, failed: 0, skipped: 0 });
            return { ...counts, voice: speech.voiceUsed ?? 'unknown' };
        },
    }));
}

// Web Speech API STT via headless Chrome + PulseAudio virtual mic (2026-09-25).
// Usage: node stt.js <audio-file ogg/wav> [lang]
// Prints recognized text to stdout.
// Pipeline: ensure pulse + null-sink/remapped source → start Chrome recognition →
// paplay file into the virtual mic → collect finals → print.
const { execFile, spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.STT_CHROME_BIN ||
    '/opt/stt/chrome/browsers/chrome/linux-154.0.8037.57/chrome-linux64/chrome';
const LANG = process.argv[3] || 'ru-RU';
const FILE = process.argv[2];
const DEADLINE_MS = Number(process.env.STT_DEADLINE_MS || 180000);
const QUIET_TAIL_MS = Number(process.env.STT_QUIET_TAIL_MS || 4000);

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 30000 }, (err, stdout) =>
            err ? reject(err) : resolve(stdout));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensurePulse() {
    try { await run('pactl', ['info']); } catch {
        await run('pulseaudio', ['--start', '--exit-idle-time=-1']).catch(() => { });
        await sleep(800);
    }
    const sinks = await run('pactl', ['list', 'sinks', 'short']).catch(() => '');
    if (!sinks.includes('sttsink'))
        await run('pactl', ['load-module', 'module-null-sink', 'sink_name=sttsink']).catch(() => { });
    const sources = await run('pactl', ['list', 'sources', 'short']).catch(() => '');
    if (!sources.includes('sttsrc'))
        await run('pactl', ['load-module', 'module-remap-source', 'master=sttsink.monitor', 'source_name=sttsrc']).catch(() => { });
    await run('pactl', ['set-default-sink', 'sttsink']).catch(() => { });
    await run('pactl', ['set-default-source', 'sttsrc']).catch(() => { });
}

async function main() {
    if (!FILE) { console.error('usage: stt.js <file> [lang]'); process.exit(2); }
    await ensurePulse();
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', FILE,
        '-ar', '44100', '-ac', '2', '/home/stt-tmp/stt-play.wav']);

    const b = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
            '--use-fake-ui-for-media-stream'],
    });
    try {
        await b.defaultBrowserContext().overridePermissions('http://127.0.0.1:8765', ['microphone']);
        const p = await b.newPage();
        await p.setRequestInterception(true);
        p.on('request', r => r.respond({ status: 200, contentType: 'text/html', body: '<html><body>stt</body></html>' }));
        await p.goto('http://127.0.0.1:8765/x.html', { waitUntil: 'domcontentloaded' });

        // 1) install recognition machinery; it starts immediately
        await p.evaluate((lang) => {
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SR) { window.__sttError = 'noSR'; return; }
            window.__finals = [];
            window.__interim = '';
            window.__started = false;
            const start = () => {
                const rec = new SR();
                rec.lang = lang;
                rec.continuous = true;
                rec.interimResults = true;
                rec.onstart = () => { window.__started = true; };
                rec.onresult = e => {
                    for (let i = e.resultIndex; i < e.results.length; i++) {
                        const t = e.results[i][0].transcript.trim();
                        if (e.results[i].isFinal) { if (t) window.__finals.push(t); window.__interim = ''; }
                        else if (t) window.__interim = t;
                    }
                };
                rec.onerror = e => { window.__sttError = e.error; };
                rec.onend = () => { if (!window.__sttError) setTimeout(start, 200); };
                try { rec.start(); } catch { /* ignore */ }
            };
            start();
        }, LANG);
        if (await p.evaluate(() => window.__sttError === 'noSR')) {
            console.error('SpeechRecognition unavailable'); process.exit(3);
        }
        // wait until recognition service is really up (or 5s)
        for (let i = 0; i < 25 && !(await p.evaluate(() => window.__started)); i++)
            await sleep(200);

        // 2) play the audio into the virtual mic
        const player = spawn('paplay', ['/home/stt-tmp/stt-play.wav'], { stdio: 'ignore' });
        player.on('exit', code => { p.evaluate(c => { window.__playExit = c; }, code).catch(() => { }); });

        // 3) wait for playback end + quiet tail (or hard error/deadline)
        const t0 = Date.now();
        let failed = null;
        while (Date.now() - t0 < DEADLINE_MS) {
            await sleep(400);
            const st = await p.evaluate(() => ({ done: window.__playExit, err: window.__sttError }));
            if (st.err && st.err !== 'no-speech' && st.err !== 'aborted') { failed = st.err; break; }
            if (st.done !== undefined && Date.now() - t0 > 0) {
                // playback finished; give the recognizer QUIET_TAIL_MS to finalize
                const tailStart = Date.now();
                let stable = true;
                while (Date.now() - tailStart < QUIET_TAIL_MS) {
                    await sleep(300);
                    const s2 = await p.evaluate(() => window.__sttError);
                    if (s2 && s2 !== 'no-speech' && s2 !== 'aborted') { failed = s2; break; }
                }
                break;
            }
        }
        const text = await p.evaluate(() =>
            (window.__finals.join(' ') + ' ' + window.__interim).trim());
        try { player.kill(); } catch { /* ignore */ }
        if (failed) { console.error('stt error: ' + failed); }
        console.log(text);
    } finally {
        await b.close().catch(() => { });
    }
}

main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });

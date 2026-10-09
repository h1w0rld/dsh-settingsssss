#!/usr/bin/env bash
# Lifecycle for all local STT runtimes used by dsh-messenger (patch 2026-10-03).
# Usage: ensure-model.sh <vosk|tone|gigaam|chrome> <ensure|remove|present|path>
# Policy (user request 2026-10-03): EVERYTHING lives under /opt/stt; archives
# are deleted right after unpacking, and ONLY the active mode's runtime may
# occupy disk — the bridge removes all others (vosk/tone/gigaam/chrome) on each
# mode switch. chrome = headless Chrome runtime for the browser (Google Web
# Speech) mode: puppeteer-core npm deps + pinned chrome build, rebuilt from
# the chrome-src directory that SHIPS WITH THE PLUGIN (stt/chrome-src; falls
# back to the legacy /opt/stt/src) on demand.
set -euo pipefail

STT_ROOT=/opt/stt
# Chrome-mode npm sources: sibling chrome-src of this script (vendored in the
# plugin package), overridable via CHROME_SRC, legacy /opt/stt/src as fallback.
CHROME_SRC="${CHROME_SRC:-$(dirname "$(readlink -f "$0")")/../chrome-src}"
[[ -f "$CHROME_SRC/stt.js" ]] || CHROME_SRC="$STT_ROOT/src"
CHROME_VER=154.0.8037.57
CHROME_MB=700
TONE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2"
TONE_SRC="sherpa-onnx-streaming-t-one-russian-2025-09-08"
TONE_MB=350
GIGA_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19.tar.bz2"
GIGA_SRC="sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19"
GIGA_MB=550
VOSK_URL="https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"
VOSK_SRC="vosk-model-small-ru-0.22"
VOSK_MB=250

case "$1" in
  tone)   MODEL=tone;   URL=$TONE_URL; SRC=$TONE_SRC; DST=$STT_ROOT/tone;   NEED_MB=$TONE_MB;  ARC=$SRC.tar.bz2 ;;
  gigaam) MODEL=gigaam; URL=$GIGA_URL; SRC=$GIGA_SRC; DST=$STT_ROOT/gigaam; NEED_MB=$GIGA_MB;  ARC=$SRC.tar.bz2 ;;
  vosk)   MODEL=vosk;   URL=$VOSK_URL; SRC=$VOSK_SRC; DST=$STT_ROOT/vosk;   NEED_MB=$VOSK_MB;  ARC=$SRC.zip ;;
  chrome) MODEL=chrome; URL=""; SRC=""; DST=$STT_ROOT/chrome; NEED_MB=$CHROME_MB; ARC="" ;;
  *) echo "unknown model: $1" >&2; exit 2 ;;
esac

is_present() {
  if [[ "$MODEL" == chrome ]]; then
    compgen -G "$DST/browsers/chrome/*/chrome-linux64/chrome" >/dev/null 2>&1 \
      && [[ -d "$DST/node_modules/puppeteer-core" && -f "$DST/stt.js" ]]
  elif [[ "$MODEL" == vosk ]]; then
    compgen -G "$DST/am" >/dev/null 2>&1 && compgen -G "$DST/graph" >/dev/null 2>&1
  else
    compgen -G "$DST/model*.onnx" >/dev/null 2>&1
  fi
}

install_chrome() {
  rm -rf "$DST"
  mkdir -p "$DST"
  cp "$CHROME_SRC/package.json" "$CHROME_SRC/package-lock.json" "$CHROME_SRC/stt.js" "$DST/"
  (cd "$DST" && npm ci --no-audit --no-fund --loglevel=error)
  (cd "$DST" && npx @puppeteer/browsers install "chrome@$CHROME_VER" --path "$DST/browsers")
  find "$DST/browsers" -name '*.zip' -delete 2>/dev/null || true
  npm cache clean --force >/dev/null 2>&1 || true
}

case "${2:-ensure}" in
  path)
    echo "$DST"; exit 0 ;;
  present)
    if is_present; then echo yes; else echo no; fi
    exit 0 ;;
  remove)
    rm -rf "$DST"
    if [[ -n "$ARC" ]]; then rm -f "$STT_ROOT/$ARC"; fi
    echo "removed: $DST"
    exit 0 ;;
  ensure)
    if is_present; then
      echo "already present: $DST"
      exit 0
    fi
    AVAIL_MB=$(df -m --output=avail / | tail -1 | tr -dc '0-9')
    if (( AVAIL_MB < NEED_MB )); then
      echo "not enough disk space: ${AVAIL_MB}MB free, need ~${NEED_MB}MB for $MODEL" >&2
      exit 1
    fi
    if [[ "$MODEL" == chrome ]]; then
      install_chrome
      echo "installed: $DST"
      exit 0
    fi
    rm -rf "$DST"
    if [[ -n "$ARC" ]]; then rm -f "$STT_ROOT/$ARC"; fi
    wget -q --show-progress -O "$STT_ROOT/$ARC" "$URL"
    case "$MODEL" in
      vosk) unzip -q -o "$STT_ROOT/$ARC" -d "$STT_ROOT" ;;
      *)    tar xjf "$STT_ROOT/$ARC" -C "$STT_ROOT" ;;
    esac
    rm -f "$STT_ROOT/$ARC"
    if [[ "$STT_ROOT/$SRC" != "$DST" ]]; then
      mv "$STT_ROOT/$SRC" "$DST"
    fi
    echo "installed: $DST"
    ;;
  *)
    echo "usage: ensure-model.sh <vosk|tone|gigaam|chrome> <ensure|remove|present|path>" >&2
    exit 2 ;;
esac
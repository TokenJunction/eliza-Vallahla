#!/bin/sh
# Rebuild the Valhalla demo films from the sample desk, Piper, and ffmpeg.
# Voice: Piper en_US-lessac-medium. LibriVox lessac is public domain. Piper is MIT.
# Music: this script writes an original bed and releases it CC0. See media/CREDITS.md.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WORK="${VALHALLA_WORK:-/tmp/valhalla-av}"
PIPER="${PIPER:-$WORK/piper/piper}"
MODEL="${PIPER_MODEL:-$WORK/en_US-lessac-medium.onnx}"
HERO="${VALHALLA_HERO:-/home/ubuntu/.cursor/projects/workspace/uploads/valhalla-hero-web_3d2a.mp4}"
FONT="${VALHALLA_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
LOGO="${VALHALLA_LOGO:-$ROOT/assets/mark-512.png}"
export LD_LIBRARY_PATH="$(dirname "$PIPER")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
mkdir -p "$WORK/lines" "$WORK/raw" "$ROOT/media" "$ROOT/assets"
python3 - <<PY
import math, struct, wave
path = "$WORK/music.wav"
sr = 22050
n = int(sr * 70)
# Original slow pad. A minor. Quiet on purpose so the voice can sit on top.
freqs = (110.0, 164.81, 220.0, 261.63)
with wave.open(path, "w") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(sr)
    frames = bytearray()
    for i in range(n):
        t = i / sr
        env = 0.045 * (0.65 + 0.35 * math.sin(2 * math.pi * 0.05 * t))
        sample = 0.0
        for index, freq in enumerate(freqs):
            sample += math.sin(2 * math.pi * freq * t) * (0.35 if index < 2 else 0.18)
        value = max(-1.0, min(1.0, sample * env))
        frames += struct.pack("<h", int(value * 32767))
    handle.writeframes(frames)
print("music", path)
PY
i=0
: > "$WORK/list.txt"
for line in \
  "This is Valhalla." \
  "Your trading desk, on your computer and on your phone." \
  "What you see is demo data. It is not a live account." \
  "Positions, profit and loss, and alerts stay in one view." \
  "The risk guard and the stops stay under your control." \
  "Pro opens the deeper desk tools. The phone and Telegram only report status." \
  "Valhalla is non-custodial. The app never sends, withdraws, or moves your funds." \
  "Keys stay on your device." \
  "Valhalla, by TokenJunction LLC. Download free at valhalla-app.xyz."
do
  printf '%s\n' "$line" | "$PIPER" --model "$MODEL" --length_scale 1.08 --output_file "$WORK/lines/$i.wav" >/dev/null
  printf "file '%s'\n" "$WORK/lines/$i.wav" >> "$WORK/list.txt"
  if [ "$i" -lt 8 ]; then
    ffmpeg -y -f lavfi -i anullsrc=r=22050:cl=mono -t 0.4 -q:a 9 "$WORK/lines/gap$i.wav" >/dev/null 2>&1
    printf "file '%s'\n" "$WORK/lines/gap$i.wav" >> "$WORK/list.txt"
  fi
  i=$((i + 1))
done
ffmpeg -y -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/voice.wav" >/dev/null 2>&1
VOICE_SEC="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/voice.wav")"
python3 - <<PY
voice = float("$VOICE_SEC")
intro, outro = 4.0, 6.0
# Hold the film in the 45 to 60 second range by padding the middle if needed.
target = max(voice + 1.5, 48.0)
target = min(target, 58.0)
middle = max(30.0, target - intro - outro)
open("$WORK/timing.txt","w").write(f"{middle:.3f} {target:.3f} {voice:.3f}\n")
print("voice", round(voice, 2), "middle", round(middle, 2), "target", round(target, 2))
PY
read MIDDLE TARGET VOICE < "$WORK/timing.txt"
# Captions follow the spoken lines. Times are measured from the wav parts.
python3 - <<PY
import wave, pathlib
lines = pathlib.Path("$WORK/lines")
texts = [
  "This is Valhalla.",
  "Your trading desk, on your computer and on your phone.",
  "What you see is demo data. It is not a live account.",
  "Positions, profit and loss, and alerts stay in one view.",
  "The risk guard and the stops stay under your control.",
  "Pro opens the deeper desk tools. The phone and Telegram only report status.",
  "Valhalla is non-custodial. The app never sends, withdraws, or moves your funds.",
  "Keys stay on your device.",
  "Valhalla, by TokenJunction LLC. Download free at valhalla-app.xyz.",
]
def dur(path):
    with wave.open(str(path)) as handle:
        return handle.getnframes() / handle.getframerate()
def ts(seconds):
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cursor = 0.0
rows = []
for index, text in enumerate(texts):
    length = dur(lines / f"{index}.wav")
    rows.append((cursor, cursor + length, text))
    cursor += length
    gap = lines / f"gap{index}.wav"
    if gap.exists():
        cursor += dur(gap)
srt = []
vtt = ["WEBVTT", ""]
for n, (a, b, text) in enumerate(rows, 1):
    srt.append(f"{n}\n{ts(a)} --> {ts(b)}\n{text}\n")
    vtt.append(f"{ts(a).replace(',', '.')} --> {ts(b).replace(',', '.')}\n{text}\n")
pathlib.Path("$ROOT/media/captions.srt").write_text("\n".join(srt))
pathlib.Path("$ROOT/media/captions.vtt").write_text("\n".join(vtt))
print("captions", round(cursor, 2))
PY
rm -rf "$WORK/raw-wide" "$WORK/raw-story"
mkdir -p "$WORK/raw-wide" "$WORK/raw-story"
NODE_PATH="${NODE_PATH:-/tmp/pw/node_modules}" node "$ROOT/scripts/record-demo.mjs" "$WORK/raw-wide" "$(python3 -c "print(int(float('$MIDDLE')*1000))")" wide
NODE_PATH="${NODE_PATH:-/tmp/pw/node_modules}" node "$ROOT/scripts/record-demo.mjs" "$WORK/raw-story" "$(python3 -c "print(int(float('$MIDDLE')*1000))")" story
WIDE="$(find "$WORK/raw-wide" -name '*.webm' | head -1)"
STORY="$(find "$WORK/raw-story" -name '*.webm' | head -1)"
# Intro and outro reuse the supplied hero clip. The middle is the recorded GUI.
ffmpeg -y -ss 0 -t 4 -i "$HERO" -i "$LOGO" -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p[bg];[1:v]scale=280:-1[mark];[bg][mark]overlay=(W-w)/2:(H-h)/2-20" -an "$WORK/intro.mp4"
ffmpeg -y -ss 2 -t 6 -i "$HERO" -i "$LOGO" -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p[bg];[1:v]scale=240:-1[mark];[bg][mark]overlay=(W-w)/2:(H-h)/2-70,drawtext=fontfile=$FONT:text='VALHALLA':fontsize=54:fontcolor=0xE8B65A:x=(w-text_w)/2:y=(h/2)+90,drawtext=fontfile=$FONT:text='by TokenJunction LLC':fontsize=24:fontcolor=0xE7EEF8:x=(w-text_w)/2:y=(h/2)+150" -an "$WORK/outro.mp4"
ffmpeg -y -i "$WIDE" -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p[v]" -map "[v]" -an "$WORK/gui.mp4"
ffmpeg -y -i "$STORY" -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p[v]" -map "[v]" -an "$WORK/gui-story.mp4"
ffmpeg -y -ss 0 -t 4 -i "$HERO" -i "$LOGO" -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p[bg];[1:v]scale=420:-1[mark];[bg][mark]overlay=(W-w)/2:(H-h)/2" -an "$WORK/intro-story.mp4"
ffmpeg -y -ss 2 -t 6 -i "$HERO" -i "$LOGO" -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p[bg];[1:v]scale=360:-1[mark];[bg][mark]overlay=(W-w)/2:(H-h)/2-80,drawtext=fontfile=$FONT:text='VALHALLA':fontsize=48:fontcolor=0xE8B65A:x=(w-text_w)/2:y=(h/2)+140,drawtext=fontfile=$FONT:text='TokenJunction LLC':fontsize=22:fontcolor=0xE7EEF8:x=(w-text_w)/2:y=(h/2)+196" -an "$WORK/outro-story.mp4"
cat > "$WORK/concat.txt" <<EOF
file '$WORK/intro.mp4'
file '$WORK/gui.mp4'
file '$WORK/outro.mp4'
EOF
cat > "$WORK/concat-story.txt" <<EOF
file '$WORK/intro-story.mp4'
file '$WORK/gui-story.mp4'
file '$WORK/outro-story.mp4'
EOF
ffmpeg -y -f concat -safe 0 -i "$WORK/concat.txt" -c:v libx264 -pix_fmt yuv420p -an "$WORK/picture.mp4"
ffmpeg -y -f concat -safe 0 -i "$WORK/concat-story.txt" -c:v libx264 -pix_fmt yuv420p -an "$WORK/picture-story.mp4"
# Shift captions by the 4 second intro.
python3 - <<PY
from pathlib import Path
raw = Path("$ROOT/media/captions.srt").read_text().strip().split("\n\n")
def shift(stamp):
    h, m, rest = stamp.split(":")
    s, ms = rest.split(",")
    total = int(h)*3600000 + int(m)*60000 + int(s)*1000 + int(ms) + 4000
    hh, total = divmod(total, 3600000)
    mm, total = divmod(total, 60000)
    ss, mss = divmod(total, 1000)
    return f"{hh:02d}:{mm:02d}:{ss:02d},{mss:03d}"
out = []
for block in raw:
    lines = block.splitlines()
    a, b = lines[1].split(" --> ")
    lines[1] = f"{shift(a)} --> {shift(b)}"
    out.append("\n".join(lines))
Path("$ROOT/media/captions.srt").write_text("\n\n".join(out) + "\n")
vtt = ["WEBVTT", ""]
for block in out:
    lines = block.splitlines()
    vtt.append(lines[1].replace(",", "."))
    vtt.append(lines[2])
    vtt.append("")
Path("$ROOT/media/captions.vtt").write_text("\n".join(vtt))
PY
STYLE="FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00F8EEE7,OutlineColour=&H00181107,BorderStyle=3,Outline=1,Shadow=0,MarginV=48"
ffmpeg -y -i "$WORK/picture.mp4" -i "$WORK/voice.wav" -i "$WORK/music.wav" -filter_complex "[2:a]volume=0.22[bed];[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a];[0:v]subtitles=$ROOT/media/captions.srt:force_style='$STYLE'[v]" -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -crf 28 -preset veryfast -c:a aac -b:a 128k -movflags +faststart -shortest "$ROOT/media/valhalla-demo.mp4"
STYLE9="FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00F8EEE7,OutlineColour=&H00181107,BorderStyle=3,Outline=1,Shadow=0,MarginV=80"
ffmpeg -y -i "$WORK/picture-story.mp4" -i "$WORK/voice.wav" -i "$WORK/music.wav" -filter_complex "[2:a]volume=0.22[bed];[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a];[0:v]subtitles=$ROOT/media/captions.srt:force_style='$STYLE9'[v]" -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -crf 30 -preset veryfast -c:a aac -b:a 96k -movflags +faststart -shortest "$ROOT/media/valhalla-demo-story.mp4"
ls -lh "$ROOT/media/valhalla-demo.mp4" "$ROOT/media/valhalla-demo-story.mp4"
ffprobe -hide_banner "$ROOT/media/valhalla-demo.mp4" 2>&1 | head -12

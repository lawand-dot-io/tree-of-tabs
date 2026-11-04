"""The Short's music: a calm lo-fi loop, made from scratch (so nothing can claim
it), exactly as long as the video so the two loop together. 12 bars of 4/4 in
F major, Fmaj7 | Em7 | Dm7 | Cmaj7 three times, with a soft electric piano, bass,
a pad, a swung beat, a sparse melody from the second time round, and faint vinyl
crackle. Notes that ring past the end wrap into the start, so the loop has no
seam. Needs numpy and scipy. render_short.py runs it; to run it alone:
Usage: python3 tools/demo/music.py <seconds> <out.wav>"""
import sys
import wave
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
LENGTH = float(sys.argv[1])
OUT = sys.argv[2]
BARS = 12
BEAT = LENGTH / (BARS * 4)
N = int(round(LENGTH * SR))
TAIL = int(4 * SR)
rng = np.random.default_rng(7)


def buf():
    return np.zeros(N + TAIL)


def at(beat):
    return int(round(beat * BEAT * SR))


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def lowpass(x, f, order=2):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)


def highpass(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def add(track, start, sound):
    end = min(len(track), start + len(sound))
    track[start:end] += sound[:end - start]


# --- Instruments --------------------------------------------------------------------

def epiano(note, seconds, velocity):
    """A soft electric piano: FM with a decaying index and a little bell on the attack."""
    t = np.arange(int(seconds * SR)) / SR
    f = midi(note) * (1 + rng.normal(0, 0.0007))
    index = 1.6 * np.exp(-t * 3.5) + 0.25
    tone = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    bell = 0.12 * np.sin(2 * np.pi * f * 7.0 * t) * np.exp(-t * 18)
    env = np.minimum(1, t / 0.006) * np.exp(-t * 1.25)
    release = np.minimum(1, (seconds - t) / 0.08)
    return velocity * (tone + bell) * env * release


def bass(note, seconds, velocity):
    t = np.arange(int(seconds * SR)) / SR
    f = midi(note)
    tone = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    env = np.minimum(1, t / 0.01) * np.exp(-t * 1.6) * np.minimum(1, (seconds - t) / 0.06)
    return velocity * tone * env


def pad(notes, seconds):
    t = np.arange(int(seconds * SR)) / SR
    out = np.zeros_like(t)
    for n in notes:
        for detune in (-0.12, 0.0, 0.12):
            f = midi(n) * 2 ** (detune / 12)
            phase = rng.uniform(0, 1)
            out += 2 * ((f * t + phase) % 1) - 1  # A saw.
    out = lowpass(out, 700, 4)
    env = np.minimum(1, t / 0.6) * np.minimum(1, (seconds - t) / 0.6)
    return out * env / (len(notes) * 3)


def kick(velocity):
    t = np.arange(int(0.45 * SR)) / SR
    f = 45 + 75 * np.exp(-t * 28)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return velocity * np.sin(phase) * np.exp(-t * 7.5)


def snare(velocity):
    t = np.arange(int(0.3 * SR)) / SR
    noise = highpass(lowpass(rng.normal(0, 1, len(t)), 5000), 900) * np.exp(-t * 16)
    body = 0.5 * np.sin(2 * np.pi * 185 * t) * np.exp(-t * 25)
    return velocity * (0.6 * noise + body)


def hat(velocity):
    t = np.arange(int(0.06 * SR)) / SR
    return velocity * highpass(rng.normal(0, 1, len(t)), 7000, 4) * np.exp(-t * 70)


# --- The song ------------------------------------------------------------------------------

CHORDS = [  # (bass root, voicing) for Fmaj7, Em7, Dm7, Cmaj7
    (41, [57, 60, 64, 67]),  # Fmaj7: A C E G
    (40, [55, 59, 62, 64]),  # Em7: G B D E
    (38, [57, 60, 62, 65]),  # Dm7: A C D F
    (36, [55, 59, 62, 64]),  # Cmaj7: G B D E
]

keys, low, pads, drums, lead = buf(), buf(), buf(), buf(), buf()
SWING = 0.09  # Late off-beat eighths, in beats.

for bar in range(BARS):
    root, voicing = CHORDS[bar % 4]
    b0 = bar * 4
    # Keys: on beat 1, and a lighter stab on the "and" of 2.
    for beat, vel, length in ((0, 0.55, 2.4), (1.5 + SWING, 0.32, 1.6), (3.5 + SWING, 0.22, 1.2)):
        if beat == 3.5 + SWING and bar % 2 == 0:
            continue
        for i, n in enumerate(voicing):
            v = vel * rng.uniform(0.85, 1.05)
            add(keys, at(b0 + beat) + i * int(0.012 * SR), epiano(n, length * BEAT, v))
    # Bass: root on 1, fifth or root on the "and" of 3.
    add(low, at(b0), bass(root, 1.9 * BEAT, 0.9))
    add(low, at(b0 + 2.5 + SWING), bass(root + (7 if bar % 2 else 12), 1.2 * BEAT, 0.6))
    # Pad: the chord, held and very soft.
    add(pads, at(b0), pad(voicing, 4 * BEAT + 0.3))
    # Drums.
    add(drums, at(b0), kick(1.0))
    add(drums, at(b0 + 2.5 + SWING), kick(0.6))
    if bar % 4 == 3:
        add(drums, at(b0 + 3.5 + SWING), kick(0.45))
    for beat in (1, 3):
        add(drums, at(b0 + beat), snare(0.42))
    for eighth in range(8):
        beat = eighth / 2 + (SWING if eighth % 2 else 0)
        add(drums, at(b0 + beat), hat(0.10 if eighth % 2 else 0.16))

# A sparse melody in the second and third times round, on chord tones.
MELODY = [  # (bar, beat, note, beats)
    (4, 0.5, 72, 1.5), (4, 2.5, 76, 1.5), (5, 1.0, 74, 2.5),
    (6, 0.5, 72, 1.0), (6, 2.0, 69, 1.5), (7, 1.0, 71, 2.8),
    (8, 0.5, 76, 1.0), (8, 2.0, 77, 1.0), (8, 3.0, 76, 1.5), (9, 1.0, 74, 2.5),
    (10, 0.5, 72, 1.0), (10, 2.0, 74, 1.5), (11, 0.0, 72, 3.5),
]
for bar, beat, note, beats in MELODY:
    add(lead, at(bar * 4 + beat), epiano(note, beats * BEAT + 0.4, 0.42))

# --- Mix ---------------------------------------------------------------------------------

def reverb(x, seconds=2.2, wet=0.25):
    t = np.arange(int(seconds * SR)) / SR
    ir = rng.normal(0, 1, len(t)) * np.exp(-t * 3.2)
    ir = lowpass(ir, 4000)
    ir /= np.sqrt(np.sum(ir ** 2))
    return x + wet * fftconvolve(x, ir)[:len(x)]


# Gentle sidechain: the music ducks a little under each kick.
duck = np.ones(N + TAIL)
for bar in range(BARS):
    for beat in (0, 2.5 + SWING):
        s = at(bar * 4 + beat)
        t = np.arange(int(0.35 * SR)) / SR
        add(duck, s, -0.35 * np.exp(-t * 9))

mix = (0.30 * reverb(keys) * duck + 0.30 * reverb(lead, wet=0.35) * duck + 0.55 * lowpass(low, 400) * duck
       + 0.22 * reverb(pads, wet=0.4) * duck + 0.55 * drums)
mix = lowpass(mix, 7500)  # Lo-fi: a soft top end.
# Vinyl: faint hiss and the odd crackle.
hiss = lowpass(highpass(rng.normal(0, 1, len(mix)), 1500), 6000) * 0.004
crackle = np.zeros(len(mix))
for p in rng.integers(0, len(mix), 220):
    crackle[p] = rng.uniform(-1, 1) * 0.08
mix += hiss + lowpass(crackle, 3000)

# Wrap the tail into the start, so the loop is seamless.
loop = mix[:N].copy()
loop[:TAIL] += mix[N:]
loop = np.tanh(loop * 1.2)
loop /= np.max(np.abs(loop)) / 0.89
stereo = np.stack([loop, np.roll(loop, int(0.0004 * SR))], axis=1)
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype('<i2').tobytes())
print(f'{OUT}: {60 / BEAT:.1f} BPM')

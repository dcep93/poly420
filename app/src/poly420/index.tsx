import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import recorded_sha from "./recorded_sha";
import "./styles.css";

type Track = {
  id: string;
  beatsPerCycle: number;
  pitchIndex: number;
  volume: number;
  muted: boolean;
  deafened: boolean;
};

const PITCHES = [392, 494, 587, 440, 659, 784, 523, 698];

const DEFAULT_TEMPO = 30;
const DEFAULT_VOLUME = 0.75;
const DEFAULT_TRACKS: Track[] = [
  {
    id: "track-1",
    beatsPerCycle: 4,
    volume: DEFAULT_VOLUME,
    muted: false,
    deafened: false,
    pitchIndex: 0,
  },
  {
    id: "track-2",
    beatsPerCycle: 3,
    volume: DEFAULT_VOLUME,
    muted: false,
    deafened: false,
    pitchIndex: 1,
  },
];

const clampTempo = (tempo: number) =>
  Math.min(240, Math.max(1, Math.round(tempo)));
let trackCounter = DEFAULT_TRACKS.length + 1;

function isIOSChromeLikeWebView() {
  const ua = navigator.userAgent || "";
  const isIOS =
    /iP(hone|od|ad)/.test(ua) ||
    (ua.includes("Mac") && (navigator as any).maxTouchPoints > 1);
  // On iOS, all browsers are WebKit/WKWebView. Chrome/Edge/Brave include "CriOS"/"EdgiOS".
  const isChromeiOS = /CriOS|EdgiOS|Brave/i.test(ua);
  return isIOS && isChromeiOS;
}

// iOS Chrome (WKWebView) can report AudioContext "running" yet output nothing;
// we "prime" the HTMLMediaElement path inside a trusted gesture, then run WebAudio for precision.
function makeWavDataUri({
  freq,
  durationSec,
  sampleRate,
  volume,
  type,
}: {
  freq: number;
  durationSec: number;
  sampleRate: number;
  volume: number;
  type: "sine" | "square";
}) {
  const n = Math.max(1, Math.floor(sampleRate * durationSec));
  const pcm = new Int16Array(n);

  const fadeN = Math.min(Math.floor(sampleRate * 0.006), Math.floor(n / 2));

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let amp = volume;

    if (i < fadeN) amp *= i / fadeN;
    else if (i > n - fadeN) amp *= (n - i) / fadeN;

    const s =
      type === "square"
        ? Math.sin(2 * Math.PI * freq * t) >= 0
          ? 1
          : -1
        : Math.sin(2 * Math.PI * freq * t);

    const v = Math.max(-1, Math.min(1, s * amp));
    pcm[i] = (v * 0x7fff) | 0;
  }

  const bytesPerSample = 2;
  const blockAlign = 1 * bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = n * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < n; i++, o += 2) view.setInt16(o, pcm[i], true);

  const u8 = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  const b64 = btoa(bin);
  return `data:audio/wav;base64,${b64}`;
}

function scheduleClickWebAudio(
  ctx: AudioContext,
  time: number,
  frequency: number,
  accent: boolean,
  density: number,
  volume: number
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  const accentBoost = accent ? 0.35 : 0.15;
  const smoothness = Math.tanh(0.6 + density * 0.1);
  const peak = Math.min(0.6, (0.18 + accentBoost) * smoothness) * volume;

  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.002, time + 0.003);
  gain.gain.linearRampToValueAtTime(peak, time + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);

  osc.frequency.setValueAtTime(frequency, time);
  osc.type = accent ? "square" : "sine";

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(time);
  osc.stop(time + 0.35);
}

function tracksMatchDefault(tracks: Track[]) {
  if (tracks.length !== DEFAULT_TRACKS.length) return false;
  return tracks.every((track, index) => {
    const baseline = DEFAULT_TRACKS[index];
    return (
      track.beatsPerCycle === baseline.beatsPerCycle &&
      track.volume === baseline.volume &&
      track.muted === baseline.muted &&
      track.deafened === baseline.deafened
    );
  });
}

function applyPitchOrder(tracks: Track[]) {
  return tracks.map((track, index) => ({
    ...track,
    pitchIndex: index % PITCHES.length,
  }));
}

function encodeState(tempo: number, tracks: Track[], darkMode: boolean) {
  const pieces: string[] = [];

  if (!darkMode) {
    pieces.push("theme=light");
  }

  if (tempo !== DEFAULT_TEMPO) {
    pieces.push(`t=${tempo}`);
  }

  if (!tracksMatchDefault(tracks)) {
    const trackStrings = tracks
      .map((track) => {
        const volumePercent = Math.round(track.volume * 100);
        const volumeFlag =
          volumePercent !== Math.round(DEFAULT_VOLUME * 100)
            ? `v${volumePercent}`
            : "";
        const muteFlag = track.muted ? "m" : "";
        const deafFlag = track.deafened ? "d" : "";
        return `${track.beatsPerCycle}${volumeFlag}${muteFlag}${deafFlag}`;
      })
      .join("|");

    pieces.push(`tracks=${trackStrings}`);
  }

  if (pieces.length === 0) {
    return "";
  }

  return `#${pieces.join(";")}`;
}

function parseState(
  hash: string
): { tempo: number; tracks: Track[]; darkMode: boolean } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw)
    return { tempo: DEFAULT_TEMPO, tracks: DEFAULT_TRACKS, darkMode: true };

  const parts = raw.split(";");
  let tempo = DEFAULT_TEMPO;
  let tracksPart: string | null = null;
  let darkMode = true;

  parts.forEach((part) => {
    if (part.startsWith("t=")) {
      tempo = clampTempo(Number(part.slice(2)) || DEFAULT_TEMPO);
    } else if (part.startsWith("theme=")) {
      const themeValue = part.slice("theme=".length);
      if (themeValue === "dark") {
        darkMode = true;
      } else if (themeValue === "light") {
        darkMode = false;
      }
    } else if (part.startsWith("tracks=")) {
      tracksPart = part.slice("tracks=".length);
    }
  });

  if (!tracksPart) {
    trackCounter = DEFAULT_TRACKS.length + 1;
    return { tempo, tracks: DEFAULT_TRACKS, darkMode };
  }

  const rawTracks: string = tracksPart;

  const trackPieces = applyPitchOrder(
    rawTracks
      .split("|")
      .map((piece: string, index: number) => {
        const match = piece.match(/^(\d+)(v(\d+))?(m)?(d)?$/);
        if (!match) return null;
        const [, beats, , volRaw, muteFlag, deafFlag] = match;
        const beatsPerCycle = Number(beats);
        if (!Number.isFinite(beatsPerCycle) || beatsPerCycle < 1) {
          return null;
        }
        const volumePercent = volRaw
          ? Number(volRaw)
          : Math.round(DEFAULT_VOLUME * 100);
        const volume = Math.min(1, Math.max(0, volumePercent / 100));
        return {
          id: `track-${index + 1}`,
          beatsPerCycle: Math.max(1, Math.round(beatsPerCycle)),
          pitchIndex: index % PITCHES.length,
          volume,
          muted: Boolean(muteFlag),
          deafened: Boolean(deafFlag),
        } satisfies Track;
      })
      .filter(Boolean) as Track[]
  );

  if (trackPieces.length === 0) {
    return null;
  }

  trackCounter = trackPieces.length + 1;
  return { tempo, tracks: trackPieces, darkMode };
}

export default function Poly420() {
  const initial = parseState(window.location.hash);
  const [darkMode, setDarkMode] = useState(initial?.darkMode ?? true);
  const [playing, setPlaying] = useState(false);
  const [tempo, setTempo] = useState(initial?.tempo ?? DEFAULT_TEMPO);
  const [tracks, setTracks] = useState<Track[]>(
    applyPitchOrder(initial?.tracks ?? DEFAULT_TRACKS)
  );
  const [snapBeats, setSnapBeats] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const keepAliveRef = useRef<OscillatorNode | null>(null);

  // WebAudio timing
  const startTimeRef = useRef(0);
  const nextCycleRef = useRef(0);

  const prevCycleProgressRef = useRef(0);
  const lastCssProgressRef = useRef(-1);

  // <audio> pool ONLY for priming iOS Chrome media stack
  type PoolAudio = HTMLAudioElement & { __poly420SampleKey?: string };

  const audioPoolRef = useRef<PoolAudio[]>([]);
  const samplesRef = useRef<Map<string, string>>(new Map());
  const didPrimeMediaRef = useRef(false);

  // Precision mode: ALWAYS use WebAudio scheduling/playback.
  const useHtmlAudioEngine = false;

  const cycleDuration = useMemo(() => 60 / tempo, [tempo]);

  const audibleTracks = useMemo(() => {
    const focused = tracks.filter((track) => track.deafened);
    const base = focused.length > 0 ? focused : tracks;
    return base.filter((track) => !track.muted);
  }, [tracks]);

  const setCycleProgressCss = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    if (Math.abs(clamped - lastCssProgressRef.current) < 0.0004) return;
    document.documentElement.style.setProperty(
      "--cycle-progress",
      clamped.toString()
    );
    lastCssProgressRef.current = clamped;
  }, []);

  const ensureAudioRunning = useCallback(async () => {
    let ctx = audioContextRef.current;
    const AudioCtor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    if (!ctx || ctx.state === "closed") {
      // latencyHint reduces buffering, helps responsiveness/precision feel
      ctx = new AudioCtor({
        latencyHint: "interactive",
      } as AudioContextOptions);
      audioContextRef.current = ctx;
    }

    if (ctx.state !== "running") {
      await ctx.resume().catch(() => {});
    }

    // Keep the audio graph alive (some iOS/WKWebView cases behave better)
    if (!keepAliveRef.current && ctx.state === "running") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // silent
      osc.frequency.value = 30;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      keepAliveRef.current = osc;
    }

    return ctx;
  }, []);

  const resetAudioContext = useCallback(() => {
    const existingContext = audioContextRef.current;

    try {
      keepAliveRef.current?.stop();
    } catch {}
    keepAliveRef.current = null;

    if (existingContext && existingContext.state !== "closed") {
      existingContext.close().catch(() => {});
    }
    audioContextRef.current = null;
    startTimeRef.current = 0;
    nextCycleRef.current = 0;
  }, []);

  const ensureAudioPool = useCallback(() => {
    if (audioPoolRef.current.length > 0) return;

    const POOL = 8; // only needed for priming; keep it small
    const pool: PoolAudio[] = [];
    for (let i = 0; i < POOL; i++) {
      const a = new Audio();
      a.preload = "auto";
      (a as any).playsInline = true;
      pool.push(a);
    }
    audioPoolRef.current = pool;
  }, []);

  const getSampleUri = useCallback((freq: number, accent: boolean) => {
    const key = `${freq}:${accent ? "a" : "n"}`;
    const hit = samplesRef.current.get(key);
    if (hit) return hit;

    const uri = makeWavDataUri({
      freq,
      durationSec: accent ? 0.06 : 0.045, // short + snappy (only for priming)
      sampleRate: 44100,
      volume: accent ? 0.95 : 0.7,
      type: accent ? "square" : "sine",
    });

    samplesRef.current.set(key, uri);
    return uri;
  }, []);

  const primeMediaOnce = useCallback(async () => {
    if (didPrimeMediaRef.current) return;
    ensureAudioPool();

    const pool = audioPoolRef.current;
    const a = pool[0];
    a.src = getSampleUri(440, false);
    a.volume = 0;

    try {
      a.currentTime = 0;
    } catch {}
    try {
      await a.play();
      a.pause();
      try {
        a.currentTime = 0;
      } catch {}
      didPrimeMediaRef.current = true;
    } catch {
      // If even this fails, you're not in a trusted gesture.
    } finally {
      a.volume = 1;
    }
  }, [ensureAudioPool, getSampleUri]);

  useEffect(() => {
    const hash = encodeState(tempo, tracks, darkMode);
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", `${base}${hash}`);
  }, [tempo, tracks, darkMode]);

  useEffect(() => {
    document.body.classList.toggle("poly420-dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    let interval: number | null = null;
    let cancelled = false;

    const setup = async () => {
      if (!playing) return;

      // WebAudio scheduler (precision)
      const ctx =
        audioContextRef.current && audioContextRef.current.state !== "closed"
          ? audioContextRef.current
          : await ensureAudioRunning();

      if (cancelled) return;

      const startAt = ctx.currentTime + 0.05;
      startTimeRef.current = startAt;
      nextCycleRef.current = 0;

      const scheduleAhead = 0.7;

      const schedule = () => {
        const until = ctx.currentTime + scheduleAhead;
        while (
          startTimeRef.current + nextCycleRef.current * cycleDuration <
          until
        ) {
          const cycleStart =
            startTimeRef.current + nextCycleRef.current * cycleDuration;
          audibleTracks.forEach((track) => {
            const frequency = PITCHES[track.pitchIndex % PITCHES.length];
            for (let beat = 0; beat < track.beatsPerCycle; beat += 1) {
              const beatMoment =
                cycleStart + (cycleDuration * beat) / track.beatsPerCycle;
              scheduleClickWebAudio(
                ctx,
                beatMoment,
                frequency,
                beat === 0,
                track.beatsPerCycle,
                track.volume
              );
            }
          });
          nextCycleRef.current += 1;
        }
      };

      interval = window.setInterval(schedule, 25);
    };

    void setup();

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
      resetAudioContext();
    };
  }, [
    playing,
    cycleDuration,
    audibleTracks,
    ensureAudioRunning,
    resetAudioContext,
  ]);

  useEffect(() => {
    let frame: number | null = null;

    const update = () => {
      if (!playing) {
        setCycleProgressCss(0);
        frame = null;
        return;
      }

      const ctx = audioContextRef.current;
      if (!ctx) {
        setCycleProgressCss(0);
        frame = requestAnimationFrame(update);
        return;
      }

      const elapsed = Math.max(0, ctx.currentTime - startTimeRef.current);
      const position =
        cycleDuration > 0 ? (elapsed % cycleDuration) / cycleDuration : 0;
      setCycleProgressCss(position);
      frame = requestAnimationFrame(update);
    };

    if (playing) {
      frame = requestAnimationFrame(update);
    } else {
      setCycleProgressCss(0);
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [playing, cycleDuration, setCycleProgressCss]);

  useEffect(() => {
    const prev = prevCycleProgressRef.current;
    const current = lastCssProgressRef.current;
    const wrapped = playing && current < prev;
    prevCycleProgressRef.current = current;

    if (wrapped) {
      setSnapBeats(true);
      const handle = requestAnimationFrame(() => setSnapBeats(false));
      return () => cancelAnimationFrame(handle);
    }

    if (!playing) setSnapBeats(false);
  }, [playing]);

  const togglePlay = async () => {
    if (playing) {
      setPlaying(false);
      resetAudioContext();
      return;
    }

    // Prime iOS Chrome-like WebViews inside the gesture, but still run WebAudio for precision.
    if (isIOSChromeLikeWebView()) {
      await primeMediaOnce();
    }

    const existingContext = audioContextRef.current;
    const beforeState = existingContext?.state ?? "none";
    const ctx = await ensureAudioRunning();
    const afterState = ctx.state;
    console.log(
      `[poly420] Play tap resume state: ${beforeState} -> ${afterState}`
    );

    setPlaying(true);
  };

  const updateTempo = (next: number) => {
    setTempo(clampTempo(next));
  };

  const addTrack = () => {
    const pitchIndex = tracks.length % PITCHES.length;
    const newTrack: Track = {
      id: `track-${trackCounter++}`,
      beatsPerCycle: 2,
      pitchIndex,
      volume: DEFAULT_VOLUME,
      muted: false,
      deafened: false,
    };
    setTracks((prev) => applyPitchOrder([...prev, newTrack]));
  };

  const removeTrack = (id: string) => {
    setTracks((prev) =>
      applyPitchOrder(prev.filter((track) => track.id !== id))
    );
  };

  const updateTrackBeats = (id: string, beats: number) => {
    const safeBeats = Math.max(1, Math.round(beats));
    setTracks((prev) =>
      applyPitchOrder(
        prev.map((track) =>
          track.id === id ? { ...track, beatsPerCycle: safeBeats } : track
        )
      )
    );
  };

  const updateTrackVolume = (id: string, volume: number) => {
    const safeVolume = Math.min(1, Math.max(0, volume));
    setTracks((prev) =>
      applyPitchOrder(
        prev.map((track) =>
          track.id === id ? { ...track, volume: safeVolume } : track
        )
      )
    );
  };

  const toggleMute = (id: string) => {
    setTracks((prev) =>
      applyPitchOrder(
        prev.map((track) =>
          track.id === id
            ? { ...track, muted: !track.muted, deafened: false }
            : track
        )
      )
    );
  };

  const toggleDeafen = (id: string) => {
    setTracks((prev) =>
      applyPitchOrder(
        prev.map((track) =>
          track.id === id
            ? { ...track, deafened: !track.deafened, muted: false }
            : track
        )
      )
    );
  };

  return (
    <div className={`poly420-shell ${darkMode ? "dark" : ""}`}>
      <div className="page">
        <div className="top-row">
          <div className="hero">
            <h1 title={recorded_sha}>🥁 Poly420 🥁</h1>
          </div>
        </div>

        <div className="surface">
          <div className="transport">
            <button
              className={`play-toggle ${playing ? "active" : ""}`}
              onClick={togglePlay}
              aria-label="Play or stop"
            >
              <span className="play-icon" aria-hidden="true">
                {playing ? "⏹" : "▶"}
              </span>
            </button>

            <div className="tempo" aria-label="Tempo">
              <div className="tempo-row">
                <input
                  id="tempo-input"
                  type="number"
                  min={1}
                  max={120}
                  inputMode="decimal"
                  pattern="[0-9]*"
                  value={tempo}
                  onFocus={(event) => event.target.showPicker?.()}
                  onChange={(event) => updateTempo(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="transport-side">
              <button
                onClick={addTrack}
                className="ghost round"
                aria-label="Add track"
              >
                <span className="add-icon" aria-hidden="true">
                  +
                </span>
              </button>

              <button
                className="icon-button"
                onClick={() => setDarkMode((prev) => !prev)}
                aria-label="Toggle theme"
              >
                {darkMode ? "🌙" : "🌞"}
              </button>
            </div>
          </div>

          <div className="tracks">
            {tracks.map((track) => {
              return (
                <div key={track.id} className="track-card">
                  <div className="control-column">
                    <div className="control-row tight">
                      <div className="beat-control">
                        <label
                          className="sr-only"
                          htmlFor={`${track.id}-beats`}
                        >
                          Cycle
                        </label>
                        <input
                          id={`${track.id}-beats`}
                          type="number"
                          min={1}
                          max={64}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={track.beatsPerCycle}
                          onFocus={(event) => event.target.showPicker?.()}
                          onChange={(event) =>
                            updateTrackBeats(
                              track.id,
                              Number(event.target.value)
                            )
                          }
                        />
                        <div className="beat-visualization" aria-hidden="true">
                          {Array.from({ length: track.beatsPerCycle }).map(
                            (_, index) => (
                              <div
                                key={index}
                                className={`beat-segment ${
                                  snapBeats ? "snap" : ""
                                }`}
                                style={{
                                  ["--index" as any]: index.toString(),
                                  ["--beats" as any]: track.beatsPerCycle.toString(),
                                }}
                              />
                            )
                          )}
                        </div>
                      </div>

                      <button
                        className="chip danger"
                        onClick={() => removeTrack(track.id)}
                        aria-label="Remove track"
                      >
                        🗑️
                      </button>
                    </div>

                    <div className="control-row">
                      <button
                        className={`chip ${track.muted ? "active" : ""}`}
                        onClick={() => toggleMute(track.id)}
                        aria-label={track.muted ? "Unmute" : "Mute"}
                      >
                        {track.muted ? "🔇" : "🔈"}
                      </button>

                      <div className="slider-wrap">
                        <label
                          className="sr-only"
                          htmlFor={`${track.id}-volume`}
                        >
                          Level
                        </label>
                        <input
                          id={`${track.id}-volume`}
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={track.volume}
                          onChange={(event) =>
                            updateTrackVolume(
                              track.id,
                              Number(event.target.value)
                            )
                          }
                        />
                      </div>

                      <button
                        className={`chip ${track.deafened ? "active" : ""}`}
                        onClick={() => toggleDeafen(track.id)}
                        aria-label={track.deafened ? "Unfocus" : "Focus"}
                      >
                        📣
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              opacity: 0.5,
              fontFamily: "monospace",
              fontSize: 12,
              padding: "10px 2px",
            }}
          >
            engine: {useHtmlAudioEngine ? "html-audio" : "webaudio (precision)"}
          </div>
        </div>
      </div>
    </div>
  );
}

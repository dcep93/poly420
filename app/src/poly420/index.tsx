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
  type: "sine" | "square" | "triangle";
}) {
  const n = Math.max(1, Math.floor(sampleRate * durationSec));
  const pcm = new Int16Array(n);

  const fadeN = Math.min(Math.floor(sampleRate * 0.0045), Math.floor(n / 2));

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
  trackGain: GainNode | null
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  const accentBoost = accent ? 0.6 : 0.28;
  const smoothness = Math.tanh(0.72 + density * 0.13);
  const peak = Math.min(1.05, (0.32 + accentBoost) * smoothness);

  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.004, time + 0.0025);
  gain.gain.linearRampToValueAtTime(peak, time + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.00015, time + 0.3);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(accent ? 6400 : 5200, time);
  filter.Q.setValueAtTime(0.0002, time);

  osc.frequency.setValueAtTime(frequency, time);
  osc.type = accent ? "triangle" : "sine";

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(trackGain ?? ctx.destination);

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
  const transportAnchorRef = useRef<number | null>(null);
  const trackGainsRef = useRef<Map<string, GainNode>>(new Map());

  // Timing
  const startTimeRef = useRef(0);
  const nextCycleRef = useRef(0);
  const scheduledUntilRef = useRef(0);

  // Live refs to avoid tearing down audio on every UI change
  const cycleDurationRef = useRef(60 / (initial?.tempo ?? DEFAULT_TEMPO));
  const audibleTracksRef = useRef<Track[]>([]);
  const restartTransportRef = useRef(false);

  const lastCssProgressRef = useRef(-1);
  const snapResetHandleRef = useRef<number | null>(null);
  const playingRef = useRef(playing);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    return () => {
      if (snapResetHandleRef.current !== null) {
        cancelAnimationFrame(snapResetHandleRef.current);
      }
      // On unmount only: close audio
      void (async () => {
        try {
          keepAliveRef.current?.stop();
        } catch {}
        keepAliveRef.current = null;

        const ctx = audioContextRef.current;
        audioContextRef.current = null;
        if (ctx && ctx.state !== "closed") {
          try {
            await ctx.close();
          } catch {}
        }
      })();
    };
  }, []);

  // <audio> pool (used for iOS priming + HTML audio fallback)
  type PoolAudio = HTMLAudioElement & { __poly420SampleKey?: string };

  const audioPoolRef = useRef<PoolAudio[]>([]);
  const audioPoolIndexRef = useRef(0);
  const samplesRef = useRef<Map<string, string>>(new Map());
  const poolPrimedRef = useRef(false);
  const pendingHtmlTimersRef = useRef<number[]>([]);

  const resetTrackGains = useCallback(() => {
    trackGainsRef.current.forEach((gain) => {
      try {
        gain.disconnect();
      } catch {}
    });
    trackGainsRef.current.clear();
  }, []);

  const clearPendingHtmlTimers = useCallback(() => {
    pendingHtmlTimersRef.current.forEach((handle) => clearTimeout(handle));
    pendingHtmlTimersRef.current = [];
  }, []);

  // Prefer HTML audio on iOS Chrome/WKWebView where WebAudio is often blocked.
  const useHtmlAudioEngine = isIOSChromeLikeWebView();

  const restartHtmlTransport = useCallback(() => {
    if (!useHtmlAudioEngine || !playingRef.current) return;

    clearPendingHtmlTimers();
    const now = performance.now() / 1000;
    const anchor = transportAnchorRef.current ?? now + 0.008;
    transportAnchorRef.current = anchor;
    startTimeRef.current = anchor;
    nextCycleRef.current = Math.max(
      0,
      Math.floor((now - anchor) / cycleDurationRef.current)
    );
    scheduledUntilRef.current =
      startTimeRef.current + nextCycleRef.current * cycleDurationRef.current;
    restartTransportRef.current = true;
  }, [clearPendingHtmlTimers, useHtmlAudioEngine]);

  const cycleDuration = useMemo(() => 60 / tempo, [tempo]);

  const timingSignature = useMemo(
    () =>
      `${tempo}|${tracks
        .map((track) => `${track.id}:${track.beatsPerCycle}`)
        .join(",")}`,
    [tempo, tracks]
  );

  const audibleTracks = useMemo(() => {
    const focused = tracks.filter((track) => track.deafened);
    const activeIds = new Set(
      (focused.length > 0 ? focused : tracks)
        .filter((track) => !track.muted)
        .map((track) => track.id)
    );

    return tracks.map((track) => ({
      ...track,
      volume: activeIds.has(track.id) ? track.volume : 0,
    }));
  }, [tracks]);

  // Keep refs current for the scheduler
  useEffect(() => {
    cycleDurationRef.current = cycleDuration;
    audibleTracksRef.current = audibleTracks;
  }, [cycleDuration, audibleTracks]);

  const audibleMembershipSignature = useMemo(
    () => audibleTracks.map((track) => track.id).join("|"),
    [audibleTracks]
  );

  useEffect(() => {
    if (!playingRef.current || !useHtmlAudioEngine) return;
    restartHtmlTransport();
  }, [audibleMembershipSignature, restartHtmlTransport, useHtmlAudioEngine]);

  useEffect(() => {
    if (!playingRef.current || useHtmlAudioEngine) return;
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === "closed") return;

    const trackById = new Map(
      audibleTracks.map((track) => [track.id, track])
    );

    trackGainsRef.current.forEach((gain, id) => {
      const track = trackById.get(id);
      if (!track) {
        try {
          gain.disconnect();
        } catch {}
        trackGainsRef.current.delete(id);
        return;
      }

      const targetGain = track.volume;
      gain.gain.setValueAtTime(targetGain, ctx.currentTime);
    });

    audibleTracks.forEach((track) => {
      const existing = trackGainsRef.current.get(track.id);
      if (existing) return;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(track.volume, ctx.currentTime);
      gain.connect(ctx.destination);
      trackGainsRef.current.set(track.id, gain);
    });
  }, [audibleTracks, useHtmlAudioEngine]);

  // Restart transport when timing changes; rebuild the audio loop so old hits die
  useEffect(() => {
    if (!playingRef.current) return;
    restartTransportRef.current = true;
    startTimeRef.current = 0;
    nextCycleRef.current = 0;
    scheduledUntilRef.current = 0;

    if (useHtmlAudioEngine) {
      clearPendingHtmlTimers();
      return;
    }

    resetTrackGains();
    const ctx = audioContextRef.current;
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {});
    }
    audioContextRef.current = null;
    keepAliveRef.current = null;

    const AudioCtor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    const freshCtx = new AudioCtor({
      latencyHint: "interactive",
    } as AudioContextOptions);
    audioContextRef.current = freshCtx;

    void (async () => {
      try {
        if (freshCtx.state !== "running") {
          await freshCtx.resume();
        }
        if (!keepAliveRef.current) {
          const osc = freshCtx.createOscillator();
          const gain = freshCtx.createGain();
          gain.gain.value = 0;
          osc.frequency.value = 30;
          osc.connect(gain);
          gain.connect(freshCtx.destination);
          osc.start();
          keepAliveRef.current = osc;
        }
      } catch {}
    })();
  }, [
    clearPendingHtmlTimers,
    resetTrackGains,
    timingSignature,
    useHtmlAudioEngine,
  ]);

  const setCycleProgressCss = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    const prev = lastCssProgressRef.current;
    const wrapped = playingRef.current && clamped < prev;

    if (wrapped) {
      setSnapBeats(true);
      if (snapResetHandleRef.current !== null) {
        cancelAnimationFrame(snapResetHandleRef.current);
      }
      snapResetHandleRef.current = requestAnimationFrame(() => {
        setSnapBeats(false);
        snapResetHandleRef.current = null;
      });
    }

    if (Math.abs(clamped - prev) < 0.0004) return;
    document.documentElement.style.setProperty(
      "--cycle-progress",
      clamped.toString()
    );
    lastCssProgressRef.current = clamped;
  }, []);

  const ensureAudioRunningInGesture = useCallback(async () => {
    const AudioCtor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    let ctx = audioContextRef.current;

    // Create inside gesture when possible; iOS is picky about creation + resume ordering
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioCtor({
        latencyHint: "interactive",
      } as AudioContextOptions);
      audioContextRef.current = ctx;
    }

    // IMPORTANT: don't swallow resume failures; if this throws, caller should keep playing=false
    if (ctx.state !== "running") {
      await ctx.resume();
    }

    // Keep the audio graph alive (helps iOS/WKWebView stability)
    if (!keepAliveRef.current) {
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

  const stopAudioHard = useCallback(() => {
    setPlaying(false);

    clearPendingHtmlTimers();
    resetTrackGains();
    audioPoolIndexRef.current = 0;

    if (useHtmlAudioEngine) {
      audioPoolRef.current.forEach((audio) => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {}
      });
    }

    const ctx = audioContextRef.current;

    try {
      keepAliveRef.current?.stop();
    } catch {}
    keepAliveRef.current = null;

    // Reset transport state immediately
    transportAnchorRef.current = null;
    startTimeRef.current = 0;
    nextCycleRef.current = 0;
    scheduledUntilRef.current = 0;
    restartTransportRef.current = false;

    // Closing is fine on explicit Stop; the next Play must be a gesture anyway
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {});
    }
    audioContextRef.current = null;
  }, [clearPendingHtmlTimers, resetTrackGains, useHtmlAudioEngine]);

  const ensureAudioPool = useCallback(() => {
    if (audioPoolRef.current.length > 0) return;

    const POOL = 6; // only needed for priming
    const pool: PoolAudio[] = [];
    for (let i = 0; i < POOL; i++) {
      const a = new Audio();
      a.preload = "auto";
      // TS doesn't know these; set as attributes for iOS
      a.setAttribute("playsinline", "");
      a.setAttribute("webkit-playsinline", "");
      (a as any).playsInline = true;
      (a as any).webkitPlaysInline = true;
      pool.push(a);
    }
    audioPoolRef.current = pool;
  }, []);

  const getSampleUri = useCallback(
    (freq: number, accent: boolean, loudness: number) => {
      const boosted = Math.max(
        0,
        Math.min(1.18, loudness * (accent ? 1.3 : 1.18))
      );
      const quantized = Math.round(boosted * 100);
      const key = `${freq}:${accent ? "a" : "n"}:${quantized}`;
      const hit = samplesRef.current.get(key);
      if (hit) return hit;

      const uri = makeWavDataUri({
        freq,
        durationSec: accent ? 0.075 : 0.055,
        sampleRate: 44100,
        volume: boosted,
        type: accent ? "triangle" : "sine",
      });

      samplesRef.current.set(key, uri);
      return uri;
    },
    []
  );

  const primeMediaPoolInGesture = useCallback(async () => {
    ensureAudioPool();
    if (poolPrimedRef.current) return;
    poolPrimedRef.current = true;

    const sample = getSampleUri(440, false, 1);
    const pool = audioPoolRef.current;

    const primeOne = async (a: PoolAudio) => {
      a.src = sample;
      // iOS is increasingly hostile to "volume=0 unlock". Use muted + tiny volume.
      a.muted = true;
      a.volume = 1;

      try {
        try {
          a.currentTime = 0;
        } catch {}

        const p = a.play();
        // Some WKWebView builds return undefined; normalize
        if (p && typeof (p as Promise<void>).then === "function") {
          await p;
        }
        a.pause();
        try {
          a.currentTime = 0;
        } catch {}
      } catch {
        // Best effort only; WebAudio path will still try next.
      } finally {
        a.muted = false;
      }
    };

    if (pool.length === 0) return;
    if (pool[0]) await primeOne(pool[0]);
    if (pool[1]) await primeOne(pool[1]);
    pool.slice(2).forEach((audio) => {
      void primeOne(audio);
    });
  }, [ensureAudioPool, getSampleUri]);

  const playSampleWithHtmlAudio = useCallback(
    ({
      when,
      hits,
    }: {
      when: number;
      hits: {
        trackId: string;
        accent: boolean;
      }[];
    }) => {
      ensureAudioPool();
      const pool = audioPoolRef.current;
      if (pool.length === 0 || hits.length === 0) return;

      const now = performance.now() / 1000;
      const delayMs = Math.max(0, Math.round((when - now) * 1000));

      const playNow = () => {
        const audibleById = new Map(
          audibleTracksRef.current.map((track) => [track.id, track])
        );

        hits.forEach(({ trackId, accent }) => {
          const track = audibleById.get(trackId);
          if (!track) return;

          const frequency = PITCHES[track.pitchIndex % PITCHES.length];
          const index = audioPoolIndexRef.current % pool.length;
          audioPoolIndexRef.current =
            (audioPoolIndexRef.current + 1) % pool.length;
          const audio = pool[index];

          audio.pause();
          try {
            audio.currentTime = 0;
          } catch {}

          const loudness = Math.max(0, Math.min(1.1, track.volume * 1.3));
          audio.src = getSampleUri(frequency, accent, loudness);
          audio.volume = Math.min(1, loudness * (accent ? 1.05 : 1));
          audio.muted = false;

          const playPromise = audio.play();
          if (playPromise && typeof playPromise.then === "function") {
            playPromise.catch(() => {});
          }
        });
      };

      if (delayMs <= 4) {
        playNow();
      } else {
        const timer = window.setTimeout(playNow, delayMs);
        pendingHtmlTimersRef.current.push(timer);
      }
    },
    [ensureAudioPool, getSampleUri]
  );

  useEffect(() => {
    const hash = encodeState(tempo, tracks, darkMode);
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", `${base}${hash}`);
  }, [tempo, tracks, darkMode]);

  useEffect(() => {
    document.body.classList.toggle("poly420-dark", darkMode);
  }, [darkMode]);

  // Scheduler: does NOT create/resume/close AudioContext. It only schedules if ctx is running.
  useEffect(() => {
    if (!playing) return;

    let interval: number | null = null;
    let cancelled = false;

    const scheduleAhead = 0.8; // more buffer reduces choppiness on mobile
    const tickMs = 25;

    const schedule = () => {
      if (cancelled) return;

      if (useHtmlAudioEngine) {
        const now = performance.now() / 1000;

        const cycleDur = cycleDurationRef.current;
        const tracksNow = audibleTracksRef.current;
        const until = now + scheduleAhead;

        if (transportAnchorRef.current === null) {
          transportAnchorRef.current = now + 0.008;
        }

        if (restartTransportRef.current || startTimeRef.current === 0) {
          clearPendingHtmlTimers();
          const anchor = transportAnchorRef.current;
          const elapsed = Math.max(0, now - anchor);
          const nextCycle = Math.max(0, Math.floor(elapsed / cycleDur));
          startTimeRef.current = anchor;
          nextCycleRef.current = nextCycle;
          scheduledUntilRef.current = anchor + nextCycle * cycleDur;
          restartTransportRef.current = false;
        }

        while (scheduledUntilRef.current < until) {
          const cycleIndex = nextCycleRef.current;
          const cycleStart = startTimeRef.current + cycleIndex * cycleDur;

          if (cycleStart < now - 0.2) {
            restartTransportRef.current = true;
            clearPendingHtmlTimers();
            return;
          }

          const hitsByBeat = new Map<
            number,
            { accent: boolean; trackId: string }[]
          >();

          tracksNow.forEach((track) => {
            for (let beat = 0; beat < track.beatsPerCycle; beat += 1) {
              const beatMoment =
                cycleStart + (cycleDur * beat) / track.beatsPerCycle;
              const key = Math.round(beatMoment * 1000);
              const bucket = hitsByBeat.get(key) ?? [];
              bucket.push({
                accent: beat === 0,
                trackId: track.id,
              });
              hitsByBeat.set(key, bucket);
            }
          });

          hitsByBeat.forEach((hits, key) => {
            playSampleWithHtmlAudio({
              when: key / 1000,
              hits,
            });
          });

          nextCycleRef.current += 1;
          scheduledUntilRef.current = cycleStart + cycleDur;
        }
        return;
      }

      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== "running") {
        // iOS may have suspended us; require a user tap to recover (don't spam resume here)
        return;
      }

      const now = performance.now() / 1000;
      const ctxOffset = ctx.currentTime - now;

      if (transportAnchorRef.current === null) {
        transportAnchorRef.current = now + 0.008;
      }

      const cycleDur = cycleDurationRef.current;
      const tracksNow = audibleTracksRef.current;

      if (restartTransportRef.current || startTimeRef.current === 0) {
        // Restart transport cleanly without closing context
        const anchor = transportAnchorRef.current;
        const elapsed = Math.max(0, now - anchor);
        const nextCycle = Math.max(0, Math.floor(elapsed / cycleDur));
        startTimeRef.current = anchor;
        nextCycleRef.current = nextCycle;
        scheduledUntilRef.current = anchor + nextCycle * cycleDur;
        restartTransportRef.current = false;
      }

      const until = now + scheduleAhead;

      // Schedule cycles until "until"
      while (scheduledUntilRef.current < until) {
        const cycleIndex = nextCycleRef.current;
        const cycleStartPerf = startTimeRef.current + cycleIndex * cycleDur;
        const cycleStart = cycleStartPerf + ctxOffset;

        // If our cycleStart is already too far in the past (tab pause), realign
        if (cycleStart < ctx.currentTime - 0.2) {
          restartTransportRef.current = true;
          return;
        }

        tracksNow.forEach((track) => {
          const frequency = PITCHES[track.pitchIndex % PITCHES.length];
          const existingGain = trackGainsRef.current.get(track.id);
          const trackGain = existingGain ?? ctx.createGain();

          const preamped = Math.max(
            0,
            Math.min(1.1, track.volume * 1.22 + 0.04)
          );
          trackGain.gain.value = preamped;
          if (!existingGain) {
            trackGain.connect(ctx.destination);
            trackGainsRef.current.set(track.id, trackGain);
          }

          for (let beat = 0; beat < track.beatsPerCycle; beat += 1) {
            const beatMoment =
              cycleStartPerf + (cycleDur * beat) / track.beatsPerCycle;
            scheduleClickWebAudio(
              ctx,
              beatMoment + ctxOffset,
              frequency,
              beat === 0,
              track.beatsPerCycle,
              trackGain
            );
          }
        });

        nextCycleRef.current += 1;
        scheduledUntilRef.current = cycleStartPerf + cycleDur;
      }
    };

    // Initial schedule immediately
    schedule();
    interval = window.setInterval(schedule, tickMs);

    const onVisibility = () => {
      // If we come back from background, timing jumps; restart on next scheduler tick.
      restartTransportRef.current = true;
      if (useHtmlAudioEngine) clearPendingHtmlTimers();
    };

    window.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
      window.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      // DO NOT close context here. Only Stop/unmount closes.
    };
  }, [
    clearPendingHtmlTimers,
    playSampleWithHtmlAudio,
    playing,
    useHtmlAudioEngine,
  ]);

  // CSS progress loop (read-only; doesn't touch audio engine)
  useEffect(() => {
    let frame: number | null = null;

    const update = () => {
      if (!playingRef.current) {
        setCycleProgressCss(0);
        frame = null;
        return;
      }

      const now = performance.now() / 1000;
      const anchor = transportAnchorRef.current;

      if (anchor === null || startTimeRef.current === 0) {
        setCycleProgressCss(0);
        frame = requestAnimationFrame(update);
        return;
      }

      const cycleDur = cycleDurationRef.current;
      const elapsed = Math.max(0, now - anchor);
      const position = cycleDur > 0 ? (elapsed % cycleDur) / cycleDur : 0;
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
  }, [playing, setCycleProgressCss, useHtmlAudioEngine]);

  const togglePlay = async () => {
    if (playingRef.current) {
      stopAudioHard();
      return;
    }

    // Unlock media stack inside the gesture (best-effort)
    await primeMediaPoolInGesture();

    // Warm up WebAudio even if we end up using the HTML engine; iOS WKWebView builds
    // sometimes behave better after an AudioContext has been resumed once.
    if (useHtmlAudioEngine) {
      try {
        await ensureAudioRunningInGesture();
      } catch (error) {
        console.warn(
          "[poly420] WebAudio warmup failed; continuing with HTML audio",
          error
        );
      }
    }

    if (useHtmlAudioEngine) {
      const now = performance.now() / 1000;
      const cycleDur = cycleDurationRef.current;
      const tracksNow = audibleTracksRef.current;

      const startAt = transportAnchorRef.current ?? now + 0.008;
      transportAnchorRef.current = startAt;
      startTimeRef.current = startAt;
      nextCycleRef.current = Math.max(
        0,
        Math.floor((now - startAt) / cycleDur)
      );
      scheduledUntilRef.current = startAt + nextCycleRef.current * cycleDur;
      restartTransportRef.current = false;

      const firstCycleStart =
        startAt + nextCycleRef.current * cycleDur + 0.003; /* headroom */

      const hitsByBeat = new Map<
        number,
        { accent: boolean; trackId: string }[]
      >();

      tracksNow.forEach((track) => {
        for (let beat = 0; beat < track.beatsPerCycle; beat += 1) {
          const beatMoment =
            firstCycleStart + (cycleDur * beat) / track.beatsPerCycle;
          const key = Math.round(beatMoment * 1000);
          const bucket = hitsByBeat.get(key) ?? [];
          bucket.push({
            accent: beat === 0,
            trackId: track.id,
          });
          hitsByBeat.set(key, bucket);
        }
      });

      hitsByBeat.forEach((hits, key) => {
        playSampleWithHtmlAudio({
          when: key / 1000,
          hits,
        });
      });

      nextCycleRef.current += 1;
      scheduledUntilRef.current = firstCycleStart + cycleDur;

      setPlaying(true);
      return;
    }

    try {
      const existing = audioContextRef.current;
      const beforeState = existing?.state ?? "none";
      const ctx = await ensureAudioRunningInGesture();
      const afterState = ctx.state;
      console.log(
        `[poly420] Play tap resume state: ${beforeState} -> ${afterState}`
      );

      // Start playing only after audio is actually running
      const now = performance.now() / 1000;
      const anchor = transportAnchorRef.current ?? now + 0.008;
      transportAnchorRef.current = anchor;
      startTimeRef.current = anchor;
      nextCycleRef.current = Math.max(
        0,
        Math.floor((now - anchor) / cycleDurationRef.current)
      );
      scheduledUntilRef.current =
        anchor + nextCycleRef.current * cycleDurationRef.current;
      restartTransportRef.current = true;
      setPlaying(true);
    } catch (e) {
      console.warn("[poly420] Unable to start audio (needs user gesture?)", e);
      // Make sure UI stays stopped if iOS rejects resume
      stopAudioHard();
    }
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
                                  ["--beats" as any]:
                                    track.beatsPerCycle.toString(),
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
        </div>
      </div>
    </div>
  );
}

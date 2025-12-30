import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
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
  { id: "track-1", beatsPerCycle: 4, volume: DEFAULT_VOLUME, muted: false, deafened: false, pitchIndex: 0 },
  { id: "track-2", beatsPerCycle: 3, volume: DEFAULT_VOLUME, muted: false, deafened: false, pitchIndex: 1 },
];

const clampTempo = (tempo: number) => Math.min(240, Math.max(1, Math.round(tempo)));
let trackCounter = DEFAULT_TRACKS.length + 1;

function scheduleClick(
  ctx: AudioContext,
  time: number,
  frequency: number,
  accent: boolean,
  density: number,
  volume: number,
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
        const volumeFlag = volumePercent !== Math.round(DEFAULT_VOLUME * 100) ? `v${volumePercent}` : "";
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

function parseState(hash: string): { tempo: number; tracks: Track[]; darkMode: boolean } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return { tempo: DEFAULT_TEMPO, tracks: DEFAULT_TRACKS, darkMode: true };

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
      const volumePercent = volRaw ? Number(volRaw) : Math.round(DEFAULT_VOLUME * 100);
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
    .filter(Boolean) as Track[],
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
  const [tracks, setTracks] = useState<Track[]>(applyPitchOrder(initial?.tracks ?? DEFAULT_TRACKS));
  const [cycleProgress, setCycleProgress] = useState(0);
  const [snapBeats, setSnapBeats] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef(0);
  const nextCycleRef = useRef(0);
  const prevCycleProgressRef = useRef(0);

  const cycleDuration = useMemo(() => 60 / tempo, [tempo]);

  const audibleTracks = useMemo(() => {
    const focused = tracks.filter((track) => track.deafened);
    const base = focused.length > 0 ? focused : tracks;
    return base.filter((track) => !track.muted);
  }, [tracks]);

  useEffect(() => {
    const hash = encodeState(tempo, tracks, darkMode);
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", `${base}${hash}`);
  }, [tempo, tracks, darkMode]);

  useEffect(() => {
    document.body.classList.toggle("poly420-dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    if (!playing) {
      nextCycleRef.current = 0;
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
      return undefined;
    }

    const ctx = new AudioContext();
    audioContextRef.current = ctx;
    const startAt = ctx.currentTime + 0.05;
    startTimeRef.current = startAt;
    nextCycleRef.current = 0;

    const scheduleAhead = 0.7;

    const schedule = () => {
      const until = ctx.currentTime + scheduleAhead;
      while (startTimeRef.current + nextCycleRef.current * cycleDuration < until) {
        const cycleStart = startTimeRef.current + nextCycleRef.current * cycleDuration;
        audibleTracks.forEach((track) => {
          const frequency = PITCHES[track.pitchIndex % PITCHES.length];
          for (let beat = 0; beat < track.beatsPerCycle; beat += 1) {
            const beatMoment = cycleStart + (cycleDuration * beat) / track.beatsPerCycle;
            scheduleClick(ctx, beatMoment, frequency, beat === 0, track.beatsPerCycle, track.volume);
          }
        });
        nextCycleRef.current += 1;
      }
    };

    const interval = window.setInterval(schedule, 40);
    return () => {
      window.clearInterval(interval);
      void ctx.close();
      audioContextRef.current = null;
    };
  }, [playing, cycleDuration, audibleTracks]);

  useEffect(() => {
    let frame: number | null = null;

    const update = () => {
      const ctx = audioContextRef.current;
      if (!ctx) {
        setCycleProgress(0);
        return;
      }

      const elapsed = Math.max(0, ctx.currentTime - startTimeRef.current);
      const position = cycleDuration > 0 ? (elapsed % cycleDuration) / cycleDuration : 0;
      setCycleProgress(position);
      frame = requestAnimationFrame(update);
    };

    if (playing) {
      frame = requestAnimationFrame(update);
    } else {
      setCycleProgress(0);
    }

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [playing, cycleDuration]);

  useEffect(() => {
    const prev = prevCycleProgressRef.current;
    const wrapped = playing && cycleProgress < prev;
    prevCycleProgressRef.current = cycleProgress;

    if (wrapped) {
      setSnapBeats(true);
      const handle = requestAnimationFrame(() => setSnapBeats(false));
      return () => cancelAnimationFrame(handle);
    }

    if (!playing) {
      setSnapBeats(false);
    }
  }, [cycleProgress, playing]);

  const togglePlay = () => {
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setPlaying((prev) => !prev);
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
    setTracks((prev) => applyPitchOrder(prev.filter((track) => track.id !== id)));
  };

  const updateTrackBeats = (id: string, beats: number) => {
    const safeBeats = Math.max(1, Math.round(beats));
    setTracks((prev) => applyPitchOrder(prev.map((track) => (track.id === id ? { ...track, beatsPerCycle: safeBeats } : track))));
  };

  const updateTrackVolume = (id: string, volume: number) => {
    const safeVolume = Math.min(1, Math.max(0, volume));
    setTracks((prev) => applyPitchOrder(prev.map((track) => (track.id === id ? { ...track, volume: safeVolume } : track))));
  };

  const toggleMute = (id: string) => {
    setTracks((prev) =>
      applyPitchOrder(prev.map((track) => (track.id === id ? { ...track, muted: !track.muted, deafened: false } : track))),
    );
  };

  const toggleDeafen = (id: string) => {
    setTracks((prev) =>
      applyPitchOrder(prev.map((track) => (track.id === id ? { ...track, deafened: !track.deafened, muted: false } : track))),
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
              <button className={`play-toggle ${playing ? "active" : ""}`} onClick={togglePlay} aria-label="Play or stop">
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
                    max={240}
                    inputMode="numeric"
                    value={tempo}
                    onChange={(event) => updateTempo(Number(event.target.value))}
                  />
                </div>
              </div>
              <div className="transport-side">
                <button onClick={addTrack} className="ghost round" aria-label="Add track">
                  <span className="add-icon" aria-hidden="true">
                  +
                </span>
              </button>
              <button className="icon-button" onClick={() => setDarkMode((prev) => !prev)} aria-label="Toggle theme">
                {darkMode ? "🌙" : "🌞"}
              </button>
            </div>
          </div>

          <div className="tracks">
            {tracks.map((track) => {
              const beatProgress = cycleProgress * track.beatsPerCycle;
              return (
                <div key={track.id} className="track-card">
                  <div className="control-column">
                    <div className="control-row tight">
                      <div className="beat-control">
                        <label className="sr-only" htmlFor={`${track.id}-beats`}>
                          Cycle
                        </label>
                        <input
                          id={`${track.id}-beats`}
                          type="number"
                          min={1}
                          max={64}
                          inputMode="numeric"
                          value={track.beatsPerCycle}
                          onChange={(event) => updateTrackBeats(track.id, Number(event.target.value))}
                        />
                        <div className="beat-visualization" aria-hidden="true">
                          {Array.from({ length: track.beatsPerCycle }).map((_, index) => {
                            const fillAmount = Math.min(1, Math.max(0, beatProgress - index));
                            const isActive = fillAmount > 0;
                            const fillStyle = { ["--fill" as const]: fillAmount.toString() } as CSSProperties;
                            const segmentClassName = `beat-segment ${isActive ? "active" : ""} ${snapBeats ? "snap" : ""}`;
                            return (
                              <div
                                key={index}
                                className={segmentClassName}
                                style={fillStyle}
                              />
                            );
                          })}
                        </div>
                      </div>
                      <button className="chip danger" onClick={() => removeTrack(track.id)} aria-label="Remove track">
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
                        <label className="sr-only" htmlFor={`${track.id}-volume`}>
                          Level
                        </label>
                        <input
                          id={`${track.id}-volume`}
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={track.volume}
                          onChange={(event) => updateTrackVolume(track.id, Number(event.target.value))}
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

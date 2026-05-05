import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Daemon-voice hook.
 *
 * Loads the pre-rendered daemon voice pair (`daemon-female.mp3` +
 * `daemon-male.mp3`) into AudioBuffers on first prime() and plays them
 * through a shared AnalyserNode so callers can render an amplitude-driven
 * pulse on the daemon orb. The same audio assets back the splash page —
 * this is the "voice we generated".
 *
 * Lifecycle contract:
 * - `prime()` MUST be called inside a user-gesture handler (e.g. the click
 *   that triggers the chat request). It creates the AudioContext
 *   *synchronously* and resumes it in-gesture; buffer fetch/decode then
 *   continues asynchronously off the gesture frame.
 * - `play()` is safe to call later from async callbacks (e.g. mutation
 *   onSuccess). If buffers haven't finished loading yet it queues a single
 *   playback for when they arrive.
 *
 * Performance contract:
 * - Per-frame amplitude updates are fanned out to subscribers via
 *   `subscribeLevel` instead of React state, so the orb can mutate its
 *   SVG attributes imperatively without re-rendering the chat tree.
 *   `isSpeaking` is React state because it only changes twice per
 *   playback.
 */

type VoicePair = { female: AudioBuffer; male: AudioBuffer };

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

async function loadDaemonBuffers(ctx: AudioContext): Promise<VoicePair | null> {
  const base = import.meta.env.BASE_URL ?? "/";
  try {
    const [femResp, masResp] = await Promise.all([
      fetch(`${base}audio/daemon-female.mp3`),
      fetch(`${base}audio/daemon-male.mp3`),
    ]);
    if (!femResp.ok || !masResp.ok) throw new Error("daemon voice fetch failed");
    const [femBuf, masBuf] = await Promise.all([femResp.arrayBuffer(), masResp.arrayBuffer()]);
    const [female, male] = await Promise.all([
      ctx.decodeAudioData(femBuf),
      ctx.decodeAudioData(masBuf),
    ]);
    return { female, male };
  } catch {
    return null;
  }
}

export interface DaemonVoice {
  /** Call inside a user-gesture handler to create + resume the AudioContext. */
  prime: () => void;
  /** Schedule the daemon voice pair to play. Safe from async callbacks. */
  play: () => void;
  /** True from `play()` until the audio finishes. */
  isSpeaking: boolean;
  /** Subscribe to per-frame RMS amplitude in 0..1. Returns an unsubscribe fn. */
  subscribeLevel: (cb: (level: number) => void) => () => void;
}

export function useDaemonVoice(): DaemonVoice {
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<VoicePair | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const loadingRef = useRef<Promise<VoicePair | null> | null>(null);
  const pendingPlayRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const stopTimeoutRef = useRef<number | null>(null);
  const cancelledRef = useRef<boolean>(false);
  const listenersRef = useRef<Set<(l: number) => void>>(new Set());
  const [isSpeaking, setIsSpeaking] = useState(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (stopTimeoutRef.current != null) clearTimeout(stopTimeoutRef.current);
      // Close any context the gesture handler created. If a load was still
      // in-flight, the cancelledRef guard inside the load promise prevents
      // it from re-storing buffers; the context is closed here either way.
      const ctx = ctxRef.current;
      if (ctx) void ctx.close();
      ctxRef.current = null;
      buffersRef.current = null;
      analyserRef.current = null;
      listenersRef.current.clear();
    };
  }, []);

  const subscribeLevel = useCallback((cb: (l: number) => void) => {
    const set = listenersRef.current;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }, []);

  const emit = useCallback((level: number) => {
    listenersRef.current.forEach((cb) => cb(level));
  }, []);

  const startMeter = useCallback(
    (analyser: AnalyserNode) => {
      if (rafRef.current != null) return;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Map quiet-to-loud RMS (~0..0.4) onto a perceptually punchy 0..1.
        emit(Math.min(1, rms * 2.6));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [emit],
  );

  const stopMeter = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    emit(0);
    setIsSpeaking(false);
  }, [emit]);

  const performPlay = useCallback(
    (buffers: VoicePair) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      if (ctx.state === "suspended") void ctx.resume();
      if (!analyserRef.current) {
        const a = ctx.createAnalyser();
        a.fftSize = 256;
        a.smoothingTimeConstant = 0.7;
        a.connect(ctx.destination);
        analyserRef.current = a;
      }
      const analyser = analyserRef.current;
      // Match the splash's behaviour: stretch the shorter clip so both
      // voices finish on the same instant for a clean unison cadence.
      const target = Math.max(buffers.female.duration, buffers.male.duration);
      const playOne = (buf: AudioBuffer, gain: number) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = buf.duration / target;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(analyser);
        return src;
      };
      const startAt = ctx.currentTime + 0.02;
      playOne(buffers.female, 0.85).start(startAt);
      playOne(buffers.male, 0.85).start(startAt);

      setIsSpeaking(true);
      startMeter(analyser);
      if (stopTimeoutRef.current != null) clearTimeout(stopTimeoutRef.current);
      // Add a small tail so the meter reads the natural decay before we
      // settle the orb back to its idle breathing state.
      stopTimeoutRef.current = window.setTimeout(
        () => stopMeter(),
        Math.ceil((target + 0.25) * 1000),
      );
    },
    [startMeter, stopMeter],
  );

  const prime = useCallback(() => {
    // (1) Synchronously create + resume the AudioContext inside the gesture
    //     so the browser's autoplay policy unlocks it for later async play().
    if (!ctxRef.current) {
      const Ctx = getAudioContextCtor();
      if (!Ctx) return;
      try {
        ctxRef.current = new Ctx();
      } catch {
        return;
      }
    }
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") void ctx.resume();
    // (2) Kick off buffer load (fetch + decode) once, off the gesture frame.
    if (!loadingRef.current) {
      loadingRef.current = loadDaemonBuffers(ctx).then((pair) => {
        if (cancelledRef.current) return null;
        if (pair) {
          buffersRef.current = pair;
          // If a play() was already requested while loading, fire it now.
          if (pendingPlayRef.current) {
            pendingPlayRef.current = false;
            performPlay(pair);
          }
        } else {
          // Allow a future prime() to retry after a transient fetch/decode
          // failure instead of being permanently stuck on the failed promise.
          loadingRef.current = null;
        }
        return pair;
      });
    }
  }, [performPlay]);

  const play = useCallback(() => {
    const buffers = buffersRef.current;
    if (buffers) {
      performPlay(buffers);
      return;
    }
    // Buffers still loading — queue a single playback for when they arrive.
    // If load failed entirely, the queued play is harmlessly never fired
    // (chat continues to work, the orb just won't pulse).
    pendingPlayRef.current = true;
  }, [performPlay]);

  return { prime, play, isSpeaking, subscribeLevel };
}

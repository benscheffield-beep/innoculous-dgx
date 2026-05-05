import { useLocation } from "wouter";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, X } from "lucide-react";

/**
 * Pre-rendered voice clips (female + male) for each phrase, decoded once into
 * AudioBuffers so we can fire both voices through the Web Audio API on the same
 * audio frame. This is sample-accurate, unlike two parallel HTMLAudioElement.play()
 * calls which can drift by tens of milliseconds at the JS layer. Clips are
 * pre-trimmed to remove leading/trailing silence so the words start in lockstep.
 */
type PhraseKey = "innoculus" | "reckoner" | "daemon" | "judge" | "initiation";

const PHRASE_FILES: Record<PhraseKey, { female: string; male: string }> = {
  innoculus: { female: "innoculus-female.mp3", male: "innoculus-male.mp3" },
  reckoner: { female: "reckoner-female.mp3", male: "reckoner-male.mp3" },
  daemon: { female: "daemon-female.mp3", male: "daemon-male.mp3" },
  judge: { female: "judge-female.mp3", male: "judge-male.mp3" },
  initiation: { female: "initiation-female.mp3", male: "initiation-male.mp3" },
};

type VoicePair = { female: AudioBuffer; male: AudioBuffer };
type LevelListener = (level: number) => void;

/** Async-decoded buffers + per-context analyser. Created once per AudioContext. */
type LoadedBuffers = {
  phrases: Record<PhraseKey, VoicePair>;
  analyser: AnalyserNode;
};

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

async function loadBuffers(ctx: AudioContext): Promise<LoadedBuffers | null> {
  const base = import.meta.env.BASE_URL ?? "/";
  try {
    const keys = Object.keys(PHRASE_FILES) as PhraseKey[];
    const decoded = await Promise.all(
      keys.map(async (key): Promise<[PhraseKey, VoicePair]> => {
        const files = PHRASE_FILES[key];
        const [femResp, masResp] = await Promise.all([
          fetch(`${base}audio/${files.female}`),
          fetch(`${base}audio/${files.male}`),
        ]);
        if (!femResp.ok || !masResp.ok) {
          throw new Error(`fetch failed for ${key}`);
        }
        const [femBuf, masBuf] = await Promise.all([
          femResp.arrayBuffer(),
          masResp.arrayBuffer(),
        ]);
        const [female, male] = await Promise.all([
          ctx.decodeAudioData(femBuf),
          ctx.decodeAudioData(masBuf),
        ]);
        return [key, { female, male }];
      }),
    );
    const phrases = Object.fromEntries(decoded) as Record<PhraseKey, VoicePair>;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    analyser.connect(ctx.destination);
    return { phrases, analyser };
  } catch {
    return null;
  }
}

type HoverKey = PhraseKey | "tutorial";

/** A one-shot prismatic shockwave originating at (cx, cy) for the named role.
 *  The numeric `id` is bumped on every fire so React can remount the SVG
 *  group via `key={pulse.id}` and replay the CSS animation even on rapid
 *  consecutive clicks of the same orb. */
type Pulse = { key: PhraseKey; id: number; cx: number; cy: number };

/** Coordinates of the three role orbs in the splash SVG (viewBox 400x720). */
const ROLE_ORB_POS: Record<"reckoner" | "daemon" | "judge", { cx: number; cy: number }> = {
  reckoner: { cx: 200, cy: 220 },
  daemon:   { cx: 200, cy: 360 },
  judge:    { cx: 200, cy: 500 },
};

type ChatMsg = { role: "user" | "assistant"; content: string };

export default function Splash() {
  const [, navigate] = useLocation();
  const [hovered, setHovered] = useState<HoverKey | null>(null);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const pulseIdRef = useRef(0);

  // ─── Daemon chat overlay state ────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMsg[]>([]);
  const [transcript, setTranscript] = useState<string>("");
  const [chatInput, setChatInput] = useState("");
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const greetedRef = useRef(false);
  const inputElRef = useRef<HTMLTextAreaElement>(null);

  // Refs onto the Daemon SVG circles so we can drive the radii imperatively
  // from the audio amplitude meter. Avoids re-rendering the diagram per
  // animation frame.
  const daemonHaloRef = useRef<SVGCircleElement>(null);
  const daemonCoreRef = useRef<SVGCircleElement>(null);
  const [orbSpeaking, setOrbSpeaking] = useState(false);

  // ─── Audio infrastructure ─────────────────────────────────────────────────
  // The AudioContext is created **synchronously inside a user-gesture handler**
  // (see primeAudio()) so the browser autoplay policy unlocks it. Buffer
  // decode happens asynchronously after that. A play call before buffers are
  // ready is queued as a single pending key.
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<LoadedBuffers | null>(null);
  const loadingRef = useRef<Promise<LoadedBuffers | null> | null>(null);
  const pendingPlayRef = useRef<PhraseKey | null>(null);
  const listenersRef = useRef<Set<LevelListener>>(new Set());
  const meterRunningRef = useRef(false);
  const speakingFlagRef = useRef(false);
  const stopTimeoutRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  // Cleanup on unmount: cancel timers, clear listeners, close the context if
  // it was ever created. cancelledRef gates any in-flight load promise from
  // installing buffers post-unmount.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (stopTimeoutRef.current != null) {
        window.clearTimeout(stopTimeoutRef.current);
        stopTimeoutRef.current = null;
      }
      listenersRef.current.clear();
      const ctx = ctxRef.current;
      if (ctx) void ctx.close();
      ctxRef.current = null;
      buffersRef.current = null;
    };
  }, []);

  /** Install a per-frame amplitude listener. Returns an unsubscribe fn that
   *  removes only this listener (architectural fix vs. clearing the whole Set). */
  const subscribeLevel = useCallback((cb: LevelListener): (() => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  // Wire the Daemon SVG orb to the amplitude meter — once, at mount, since
  // the listener Set is stable. The cleanup correctly removes only our cb.
  useEffect(() => {
    const cb: LevelListener = (level) => {
      const halo = daemonHaloRef.current;
      const core = daemonCoreRef.current;
      // Idle baseline matches the static design (halo r=26, core r=7).
      // Peak amplitude bloats halo to ~46 / core to ~13.
      const haloR = 26 + level * 20;
      const coreR = 7 + level * 6;
      const haloOpacity = 0.55 + level * 0.45;
      if (halo) {
        halo.setAttribute("r", String(haloR));
        halo.setAttribute("opacity", String(haloOpacity));
      }
      if (core) {
        core.setAttribute("r", String(coreR));
      }
      // `orbSpeaking` toggles CSS animation off/on; only fires twice per clip
      // so per-frame state churn is avoided.
      const speaking = level > 0.01 || speakingFlagRef.current;
      setOrbSpeaking((prev) => (prev === speaking ? prev : speaking));
    };
    return subscribeLevel(cb);
  }, [subscribeLevel]);

  /** Synchronously create + resume the AudioContext inside a user gesture so
   *  the browser autoplay policy unlocks it for later async play. Idempotent. */
  const primeAudio = useCallback(() => {
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
    if (!loadingRef.current) {
      loadingRef.current = loadBuffers(ctx).then((b) => {
        if (cancelledRef.current) return null;
        if (b) {
          buffersRef.current = b;
          // Drain a queued playback if one was requested while loading.
          const pending = pendingPlayRef.current;
          if (pending) {
            pendingPlayRef.current = null;
            performSpeak(pending);
          }
        } else {
          // Allow a future prime to retry on transient fetch/decode failure.
          loadingRef.current = null;
        }
        return b;
      });
    }
  }, []);

  /** Run the rAF-driven RMS meter once; self-terminates when silence settles. */
  const startMeter = useCallback(() => {
    if (meterRunningRef.current) return;
    const buffers = buffersRef.current;
    if (!buffers) return;
    meterRunningRef.current = true;
    const analyser = buffers.analyser;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (cancelledRef.current) {
        meterRunningRef.current = false;
        return;
      }
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(1, rms * 2.6);
      listenersRef.current.forEach((cb) => cb(level));
      if (speakingFlagRef.current || level > 0.02) {
        requestAnimationFrame(tick);
      } else {
        meterRunningRef.current = false;
        listenersRef.current.forEach((cb) => cb(0));
      }
    };
    requestAnimationFrame(tick);
  }, []);

  /** Schedule a phrase pair through the analyser. If buffers aren't ready
   *  yet, queue a single playback for when they arrive. */
  const performSpeak = useCallback(
    (key: PhraseKey) => {
      const ctx = ctxRef.current;
      const buffers = buffersRef.current;
      if (!ctx || !buffers) {
        // Buffers still loading — queue a single playback for arrival.
        pendingPlayRef.current = key;
        return;
      }
      const pair = buffers.phrases[key];
      if (!pair) return;
      if (ctx.state === "suspended") void ctx.resume();
      const target = Math.max(pair.female.duration, pair.male.duration);
      const playOne = (b: AudioBuffer, gain: number) => {
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.playbackRate.value = b.duration / target;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(buffers.analyser);
        return src;
      };
      const startAt = ctx.currentTime + 0.02;
      playOne(pair.female, 0.85).start(startAt);
      playOne(pair.male, 0.85).start(startAt);

      speakingFlagRef.current = true;
      startMeter();
      if (stopTimeoutRef.current != null) window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = window.setTimeout(
        () => {
          speakingFlagRef.current = false;
          // emit a final 0 so subscribers settle to idle
          listenersRef.current.forEach((cb) => cb(0));
        },
        Math.ceil((target + 0.25) * 1000),
      );
    },
    [startMeter],
  );

  /** Public speak helper — call inside a click handler. Primes the context
   *  in the same gesture frame, then schedules / queues the playback. */
  const speak = useCallback(
    (key: PhraseKey) => {
      primeAudio();
      performSpeak(key);
    },
    [primeAudio, performSpeak],
  );

  // ─── Standalone Daemon chat call ─────────────────────────────────────────
  const sendChat = useCallback(
    (history: ChatMsg[], originalInput?: string) => {
      if (chatPending) return;
      setChatPending(true);
      setChatError(null);
      void (async () => {
        try {
          const resp = await fetch("/api/daemon/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: history }),
          });
          if (!resp.ok) {
            let detail = `HTTP ${resp.status}`;
            try {
              const body = (await resp.json()) as { message?: string; error?: string };
              if (body.message) detail = body.message;
              else if (body.error) detail = body.error;
            } catch {
              /* keep status */
            }
            throw new Error(detail);
          }
          const data = (await resp.json()) as { content?: string };
          const content = (data.content ?? "").trim();
          if (!content) throw new Error("empty Daemon response");
          setChatHistory((h) => [...h, { role: "assistant", content }]);
          setTranscript(content);
          // Voice playback — context was primed in the originating gesture
          // (sendChat is always called from a click/Enter handler), so
          // performSpeak inside the async resolve is autoplay-safe.
          performSpeak("daemon");
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setChatError(message);
          // Roll back the optimistically-added user turn AND restore the
          // input text so the user can correct + retry without re-typing.
          setChatHistory((h) =>
            h.length > 0 && h[h.length - 1]!.role === "user" ? h.slice(0, -1) : h,
          );
          if (originalInput) setChatInput(originalInput);
        } finally {
          setChatPending(false);
        }
      })();
    },
    [chatPending, performSpeak],
  );

  const openDaemonChat = useCallback(() => {
    // Prime the audio context in the same gesture frame so subsequent async
    // playback (greeting onSuccess) is autoplay-safe even if buffers aren't
    // decoded yet. Then play the daemon cue + shockwave for tactile feedback.
    speak("daemon");
    pulseIdRef.current += 1;
    const pos = ROLE_ORB_POS.daemon;
    setPulse({ key: "daemon", id: pulseIdRef.current, cx: pos.cx, cy: pos.cy });
    if (!chatOpen) setChatOpen(true);
    // First open of the session: seed the chat with a fixed greeting line.
    // We deliberately do NOT call the LLM for this — the user wants the
    // exact wording every time, so we hardcode it as the first assistant
    // turn (and write it into chatHistory so the LLM picks it up as
    // conversational context for any follow-up turns the visitor sends).
    if (!greetedRef.current) {
      greetedRef.current = true;
      const greeting =
        "Ask in accordance with the relics of AI. Open from the orb above to create your relics.";
      setChatHistory([{ role: "assistant", content: greeting }]);
      setTranscript(greeting);
    }
  }, [chatOpen, speak]);

  const closeDaemonChat = useCallback(() => {
    setChatOpen(false);
  }, []);

  const submitChatInput = useCallback(() => {
    const text = chatInput.trim();
    if (!text || chatPending) return;
    // Prime audio in this gesture frame so the async voice play after the
    // chat reply can resume the AudioContext.
    primeAudio();
    const next: ChatMsg[] = [...chatHistory, { role: "user", content: text }];
    setChatHistory(next);
    setChatInput("");
    sendChat(next, text);
  }, [chatInput, chatPending, chatHistory, sendChat, primeAudio]);

  // Autofocus the textarea when the chat opens so the user can type
  // immediately. Also handle Escape-to-close on the chat surface.
  useEffect(() => {
    if (chatOpen) {
      // requestAnimationFrame ensures the textarea is mounted before focus.
      const id = requestAnimationFrame(() => {
        inputElRef.current?.focus();
      });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setChatOpen(false);
        }
      };
      window.addEventListener("keydown", onKey);
      return () => {
        cancelAnimationFrame(id);
        window.removeEventListener("keydown", onKey);
      };
    }
    return undefined;
  }, [chatOpen]);

  const handleEnter = () => {
    speak("innoculus");
    navigate("/dashboard");
  };
  const handleTutorial = () => {
    speak("initiation");
    navigate("/tutorial");
  };
  const fireRole = (key: "reckoner" | "judge") => {
    speak(key);
    const pos = ROLE_ORB_POS[key];
    pulseIdRef.current += 1;
    setPulse({ key, id: pulseIdRef.current, cx: pos.cx, cy: pos.cy });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleEnter();
    }
  };
  const onKeyTutorial = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleTutorial();
    }
  };
  const onKeyDaemon = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDaemonChat();
    }
  };
  const onKeyRole = (key: "reckoner" | "judge") => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fireRole(key);
    }
  };
  const hoverProps = (key: HoverKey) => ({
    onMouseEnter: () => setHovered(key),
    onMouseLeave: () => setHovered((h) => (h === key ? null : h)),
  });

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-hidden flex flex-col items-center justify-center font-sans"
      style={{ background: "#000" }}
    >
      {/* Ambient grid backdrop */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.10]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)",
          backgroundSize: "32px 32px",
        }}
      />
      {/* Soft vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 0%, transparent 40%, #000 100%)",
        }}
      />

      {/* Wordmark — corner so it doesn't crowd the Reckoner node */}
      <div className="absolute top-6 left-6 flex items-center gap-2 z-10" style={{ color: "rgba(255,255,255,0.78)" }}>
        <div
          className="w-1.5 h-1.5 rounded-full animate-[innoculus-blink_2.4s_ease-in-out_infinite]"
          style={{ background: "#fff", boxShadow: "0 0 10px rgba(255,255,255,0.8)" }}
        />
        <span className="font-bold tracking-[0.35em] text-[11px] uppercase">Innoculus</span>
      </div>

      {/* Diagram */}
      <div className="relative z-10">
        <svg
          viewBox="0 0 400 720"
          className="w-[280px] sm:w-[340px] md:w-[400px] h-auto"
          aria-label="Innoculus innoculum diagram. Tap the top node to enter."
        >
          <defs>
            {/* White radial pulsation for the top portal node */}
            <radialGradient id="ic-node-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="40%" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            {/* Softer white halo for interior nodes */}
            <radialGradient id="ic-node-glow-soft" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            {/* Silicon grey stroke gradient */}
            <linearGradient id="ic-stroke" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%"   stopColor="#d8dde2" stopOpacity="0.95" />
              <stop offset="50%"  stopColor="#a8aeb4" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#6b7077" stopOpacity="0.7" />
            </linearGradient>
            <filter id="ic-soft-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Outer lens (the algorithm enclosure) — solid base */}
          <path
            d="M 200 60 C 60 220, 60 500, 200 660"
            fill="none"
            stroke="url(#ic-stroke)"
            strokeOpacity="0.75"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M 200 60 C 340 220, 340 500, 200 660"
            fill="none"
            stroke="url(#ic-stroke)"
            strokeOpacity="0.75"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          {/* Outer lens — traveling comet highlight (apparent motion) */}
          <path
            d="M 200 60 C 60 220, 60 500, 200 660"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.95"
            strokeWidth="1.8"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />
          <path
            d="M 200 60 C 340 220, 340 500, 200 660"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.95"
            strokeWidth="1.8"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite_reverse]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />

          {/* Vertical telemetry spine */}
          <line
            x1="200" y1="60" x2="200" y2="660"
            stroke="#c0c5cb"
            strokeOpacity="0.18"
            strokeWidth="1"
          />

          {/* Upper inner lens — top portal <-> upper node. Solid base + a
              traveling comet highlight so the inner lens reads as in motion
              the same way the outer lens and innermost oval do. The two
              sides run in opposite directions for visual interest. */}
          <path
            d="M 200 80 C 130 160, 130 280, 200 360"
            fill="none"
            stroke="#cfd4d9"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
          />
          <path
            d="M 200 80 C 130 160, 130 280, 200 360"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.85"
            strokeWidth="1.4"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />
          <path
            d="M 200 80 C 270 160, 270 280, 200 360"
            fill="none"
            stroke="#cfd4d9"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "0.4s" }}
          />
          <path
            d="M 200 80 C 270 160, 270 280, 200 360"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.85"
            strokeWidth="1.4"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite_reverse]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />

          {/* Lower inner lens — same comet highlight pass; directions
              mirrored vs. the upper lens so the whole diagram reads as a
              continuous flow up one side and down the other. */}
          <path
            d="M 200 360 C 130 440, 130 560, 200 640"
            fill="none"
            stroke="#cfd4d9"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "1s" }}
          />
          <path
            d="M 200 360 C 130 440, 130 560, 200 640"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.85"
            strokeWidth="1.4"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite_reverse]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />
          <path
            d="M 200 360 C 270 440, 270 560, 200 640"
            fill="none"
            stroke="#cfd4d9"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "1.4s" }}
          />
          <path
            d="M 200 360 C 270 440, 270 560, 200 640"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.85"
            strokeWidth="1.4"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />

          {/* Innermost oval — solid base */}
          <path
            d="M 200 220 C 145 290, 145 430, 200 500"
            fill="none"
            stroke="url(#ic-stroke)"
            strokeOpacity="0.6"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <path
            d="M 200 220 C 255 290, 255 430, 200 500"
            fill="none"
            stroke="url(#ic-stroke)"
            strokeOpacity="0.6"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {/* Innermost oval — comet highlight, opposite direction to outer lens */}
          <path
            d="M 200 220 C 145 290, 145 430, 200 500"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.9"
            strokeWidth="1.6"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite_reverse]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />
          <path
            d="M 200 220 C 255 290, 255 430, 200 500"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.9"
            strokeWidth="1.6"
            strokeLinecap="round"
            pathLength={100}
            className="animate-[innoculus-comet_6s_linear_infinite]"
            style={{ strokeDasharray: "4 100", filter: "url(#ic-soft-glow)" }}
          />

          {/* Interior nodes — silicon grey body, white halo. Each speaks its
              role name when clicked. No navigation; just a quick spoken cue. */}
          {/* Upper interior — The Reckoner */}
          <g
            onClick={() => fireRole("reckoner")}
            onKeyDown={onKeyRole("reckoner")}
            {...hoverProps("reckoner")}
            tabIndex={0}
            role="button"
            aria-label="Speak: The Reckoner"
            data-testid="splash-reckoner"
            style={{ cursor: "pointer", outline: "none" }}
          >
            <circle cx="200" cy="220" r="32" fill="transparent" />
            <circle cx="200" cy="220" r={hovered === "reckoner" ? 28 : 22} fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ transition: "r 280ms ease" }} />
            <circle cx="200" cy="220" r={hovered === "reckoner" ? 7 : 6}
              fill={hovered === "reckoner" ? "#ffffff" : "#e6e9ec"}
              filter="url(#ic-soft-glow)"
              style={{ transition: "r 280ms ease, fill 280ms ease" }} />
          </g>
          {/* Center interior — The Daemon. Click to summon the standalone
              chat surface anchored below the diagram. While the Daemon is
              speaking, halo + core radii are driven imperatively from the
              shared analyser-node amplitude meter — so the orb pulses in
              sync with the spoken word. */}
          <g
            onClick={openDaemonChat}
            onKeyDown={onKeyDaemon}
            {...hoverProps("daemon")}
            tabIndex={0}
            role="button"
            aria-label={
              chatOpen
                ? "Daemon chat is open — click to replay greeting"
                : "Summon the Daemon"
            }
            aria-pressed={chatOpen}
            data-testid="splash-daemon"
            data-speaking={orbSpeaking ? "true" : "false"}
            style={{ cursor: "pointer", outline: "none" }}
          >
            <circle cx="200" cy="360" r="40" fill="transparent" />
            <circle
              ref={daemonHaloRef}
              cx="200"
              cy="360"
              r={26}
              fill="url(#ic-node-glow-soft)"
              opacity={0.55}
              className={
                orbSpeaking
                  ? ""
                  : "animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              }
              style={{
                animationDelay: orbSpeaking ? undefined : "0.6s",
                transition: orbSpeaking ? "none" : "r 280ms ease, opacity 280ms ease",
              }}
            />
            <circle
              ref={daemonCoreRef}
              cx="200"
              cy="360"
              r={7}
              fill={orbSpeaking ? "#ffffff" : hovered === "daemon" ? "#ffffff" : "#f0f3f6"}
              filter="url(#ic-soft-glow)"
              style={{ transition: orbSpeaking ? "none" : "r 280ms ease, fill 280ms ease" }}
            />
          </g>
          {/* Lower interior — The Judge */}
          <g
            onClick={() => fireRole("judge")}
            onKeyDown={onKeyRole("judge")}
            {...hoverProps("judge")}
            tabIndex={0}
            role="button"
            aria-label="Speak: The Judge"
            data-testid="splash-judge"
            style={{ cursor: "pointer", outline: "none" }}
          >
            <circle cx="200" cy="500" r="32" fill="transparent" />
            <circle cx="200" cy="500" r={hovered === "judge" ? 28 : 22} fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "1.2s", transition: "r 280ms ease" }} />
            <circle cx="200" cy="500" r={hovered === "judge" ? 7 : 6}
              fill={hovered === "judge" ? "#ffffff" : "#e6e9ec"}
              filter="url(#ic-soft-glow)"
              style={{ transition: "r 280ms ease, fill 280ms ease" }} />
          </g>
          {/* Bottom node — Tutorial portal */}
          <g
            onClick={handleTutorial}
            onKeyDown={onKeyTutorial}
            {...hoverProps("tutorial")}
            tabIndex={0}
            role="button"
            aria-label="Open tutorial"
            data-testid="splash-tutorial"
            style={{ cursor: "pointer", outline: "none" }}
          >
            {/* Generous transparent hit target */}
            <circle cx="200" cy="660" r="32" fill="transparent" />
            <circle cx="200" cy="660" r={hovered === "tutorial" ? 20 : 14} fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "2.1s", transition: "r 280ms ease" }} />
            <circle cx="200" cy="660" r={hovered === "tutorial" ? 5 : 4}
              fill={hovered === "tutorial" ? "#ffffff" : "#c0c5cb"}
              filter="url(#ic-soft-glow)"
              style={{ transition: "r 280ms ease, fill 280ms ease" }} />
          </g>

          {/* Refractive symmetric shockwave — fires once when a role orb is
              clicked. Three staggered ring fronts; each front is three colored
              rings (cyan / white / magenta) with a small x-offset so the
              expanding edge reads as a chromatic, refractive split. Bumping
              the React `key` on every fire forces a clean replay. */}
          {pulse && (
            <g key={pulse.id} pointerEvents="none" filter="url(#ic-soft-glow)">
              {[0, 200, 400].map((delay) => (
                <g key={delay} style={{ mixBlendMode: "screen" }}>
                  <circle cx={pulse.cx - 3.5} cy={pulse.cy} r="10" fill="none"
                    stroke="#5fd0ff"
                    style={{ animation: `innoculus-shock 1400ms cubic-bezier(0.22,1,0.36,1) ${delay}ms forwards` }} />
                  <circle cx={pulse.cx} cy={pulse.cy} r="10" fill="none"
                    stroke="#ffffff"
                    style={{ animation: `innoculus-shock 1400ms cubic-bezier(0.22,1,0.36,1) ${delay}ms forwards` }} />
                  <circle cx={pulse.cx + 3.5} cy={pulse.cy} r="10" fill="none"
                    stroke="#ff7ac0"
                    style={{ animation: `innoculus-shock 1400ms cubic-bezier(0.22,1,0.36,1) ${delay}ms forwards` }} />
                </g>
              ))}
            </g>
          )}

          {/* TOP NODE — the clickable portal */}
          <g
            onClick={handleEnter}
            onKeyDown={onKey}
            {...hoverProps("innoculus")}
            tabIndex={0}
            role="button"
            aria-label="Enter Innoculus dashboard"
            data-testid="splash-enter"
            style={{ cursor: "pointer", outline: "none" }}
          >
            {/* Generous transparent hit target */}
            <circle cx="200" cy="60" r="44" fill="transparent" />

            {/* Outer halo */}
            <circle cx="200" cy="60" r={hovered === "innoculus" ? 32 : 26} fill="url(#ic-node-glow)"
              style={{ transition: "r 280ms ease, opacity 280ms ease", opacity: hovered === "innoculus" ? 1 : 0.85 }} />
            {/* Pulsing core */}
            <circle cx="200" cy="60" r="9" fill="#ffffff" filter="url(#ic-soft-glow)"
              className="animate-[innoculus-core_2.2s_ease-in-out_infinite]" />
            {/* Crisp dot on top */}
            <circle cx="200" cy="60" r="3" fill="#ffffff" opacity="0.98" />
          </g>
        </svg>
      </div>

      {/* Daemon chat surface — a single unified glass panel that anchors
          below the diagram. The transcript ("sentence bar") sits above a
          hairline divider; the input row beneath shares the same surface
          with no visible borders, so the whole thing reads as one
          continuous aperture rather than two stacked cards. The outer
          glow + border subtly intensify while the Daemon's voice plays. */}
      {chatOpen && (
        <div
          className="relative z-10 mt-8 w-[min(560px,90vw)] rounded-2xl backdrop-blur-md transition-all duration-500"
          style={{
            background:
              "linear-gradient(180deg, rgba(18,18,22,0.72) 0%, rgba(8,8,10,0.78) 100%)",
            border: "1px solid",
            borderColor: orbSpeaking ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.08)",
            boxShadow: orbSpeaking
              ? "0 0 48px rgba(255,255,255,0.14), 0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)"
              : "0 8px 32px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
          }}
          data-testid="daemon-chat-surface"
          role="region"
          aria-label="Daemon chat"
        >
          {/* Close affordance — minimal, ghost-like; sits in the top-right
              corner so it doesn't compete with the transcript. */}
          <button
            type="button"
            onClick={closeDaemonChat}
            aria-label="Close Daemon chat"
            data-testid="button-daemon-close"
            className="absolute top-3 right-3 text-white/30 hover:text-white/80 transition-colors p-1 rounded-full"
          >
            <X className="w-3 h-3" strokeWidth={1.5} />
          </button>

          {/* Transcript ("sentence bar"). aria-live=polite so screen readers
              announce new Daemon utterances. */}
          <div
            className="px-6 pt-6 pb-5"
            data-testid="daemon-sentence-bar"
            data-speaking={orbSpeaking ? "true" : "false"}
          >
            <div
              className="text-[15px] leading-[1.65] text-white/90 whitespace-pre-wrap min-h-[1.65em] font-light tracking-[0.005em] pr-6"
              data-testid="daemon-transcript"
              aria-live="polite"
              aria-atomic="true"
            >
              {chatPending && !transcript ? (
                <span className="inline-flex items-center gap-2.5 text-white/50 italic">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                  The Daemon is gathering itself…
                </span>
              ) : chatError ? (
                <span className="text-red-300/85">
                  The Daemon is silent — {chatError}
                </span>
              ) : transcript ? (
                transcript
              ) : (
                <span className="text-white/35 italic">
                  Speak, and the Daemon will answer.
                </span>
              )}
            </div>
          </div>

          {/* Hairline divider — a single 1px rule that splits the panel into
              voice/transcript above and user input below. */}
          <div className="h-px bg-white/[0.06]" />

          {/* Input row — borderless, surface-flush. The send button is a
              ghost icon at the trailing edge; no chrome beyond a soft
              hover state, in keeping with the minimalist diagram aesthetic. */}
          <div className="flex items-center gap-2 pl-6 pr-3 py-2">
            <textarea
              ref={inputElRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitChatInput();
                }
              }}
              placeholder="Ask the Daemon…"
              disabled={chatPending}
              data-testid="input-splash-daemon-message"
              className="flex-1 min-h-[40px] max-h-[120px] resize-none bg-transparent border-0 px-0 py-2.5 text-[14px] leading-snug text-white/90 placeholder:text-white/30 placeholder:font-light focus:outline-none focus:ring-0 disabled:opacity-50 font-light tracking-[0.005em]"
              rows={1}
            />
            <button
              type="button"
              onClick={submitChatInput}
              disabled={!chatInput.trim() || chatPending}
              data-testid="button-splash-daemon-send"
              className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/[0.06] active:bg-white/[0.10] transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/50"
              aria-label="Send to Daemon"
            >
              {chatPending ? (
                <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
              ) : (
                <Send className="w-3.5 h-3.5" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

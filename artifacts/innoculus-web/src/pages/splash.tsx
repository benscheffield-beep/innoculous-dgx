import { useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";

/**
 * Pre-rendered "Innoculus" voice clips (female + male) decoded once into AudioBuffers
 * so we can fire both through the Web Audio API on the same audio frame. This is
 * sample-accurate, unlike two parallel HTMLAudioElement.play() calls which can
 * drift by tens of milliseconds at the JS layer. Clips are pre-trimmed to remove
 * leading/trailing silence, so the words start in lockstep.
 */
type LoadedVoices = {
  ctx: AudioContext;
  female: AudioBuffer;
  male: AudioBuffer;
};

async function loadVoices(): Promise<LoadedVoices | null> {
  if (typeof window === "undefined") return null;
  const Ctx: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  const base = import.meta.env.BASE_URL ?? "/";
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
    const [femResp, masResp] = await Promise.all([
      fetch(`${base}audio/innoculus-female.mp3`),
      fetch(`${base}audio/innoculus-male.mp3`),
    ]);
    if (!femResp.ok || !masResp.ok) {
      void ctx.close();
      return null;
    }
    const [femBuf, masBuf] = await Promise.all([
      femResp.arrayBuffer(),
      masResp.arrayBuffer(),
    ]);
    const [female, male] = await Promise.all([
      ctx.decodeAudioData(femBuf),
      ctx.decodeAudioData(masBuf),
    ]);
    return { ctx, female, male };
  } catch {
    if (ctx) void ctx.close();
    return null;
  }
}

function speakInnoculus(voices: LoadedVoices | null) {
  if (!voices) return;
  const { ctx, female, male } = voices;
  if (ctx.state === "suspended") void ctx.resume();
  // Stretch the shorter clip so both finish at the same instant.
  const target = Math.max(female.duration, male.duration);
  const playOne = (buf: AudioBuffer, gain: number) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = buf.duration / target;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    return src;
  };
  // Schedule both starts at the exact same audio time — sample-accurate sync.
  const startAt = ctx.currentTime + 0.02;
  playOne(female, 0.85).start(startAt);
  playOne(male, 0.85).start(startAt);
}

export default function Splash() {
  const [, navigate] = useLocation();
  const [hover, setHover] = useState(false);

  const [hoverTutorial, setHoverTutorial] = useState(false);

  const voicesRef = useRef<LoadedVoices | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadVoices().then((v) => {
      if (!v) return;
      // If the splash unmounted before decode finished, the user can't have
      // clicked the orb yet, so the context is unused — close it to avoid
      // accumulating contexts on repeated mounts (Safari has a low limit).
      if (cancelled) {
        void v.ctx.close();
        return;
      }
      voicesRef.current = v;
    });
    // Once playback has started (handleEnter → navigate), Splash unmounts
    // immediately. We deliberately leave that already-playing context open
    // so the audio finishes — the browser reclaims it on page unload.
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnter = () => {
    speakInnoculus(voicesRef.current);
    navigate("/dashboard");
  };
  const handleTutorial = () => navigate("/tutorial");
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

          {/* Upper inner lens — top portal <-> upper node */}
          <path
            d="M 200 80 C 130 160, 130 280, 200 360"
            fill="none"
            stroke="#cfd4d9"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
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

          {/* Lower inner lens */}
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
            d="M 200 360 C 270 440, 270 560, 200 640"
            fill="none"
            stroke="#cfd4d9"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "1.4s" }}
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

          {/* Interior nodes — silicon grey body, white halo */}
          {/* Upper interior */}
          <g>
            <circle cx="200" cy="220" r="22" fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]" />
            <circle cx="200" cy="220" r="6" fill="#e6e9ec" filter="url(#ic-soft-glow)" />
          </g>
          {/* Center interior — the heart of the lens */}
          <g>
            <circle cx="200" cy="360" r="26" fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "0.6s" }} />
            <circle cx="200" cy="360" r="7" fill="#f0f3f6" filter="url(#ic-soft-glow)" />
          </g>
          {/* Lower interior */}
          <g>
            <circle cx="200" cy="500" r="22" fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "1.2s" }} />
            <circle cx="200" cy="500" r="6" fill="#e6e9ec" filter="url(#ic-soft-glow)" />
          </g>
          {/* Bottom node — Tutorial portal */}
          <g
            onClick={handleTutorial}
            onKeyDown={onKeyTutorial}
            onMouseEnter={() => setHoverTutorial(true)}
            onMouseLeave={() => setHoverTutorial(false)}
            tabIndex={0}
            role="button"
            aria-label="Open tutorial"
            data-testid="splash-tutorial"
            style={{ cursor: "pointer", outline: "none" }}
          >
            {/* Generous transparent hit target */}
            <circle cx="200" cy="660" r="32" fill="transparent" />
            <circle cx="200" cy="660" r={hoverTutorial ? 20 : 14} fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "2.1s", transition: "r 280ms ease" }} />
            <circle cx="200" cy="660" r={hoverTutorial ? 5 : 4}
              fill={hoverTutorial ? "#ffffff" : "#c0c5cb"}
              filter="url(#ic-soft-glow)"
              style={{ transition: "r 280ms ease, fill 280ms ease" }} />
          </g>

          {/* TOP NODE — the clickable portal */}
          <g
            onClick={handleEnter}
            onKeyDown={onKey}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            tabIndex={0}
            role="button"
            aria-label="Enter Innoculus dashboard"
            data-testid="splash-enter"
            style={{ cursor: "pointer", outline: "none" }}
          >
            {/* White radiating concentric rings — only on the top node */}
            <circle cx="200" cy="60" r="22" fill="none" stroke="#ffffff"
              strokeWidth="1" strokeOpacity="0.7"
              className="animate-[innoculus-radiate_3s_ease-out_infinite]" />
            <circle cx="200" cy="60" r="22" fill="none" stroke="#ffffff"
              strokeWidth="1" strokeOpacity="0.7"
              className="animate-[innoculus-radiate_3s_ease-out_infinite]"
              style={{ animationDelay: "1s" }} />
            <circle cx="200" cy="60" r="22" fill="none" stroke="#ffffff"
              strokeWidth="1" strokeOpacity="0.7"
              className="animate-[innoculus-radiate_3s_ease-out_infinite]"
              style={{ animationDelay: "2s" }} />

            {/* Generous transparent hit target */}
            <circle cx="200" cy="60" r="44" fill="transparent" />

            {/* Outer halo */}
            <circle cx="200" cy="60" r={hover ? 32 : 26} fill="url(#ic-node-glow)"
              style={{ transition: "r 280ms ease, opacity 280ms ease", opacity: hover ? 1 : 0.85 }} />
            {/* Pulsing core */}
            <circle cx="200" cy="60" r="9" fill="#ffffff" filter="url(#ic-soft-glow)"
              className="animate-[innoculus-core_2.2s_ease-in-out_infinite]" />
            {/* Crisp dot on top */}
            <circle cx="200" cy="60" r="3" fill="#ffffff" opacity="0.98" />
          </g>
        </svg>
      </div>
    </div>
  );
}

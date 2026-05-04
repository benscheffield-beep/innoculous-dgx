import { useLocation } from "wouter";
import { useState } from "react";

export default function Splash() {
  const [, navigate] = useLocation();
  const [hover, setHover] = useState(false);

  const handleEnter = () => navigate("/dashboard");
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleEnter();
    }
  };

  return (
    <div className="relative min-h-[100dvh] w-full bg-background text-foreground overflow-hidden flex flex-col items-center justify-center font-sans">
      {/* Ambient grid backdrop */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.18]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, hsla(var(--primary)/0.35) 1px, transparent 0)",
          backgroundSize: "32px 32px",
        }}
      />
      {/* Soft vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 0%, transparent 40%, hsl(var(--background)) 100%)",
        }}
      />

      {/* Wordmark — corner so it doesn't crowd the Manager node */}
      <div className="absolute top-6 left-6 flex items-center gap-2 text-primary z-10">
        <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_10px_hsla(185,81%,54%,0.9)] animate-[innoculus-blink_2.4s_ease-in-out_infinite]" />
        <span className="font-bold tracking-[0.35em] text-[11px] uppercase">Innoculus</span>
      </div>

      {/* Diagram */}
      <div className="relative z-10">
        <svg
          viewBox="0 0 400 720"
          className="w-[280px] sm:w-[340px] md:w-[400px] h-auto"
          aria-label="Innoculus pipeline diagram. Tap the top node to enter."
        >
          <defs>
            <radialGradient id="ic-node-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="hsl(185, 81%, 54%)" stopOpacity="0.95" />
              <stop offset="40%" stopColor="hsl(185, 81%, 54%)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="hsl(185, 81%, 54%)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="ic-node-glow-soft" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="hsl(190, 75%, 65%)" stopOpacity="0.85" />
              <stop offset="55%" stopColor="hsl(190, 75%, 65%)" stopOpacity="0.4" />
              <stop offset="100%" stopColor="hsl(190, 75%, 65%)" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="ic-stroke" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="hsl(185, 81%, 70%)" stopOpacity="0.95" />
              <stop offset="50%" stopColor="hsl(185, 81%, 54%)" stopOpacity="0.85" />
              <stop offset="100%" stopColor="hsl(190, 65%, 40%)" stopOpacity="0.7" />
            </linearGradient>
            <filter id="ic-soft-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Outer lens (the algorithm enclosure) */}
          <path
            d="M 200 60 C 60 220, 60 500, 200 660"
            fill="none"
            stroke="url(#ic-stroke)"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="animate-[innoculus-flow_8s_linear_infinite]"
            style={{ strokeDasharray: "6 10" }}
          />
          <path
            d="M 200 60 C 340 220, 340 500, 200 660"
            fill="none"
            stroke="url(#ic-stroke)"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="animate-[innoculus-flow_8s_linear_infinite_reverse]"
            style={{ strokeDasharray: "6 10" }}
          />

          {/* Vertical telemetry spine */}
          <line
            x1="200" y1="60" x2="200" y2="660"
            stroke="hsl(185, 81%, 54%)"
            strokeOpacity="0.18"
            strokeWidth="1"
          />

          {/* Upper inner lens — Manager <-> Editor */}
          <path
            d="M 200 80 C 130 160, 130 280, 200 360"
            fill="none"
            stroke="hsl(185, 81%, 60%)"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
          />
          <path
            d="M 200 80 C 270 160, 270 280, 200 360"
            fill="none"
            stroke="hsl(185, 81%, 60%)"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "0.4s" }}
          />

          {/* Lower inner lens — Verifier <-> Output */}
          <path
            d="M 200 360 C 130 440, 130 560, 200 640"
            fill="none"
            stroke="hsl(190, 75%, 65%)"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "1s" }}
          />
          <path
            d="M 200 360 C 270 440, 270 560, 200 640"
            fill="none"
            stroke="hsl(190, 75%, 65%)"
            strokeOpacity="0.55"
            strokeWidth="1.2"
            className="animate-[innoculus-pulse-stroke_3.6s_ease-in-out_infinite]"
            style={{ animationDelay: "1.4s" }}
          />

          {/* Crossing telemetry curves — Editor <-> Verifier diagonal */}
          <path
            d="M 200 220 C 145 290, 145 430, 200 500"
            fill="none"
            stroke="hsl(185, 81%, 54%)"
            strokeOpacity="0.35"
            strokeWidth="1"
          />
          <path
            d="M 200 220 C 255 290, 255 430, 200 500"
            fill="none"
            stroke="hsl(185, 81%, 54%)"
            strokeOpacity="0.35"
            strokeWidth="1"
          />

          {/* Interior nodes */}
          {/* Editor */}
          <g>
            <circle cx="200" cy="220" r="22" fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]" />
            <circle cx="200" cy="220" r="6" fill="hsl(185, 81%, 70%)" filter="url(#ic-soft-glow)" />
            <text x="218" y="225" fill="hsl(0,0%,80%)" fontFamily="'Space Mono', monospace"
              fontSize="11" letterSpacing="2">EDITOR</text>
          </g>
          {/* Verifier */}
          <g>
            <circle cx="200" cy="500" r="22" fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "1.2s" }} />
            <circle cx="200" cy="500" r="6" fill="hsl(190, 75%, 70%)" filter="url(#ic-soft-glow)" />
            <text x="218" y="505" fill="hsl(0,0%,80%)" fontFamily="'Space Mono', monospace"
              fontSize="11" letterSpacing="2">VERIFIER</text>
          </g>
          {/* Bottom — Artifact */}
          <g>
            <circle cx="200" cy="660" r="14" fill="url(#ic-node-glow-soft)"
              className="animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
              style={{ animationDelay: "2.1s" }} />
            <circle cx="200" cy="660" r="4" fill="hsl(190, 60%, 60%)" filter="url(#ic-soft-glow)" />
            <text x="200" y="695" textAnchor="middle" fill="hsl(0,0%,55%)" fontFamily="'Space Mono', monospace"
              fontSize="10" letterSpacing="2">ARTIFACT</text>
          </g>

          {/* TOP NODE — the clickable Manager / portal */}
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
            {/* Radiating concentric rings — only on the top node */}
            <circle cx="200" cy="60" r="22" fill="none" stroke="hsl(185, 81%, 60%)"
              strokeWidth="1" strokeOpacity="0.7"
              className="animate-[innoculus-radiate_3s_ease-out_infinite]" />
            <circle cx="200" cy="60" r="22" fill="none" stroke="hsl(185, 81%, 60%)"
              strokeWidth="1" strokeOpacity="0.7"
              className="animate-[innoculus-radiate_3s_ease-out_infinite]"
              style={{ animationDelay: "1s" }} />
            <circle cx="200" cy="60" r="22" fill="none" stroke="hsl(185, 81%, 60%)"
              strokeWidth="1" strokeOpacity="0.7"
              className="animate-[innoculus-radiate_3s_ease-out_infinite]"
              style={{ animationDelay: "2s" }} />

            {/* Generous transparent hit target */}
            <circle cx="200" cy="60" r="44" fill="transparent" />

            {/* Outer halo */}
            <circle cx="200" cy="60" r={hover ? 32 : 26} fill="url(#ic-node-glow)"
              style={{ transition: "r 280ms ease, opacity 280ms ease", opacity: hover ? 1 : 0.85 }} />
            {/* Pulsing core */}
            <circle cx="200" cy="60" r="9" fill="hsl(185, 90%, 75%)" filter="url(#ic-soft-glow)"
              className="animate-[innoculus-core_2.2s_ease-in-out_infinite]" />
            {/* Crisp dot on top */}
            <circle cx="200" cy="60" r="3" fill="white" opacity="0.95" />

            {/* Manager label */}
            <text x="200" y="22" textAnchor="middle"
              fill={hover ? "hsl(185, 90%, 80%)" : "hsl(185, 70%, 65%)"}
              fontFamily="'Space Mono', monospace"
              fontSize="11" letterSpacing="3"
              style={{ transition: "fill 200ms ease" }}>
              MANAGER
            </text>
          </g>
        </svg>

        {/* Tap hint */}
        <div className="mt-6 flex flex-col items-center gap-1 text-center">
          <p
            className={`font-mono text-xs uppercase tracking-[0.4em] transition-colors duration-300 ${
              hover ? "text-primary" : "text-muted-foreground"
            }`}
          >
            Tap Manager to enter
          </p>
          <p className="font-mono text-[10px] text-muted-foreground/60 tracking-widest">
            spectral self-force pipeline
          </p>
        </div>
      </div>

      {/* Bottom legend */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/70 z-10">
        <span className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          agent
        </span>
        <span className="flex items-center gap-2">
          <span className="w-3 h-px bg-primary/60" />
          telemetry
        </span>
        <span className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full border border-primary/40" />
          algorithm
        </span>
      </div>
    </div>
  );
}

import { useLocation } from "wouter";
import { useState } from "react";

export default function Splash() {
  const [, navigate] = useLocation();
  const [hover, setHover] = useState(false);

  const [hoverTutorial, setHoverTutorial] = useState(false);

  const handleEnter = () => navigate("/dashboard");
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

          {/* Crossing telemetry curves */}
          <path
            d="M 200 220 C 145 290, 145 430, 200 500"
            fill="none"
            stroke="#b6bbc1"
            strokeOpacity="0.4"
            strokeWidth="1"
          />
          <path
            d="M 200 220 C 255 290, 255 430, 200 500"
            fill="none"
            stroke="#b6bbc1"
            strokeOpacity="0.4"
            strokeWidth="1"
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

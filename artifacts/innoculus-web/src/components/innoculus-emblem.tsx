export function InnoculusEmblem({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 56"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <defs>
        <radialGradient id="ie-top-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ie-node-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Outer lens — silicon grey */}
      <path
        d="M 20 6 C 4 18, 4 38, 20 50"
        stroke="#a8aeb4"
        strokeOpacity="0.8"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeDasharray="2 2.5"
      />
      <path
        d="M 20 6 C 36 18, 36 38, 20 50"
        stroke="#a8aeb4"
        strokeOpacity="0.8"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeDasharray="2 2.5"
      />

      {/* Inner crossing curves */}
      <path
        d="M 20 14 C 12 22, 12 34, 20 42"
        stroke="#cfd4d9"
        strokeOpacity="0.55"
        strokeWidth="0.7"
      />
      <path
        d="M 20 14 C 28 22, 28 34, 20 42"
        stroke="#cfd4d9"
        strokeOpacity="0.55"
        strokeWidth="0.7"
      />

      {/* Middle node */}
      <circle cx="20" cy="28" r="4" fill="url(#ie-node-glow)" />
      <circle cx="20" cy="28" r="1.3" fill="#e6e9ec" />

      {/* Bottom node */}
      <circle cx="20" cy="50" r="3" fill="url(#ie-node-glow)" />
      <circle cx="20" cy="50" r="1" fill="#c0c5cb" />

      {/* Top portal — pulsing white */}
      <circle
        cx="20"
        cy="6"
        r="6"
        fill="url(#ie-top-glow)"
        className="animate-[innoculus-core_2.2s_ease-in-out_infinite]"
      />
      <circle cx="20" cy="6" r="1.6" fill="#ffffff" />
    </svg>
  );
}

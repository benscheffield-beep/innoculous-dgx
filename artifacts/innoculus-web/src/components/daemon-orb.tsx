import { memo, useEffect, useRef } from "react";

interface DaemonOrbProps {
  /** Per-frame amplitude subscription. Must be a stable reference (the
   *  hook returns a `useCallback`-wrapped fn) so memoization holds and the
   *  effect doesn't unsubscribe/resubscribe on every parent render. */
  subscribeLevel: (cb: (level: number) => void) => () => void;
  /** Whether the daemon voice is currently playing. */
  isSpeaking: boolean;
  /** Pixel size of the rendered SVG square. Defaults to 72. */
  size?: number;
}

/**
 * Compact daemon orb — the same visual language as the centre "Daemon" node
 * on the splash page (silicon halo + bright core, soft glow filter), shrunk
 * for the chat header. At rest it gently breathes via CSS; while the daemon
 * voice is playing it pulses in real time with the audio amplitude.
 *
 * Performance: the per-frame amplitude updates from `subscribeLevel` are
 * applied imperatively to the SVG circle elements via refs, so the
 * surrounding chat tree never re-renders during playback. The component
 * is wrapped in `memo` and accepts only stable props (a useCallback
 * subscriber and the primitive `isSpeaking` flag), so React only
 * re-renders it when `isSpeaking` flips — which toggles the idle CSS
 * breathing animation off/on.
 */
function DaemonOrbImpl({ subscribeLevel, isSpeaking, size = 72 }: DaemonOrbProps) {
  const haloRef = useRef<SVGCircleElement>(null);
  const coreRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const apply = (level: number) => {
      const halo = haloRef.current;
      const core = coreRef.current;
      // Halo: 22 (idle) → 38 (peak). Core: 6 → 11. Opacity ramps gently with
      // level so quiet syllables still register as a perceptible bloom.
      const haloR = 22 + level * 16;
      const coreR = 6 + level * 5;
      const haloOpacity = 0.5 + level * 0.5;
      if (halo) {
        halo.setAttribute("r", String(haloR));
        halo.setAttribute("opacity", String(haloOpacity));
      }
      if (core) {
        core.setAttribute("r", String(coreR));
      }
    };
    return subscribeLevel(apply);
  }, [subscribeLevel]);

  const speaking = isSpeaking;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      data-testid="daemon-orb"
      data-speaking={speaking ? "true" : "false"}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <defs>
        <radialGradient id="daemon-orb-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <filter id="daemon-orb-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Halo — CSS breathing while idle, JS-driven radius while speaking. */}
      <circle
        ref={haloRef}
        cx={50}
        cy={50}
        r={22}
        fill="url(#daemon-orb-glow)"
        opacity={0.5}
        className={
          speaking ? "" : "animate-[innoculus-breathe_4.2s_ease-in-out_infinite]"
        }
        style={{ transition: speaking ? "none" : "r 280ms ease, opacity 280ms ease" }}
      />
      {/* Core — bright dot, brightens with response amplitude. */}
      <circle
        ref={coreRef}
        cx={50}
        cy={50}
        r={6}
        fill={speaking ? "#ffffff" : "#f0f3f6"}
        filter="url(#daemon-orb-soft)"
        style={{ transition: speaking ? "none" : "r 280ms ease, fill 280ms ease" }}
      />
    </svg>
  );
}

export const DaemonOrb = memo(DaemonOrbImpl);

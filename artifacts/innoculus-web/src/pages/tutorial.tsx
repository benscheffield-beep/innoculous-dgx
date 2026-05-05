import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowRight, Brain, Edit3, ShieldCheck, FileBox, BarChart3, Clock } from "lucide-react";
import { InnoculusEmblem } from "@/components/innoculus-emblem";

type MetalTint = "lead" | "copper" | "gold" | "silver";

const METAL_PALETTE: Record<MetalTint, { color: string; bg: string; border: string; glow: string }> = {
  lead:   { color: "#8a92a0", bg: "rgba(138,146,160,0.10)", border: "rgba(138,146,160,0.28)", glow: "rgba(138,146,160,0.35)" },
  copper: { color: "#c87a3a", bg: "rgba(200,122,58,0.10)",  border: "rgba(200,122,58,0.32)",  glow: "rgba(200,122,58,0.40)"  },
  gold:   { color: "#d4af37", bg: "rgba(212,175,55,0.10)",  border: "rgba(212,175,55,0.32)",  glow: "rgba(212,175,55,0.45)"  },
  silver: { color: "#cfd3da", bg: "rgba(207,211,218,0.10)", border: "rgba(207,211,218,0.32)", glow: "rgba(207,211,218,0.40)" },
};

function PipelineNode({
  icon: Icon,
  name,
  role,
  tint,
}: {
  icon: any;
  name: string;
  role: string;
  tint: MetalTint;
}) {
  const p = METAL_PALETTE[tint];
  return (
    <div className="flex flex-col items-center text-center gap-2 flex-1 min-w-0">
      <div
        className="w-12 h-12 rounded-full border flex items-center justify-center"
        style={{
          backgroundColor: p.bg,
          borderColor: p.border,
          color: p.color,
          boxShadow: `0 0 18px -6px ${p.glow}`,
        }}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div className="font-semibold text-sm tracking-wide uppercase" style={{ color: p.color }}>{name}</div>
      <div className="text-xs text-muted-foreground font-mono">{role}</div>
    </div>
  );
}

function Step({ num, title, children }: { num: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="shrink-0 w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-mono text-sm">
        {num}
      </div>
      <div className="flex-1 min-w-0 pt-1">
        <h3 className="font-semibold text-foreground mb-1">{title}</h3>
        <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export default function Tutorial() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-4">
        <InnoculusEmblem className="w-8 h-12" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Tutorial</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            Learning Innoculation
          </p>
        </div>
      </div>

      {/* Pipeline */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>The Innoculum</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4 md:gap-2">
            <PipelineNode icon={Brain} name="Reckoner" role="exploration" tint="lead" />
            <ArrowRight className="hidden md:block w-5 h-5 text-muted-foreground/60 shrink-0" />
            <PipelineNode icon={Edit3} name="Daemon" role="computation" tint="copper" />
            <ArrowRight className="hidden md:block w-5 h-5 text-muted-foreground/60 shrink-0" />
            <PipelineNode icon={ShieldCheck} name="Judge" role="validation" tint="gold" />
            <ArrowRight className="hidden md:block w-5 h-5 text-muted-foreground/60 shrink-0" />
            <PipelineNode icon={FileBox} name="Relic" role="preservation" tint="silver" />
          </div>

          <div className="mt-8 grid gap-6 md:grid-cols-2">
            <div>
              <h4 className="font-semibold text-sm tracking-wide uppercase text-foreground mb-2">
                Reckoner
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The Reckoner receives the innoculant specification, plans the strategy, and dispatches
                work to the Daemon. It is the only operator-facing entry point — the portal
                you tap from the splash screen.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-sm tracking-wide uppercase text-foreground mb-2">
                Daemon
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The Daemon performs the spectral self-force computations, evaluating
                cutoff sweeps, and producing raw output.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-sm tracking-wide uppercase text-foreground mb-2">
                Judge
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The Judge validates the Daemon's output against quality gates: closed-form
                residuals, Mercer slope thresholds, Warburg <span className="font-mono">ν</span>{" "}
                bounds, truncation error, and policy compliance.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-sm tracking-wide uppercase text-foreground mb-2">
                Relic
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The verified result is sealed as a Relic — an immutable, queryable record
                with diagnostics, payload, and verdict attached.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Innoculation phases */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Innoculation</CardTitle>
          <CardDescription>
            One run, two phases. Each innoculation executes both phases in parallel and seals
            the merged result as a single relic.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="p-4 rounded-md bg-black/30 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              <h4 className="font-semibold text-sm uppercase tracking-wide">Spectral phase</h4>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Numerical self-force evaluation at the configured kernel and truncation. Produces
              residuals, slopes, and a sub-verdict.
            </p>
          </div>
          <div className="p-4 rounded-md bg-black/30 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-primary" />
              <h4 className="font-semibold text-sm uppercase tracking-wide">Speculative phase</h4>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Knowledge-cutoff trace probing the target model month-by-month and fitting a
              changepoint to estimate its effective cutoff date.
            </p>
          </div>
          <div className="md:col-span-2 p-4 rounded-md bg-primary/5 border border-primary/20">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-4 h-4 text-primary" />
              <h4 className="font-semibold text-sm uppercase tracking-wide text-primary">Daemon chat</h4>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Once a relic is sealed, the innoculant detail page exposes a Daemon — a model
              persona conditioned on the relic's spectral and speculative outputs. Ask it
              questions to explore the run; the conversation is ephemeral and never stored.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Verdicts */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Verdicts</CardTitle>
          <CardDescription>The qualitative status of relics.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 mt-0.5">
              Complete
            </Badge>
            <p className="text-sm text-muted-foreground leading-relaxed flex-1">
              All checks passed. The relic is trustworthy and ready for downstream use.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 mt-0.5">
              Intermediate
            </Badge>
            <p className="text-sm text-muted-foreground leading-relaxed flex-1">
              The result is usable but one or more soft thresholds were crossed. Inspect
              diagnostics before relying on it.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 mt-0.5">
              Failed
            </Badge>
            <p className="text-sm text-muted-foreground leading-relaxed flex-1">
              A hard check failed. The relic is not trustworthy. Review the failure
              and retry from the job detail page.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Quick start */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Elementary Innoculation</CardTitle>
          <CardDescription>Run your first innoculant in three steps.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Step num="1" title="Initiate">
            Go to{" "}
            <Link href="/submit" className="text-primary hover:underline inline-flex items-center gap-1">
              <span className="inline-flex items-center justify-center w-3 h-3 text-xs leading-none font-serif">Θ</span> Initiate Innoculation
            </Link>{" "}
            and supply your probes (question, expected answer, date), the target and
            judge models, and the latency profile. A single submission launches both
            the Spectral and Speculative phases — kernel and tuning are sealed at
            safe defaults.
          </Step>
          <Step num="2" title="Observe">
            The innoculation appears under{" "}
            <Link href="/jobs" className="text-primary hover:underline inline-flex items-center gap-1">
              <span className="inline-flex items-center justify-center w-3 h-3 text-xs leading-none font-serif">Σ</span> All Innoculations
            </Link>
            . Click any row to watch its live status — Queued, Daemon Running, Judging,
            then a unified verdict with per-phase sub-verdicts.
          </Step>
          <Step num="3" title="Retrieve & converse">
            On the innoculant detail page you get the unified verdict, the merged relic, the
            full diagnostic table, and a Daemon chat panel — a model persona conditioned on
            the relic. Toggle <span className="font-mono text-foreground">Operator Mode</span>{" "}
            in the sidebar to reveal advanced metrics.
          </Step>
        </CardContent>
      </Card>

    </div>
  );
}

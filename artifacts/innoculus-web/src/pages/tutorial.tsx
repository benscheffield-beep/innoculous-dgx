import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowRight, Brain, Edit3, ShieldCheck, FileBox, Play, List, BarChart3, Clock } from "lucide-react";
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
          <CardDescription>
            Every innoculant flows through four roles. Each role hands its output to the next.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4 md:gap-2">
            <PipelineNode icon={Brain} name="Reckoner" role="orchestrates" tint="lead" />
            <ArrowRight className="hidden md:block w-5 h-5 text-muted-foreground/60 shrink-0" />
            <PipelineNode icon={Edit3} name="Daemon" role="computes" tint="copper" />
            <ArrowRight className="hidden md:block w-5 h-5 text-muted-foreground/60 shrink-0" />
            <PipelineNode icon={ShieldCheck} name="Judge" role="checks" tint="gold" />
            <ArrowRight className="hidden md:block w-5 h-5 text-muted-foreground/60 shrink-0" />
            <PipelineNode icon={FileBox} name="Relic" role="emits" tint="silver" />
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

      {/* Innoculants */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Innoculants</CardTitle>
          <CardDescription>A discrete or continuous innoculation to execute.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="p-4 rounded-md bg-black/30 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              <h4 className="font-semibold text-sm uppercase tracking-wide">Spectral</h4>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A single spectral self-force evaluation at a fixed configuration. Returns
              residual, slope, and a verdict.
            </p>
          </div>
          <div className="p-4 rounded-md bg-black/30 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-primary" />
              <h4 className="font-semibold text-sm uppercase tracking-wide">Speculative</h4>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A sweep across cutoff values, producing a trace that lets you visualize
              convergence and locate the elbow.
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
          <CardTitle>Quick Start</CardTitle>
          <CardDescription>Run your first innoculant in three steps.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Step num="1" title="Initiate">
            Go to{" "}
            <Link href="/submit" className="text-primary hover:underline inline-flex items-center gap-1">
              <Play className="w-3 h-3" /> Initiate Innoculants
            </Link>{" "}
            and pick a tab — Spectral for a single evaluation, Speculative for a sweep.
            Fill the form and submit.
          </Step>
          <Step num="2" title="Observe">
            The innoculant appears under{" "}
            <Link href="/jobs" className="text-primary hover:underline inline-flex items-center gap-1">
              <List className="w-3 h-3" /> All Innoculations
            </Link>
            . Click any row to see its live status — Queued, Daemon Running, Judging,
            then a final verdict.
          </Step>
          <Step num="3" title="Retrieve">
            On the innoculant detail page you get the verdict, the relic payload, and the full
            diagnostic table. Toggle <span className="font-mono text-foreground">Operator Mode</span>{" "}
            in the sidebar to reveal advanced metrics like the Warburg trio, truncation
            error, and policy fields.
          </Step>
        </CardContent>
      </Card>

      {/* Modes */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Use vs Op</CardTitle>
          <CardDescription>Toggle in the sidebar.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="p-4 rounded-md bg-black/30 border border-white/5">
            <h4 className="font-semibold text-sm uppercase tracking-wide mb-2">User</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Surfaces verdicts and prose explanations. Hides truncation, latency,
              precision, and policy fields.
            </p>
          </div>
          <div className="p-4 rounded-md bg-black/30 border border-white/5">
            <h4 className="font-semibold text-sm uppercase tracking-wide mb-2">Operator</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Reveals every metric the Judge emits, including the Warburg trio
              (residual, slope, ν), truncation error, and policy decisions.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

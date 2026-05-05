import { useParams, Link } from "wouter";
import { useGetJob, getGetJobQueryKey, useRetryJob, getListJobsQueryKey, getGetJobStatsQueryKey, CutoffArtifactPayload, NumericalArtifactPayload } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMode } from "@/lib/mode-context";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ArrowLeft, Copy, RotateCw, AlertTriangle, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'complete': return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Complete</Badge>;
    case 'complete_with_warnings': return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Intermediate</Badge>;
    case 'failed': return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">Failed</Badge>;
    case 'queued': return <Badge variant="outline" className="bg-muted text-muted-foreground border-white/10">Queued</Badge>;
    default: return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 animate-pulse">Running</Badge>;
  }
}

export default function JobDetail() {
  const params = useParams();
  const id = params.id as string;
  const { mode } = useMode();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDev = mode === "developer";

  const { data: jobInfo, isLoading } = useGetJob(id, {
    query: {
      enabled: !!id,
      queryKey: getGetJobQueryKey(id),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return (status === "queued" || status === "editor_running" || status === "verifying") ? 2500 : false;
      }
    }
  });

  const retryJob = useRetryJob();

  const handleRetry = () => {
    retryJob.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Innoculant retry initiated" });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobStatsQueryKey() });
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ title: "Retry failed", description: message, variant: "destructive" });
      }
    });
  };

  const copyId = () => {
    navigator.clipboard.writeText(id);
    toast({ title: "ID copied to clipboard" });
  };

  if (isLoading) {
    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
        <Skeleton className="h-12 w-1/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!jobInfo) {
    return (
      <div className="space-y-6 max-w-5xl mx-auto flex flex-col items-center justify-center min-h-[50vh]">
        <XCircle className="w-12 h-12 text-muted-foreground" />
        <h2 className="text-2xl font-bold">Innoculant not found</h2>
        <Link href="/jobs" className="text-primary hover:underline">Return to innoculants</Link>
      </div>
    );
  }

  const { artifact, diagnostics, ...job } = jobInfo;
  
  const stepIndex = 
    job.status === "queued" ? 0 :
    job.status === "editor_running" ? 1 :
    job.status === "verifying" ? 2 :
    3;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <Link href="/jobs" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors mb-2">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to innoculants
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight font-mono break-all" data-testid="text-job-id">{job.id}</h1>
            <Button variant="ghost" size="icon" onClick={copyId} data-testid="button-copy-id" className="text-muted-foreground">
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <div data-testid="status-job">
              <StatusBadge status={job.status} />
            </div>
            <Badge variant="outline" className="uppercase font-mono tracking-wider">{job.kind.replace('_', ' ')}</Badge>
            <span className="text-xs text-muted-foreground font-mono"><Clock className="inline w-3 h-3 mr-1"/>{new Date(job.created_at).toLocaleString()}</span>
          </div>
        </div>
        
        {(job.status === "failed" || job.status === "complete_with_warnings") && (
          <Button variant="outline" onClick={handleRetry} disabled={retryJob.isPending} data-testid="button-retry-job" className="border-white/10 shrink-0">
            {retryJob.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCw className="w-4 h-4 mr-2" />}
            Retry Innoculant
          </Button>
        )}
      </div>

      {/* Stepper */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="flex items-center justify-between relative">
            <div className="absolute left-0 top-1/2 w-full h-0.5 bg-white/5 -z-10 -translate-y-1/2"></div>
            
            {["queued", "editor", "verifying", "complete"].map((step, i) => {
              const active = i <= stepIndex;
              const failedVerifying = job.status === "failed" && i === 2;
              return (
                <div key={step} className="flex flex-col items-center gap-2 bg-card/80 px-2" data-testid={`step-${step}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors ${
                    failedVerifying ? 'bg-destructive/20 border-destructive text-destructive' :
                    active ? 'bg-primary/20 border-primary text-primary' : 'bg-background border-white/10 text-muted-foreground'
                  }`}>
                    {failedVerifying ? <XCircle className="w-4 h-4" /> : active ? <CheckCircle2 className="w-4 h-4" /> : <div className="w-2 h-2 rounded-full bg-current" />}
                  </div>
                  <span className={`text-xs uppercase font-mono tracking-wider ${active ? (failedVerifying ? 'text-destructive' : 'text-primary') : 'text-muted-foreground'}`}>
                    {step}
                  </span>
                </div>
              );
            })}
          </div>
          {job.retry_count > 0 && (
            <div className="text-center mt-4 text-xs text-yellow-500 font-mono">
              Retry attempt #{job.retry_count}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Diagnostics */}
      {diagnostics && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold tracking-tight">Diagnostics</h3>
          
          <Card className={`border-white/5 backdrop-blur-sm ${
            diagnostics.verdict === 'pass' ? 'bg-emerald-500/5 border-emerald-500/20' :
            diagnostics.verdict === 'warn' ? 'bg-yellow-500/5 border-yellow-500/20' :
            'bg-destructive/5 border-destructive/20'
          }`}>
            <CardContent className="p-4 flex items-start gap-3">
              {diagnostics.verdict === 'pass' ? <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" /> :
               diagnostics.verdict === 'warn' ? <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 shrink-0" /> :
               <XCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />}
              <div>
                <p className="font-medium text-foreground" data-testid="text-verdict">
                  {diagnostics.verdict === 'pass' ? 'This run looks healthy. All checks passed.' :
                   diagnostics.verdict === 'warn' ? 'We caught some warnings. Review them below.' :
                   'This run failed verification. See the issues below.'}
                </p>
              </div>
            </CardContent>
          </Card>

          {isDev && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Spectral Radius</div><div className="font-mono" data-testid="metric-spectral-radius">{diagnostics.spectral_radius.toFixed(4)}</div></CardContent></Card>
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Cond(I - G)</div><div className="font-mono" data-testid="metric-cond">{diagnostics.cond_i_minus_g.toExponential(3)}</div></CardContent></Card>
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Dual Trunc Err</div><div className="font-mono" data-testid="metric-dual-err">{diagnostics.dual_truncation_error.toExponential(3)}</div></CardContent></Card>
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Spectral Tail Err</div><div className="font-mono" data-testid="metric-tail-err">{diagnostics.spectral_tail_error.toExponential(3)}</div></CardContent></Card>
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Closed-Form Res</div><div className="font-mono" data-testid="metric-residual">{diagnostics.closed_form_residual != null ? diagnostics.closed_form_residual.toExponential(3) : "—"}</div></CardContent></Card>
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Mercer Slope</div><div className="font-mono" data-testid="metric-mercer">{diagnostics.mercer_slope != null ? diagnostics.mercer_slope.toFixed(4) : "—"}</div></CardContent></Card>
              <Card className="bg-card/50 border-white/5"><CardContent className="p-4"><div className="text-xs text-muted-foreground uppercase mb-1">Warburg ν</div><div className="font-mono" data-testid="metric-warburg">{diagnostics.warburg_nu != null ? diagnostics.warburg_nu.toFixed(4) : "—"}</div></CardContent></Card>
            </div>
          )}

          {diagnostics.issues.length > 0 && (
            <div className="space-y-3">
              {diagnostics.issues.map((issue, idx) => (
                <Card key={idx} className="bg-card/50 border-white/5" data-testid={`card-issue-${issue.check_id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className={issue.severity === 'fail' ? 'border-destructive text-destructive' : 'border-yellow-500 text-yellow-500'}>
                          {issue.severity.toUpperCase()}
                        </Badge>
                        <span className="font-mono text-xs text-muted-foreground">{issue.check_id}</span>
                      </div>
                    </div>
                    <p className="text-sm font-medium mb-1">{issue.message}</p>
                    <p className="text-sm text-muted-foreground">{issue.remediation}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Artifact Viewer */}
      {artifact && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold tracking-tight">Artifact</h3>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-white/10 font-mono">v{artifact.version}</Badge>
              <Badge variant="outline" className="border-white/10 font-mono" title={artifact.hash}>{artifact.hash.substring(0,8)}...{artifact.hash.substring(artifact.hash.length-8)}</Badge>
              {artifact.signed_proof && <Badge variant="outline" className="border-primary/20 text-primary bg-primary/10">Signed</Badge>}
            </div>
          </div>

          <Card className="bg-card/50 border-white/5 backdrop-blur-sm overflow-hidden">
            {job.kind === "numerical" ? (
              <CardContent className="p-0">
                {!isDev ? (
                  <div className="p-6">
                    <p className="text-muted-foreground">Innoculum produced an artifact at version {artifact.version}.</p>
                  </div>
                ) : (
                  <Tabs defaultValue="raw" className="w-full">
                    <TabsList className="w-full justify-start rounded-none border-b border-white/5 bg-black/20 p-0 h-auto">
                      <TabsTrigger value="raw" className="rounded-none data-[state=active]:bg-card/50 py-3">Raw JSON</TabsTrigger>
                    </TabsList>
                    <TabsContent value="raw" className="p-4 m-0">
                      <pre className="text-xs font-mono bg-black/40 p-4 rounded-md overflow-x-auto text-muted-foreground max-h-[500px]">
                        {JSON.stringify(artifact.payload, null, 2)}
                      </pre>
                    </TabsContent>
                  </Tabs>
                )}
              </CardContent>
            ) : (
              <CardContent className="p-6 space-y-8">
                {/* Cutoff Trace specific UI */}
                {(() => {
                  const payload = artifact.payload as CutoffArtifactPayload;
                  return (
                    <>
                      <div className="flex flex-col items-center justify-center p-8 bg-black/20 border border-white/5 rounded-xl">
                        <div className="text-sm text-muted-foreground uppercase tracking-wider mb-2">Estimated Cutoff</div>
                        <div className="text-4xl font-bold font-mono text-primary" data-testid="text-cutoff-estimate">{payload.cutoff_estimate.month}</div>
                        <div className="text-sm text-muted-foreground mt-2 font-mono">
                          95% CI: [{payload.cutoff_estimate.ci_low}, {payload.cutoff_estimate.ci_high}]
                        </div>
                      </div>

                      <div>
                        <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">Knowledge Retention by Month</h4>
                        <div className="h-64" data-testid="chart-monthly-aggregates">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={payload.monthly_aggregates}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                              <XAxis dataKey="month" stroke="rgba(255,255,255,0.3)" fontSize={12} tickLine={false} axisLine={false} />
                              <YAxis stroke="rgba(255,255,255,0.3)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `${(val * 100).toFixed(0)}%`} />
                              <Tooltip 
                                contentStyle={{ backgroundColor: 'hsla(var(--card))', borderColor: 'hsla(var(--border))', borderRadius: '8px' }}
                                itemStyle={{ color: 'hsla(var(--foreground))' }}
                                formatter={(val: number) => [`${(val * 100).toFixed(1)}%`, 'Knew Rate']}
                                labelStyle={{ color: 'hsla(var(--muted-foreground))' }}
                              />
                              <Bar dataKey="knew_rate" fill="hsla(var(--primary))" radius={[4,4,0,0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Probe Results</h4>
                          {!isDev && payload.probe_results.length > 5 && (
                            <span className="text-xs text-muted-foreground">Showing 5 of {payload.probe_results.length}</span>
                          )}
                        </div>
                        <div className="overflow-x-auto border border-white/5 rounded-md">
                          <table className="w-full text-sm text-left" data-testid="table-probe-results">
                            <thead className="bg-black/20 text-muted-foreground text-xs uppercase font-mono">
                              <tr>
                                <th className="px-4 py-3 font-medium">Date</th>
                                <th className="px-4 py-3 font-medium">Question</th>
                                <th className="px-4 py-3 font-medium">Model Answer</th>
                                <th className="px-4 py-3 font-medium text-right">Score</th>
                                <th className="px-4 py-3 font-medium text-center">Knew</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {(isDev ? payload.probe_results : payload.probe_results.slice(0, 5)).map((probe, i) => (
                                <tr key={i} className="hover:bg-white/5">
                                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{probe.date}</td>
                                  <td className="px-4 py-3 max-w-[200px] truncate" title={probe.question}>{probe.question}</td>
                                  <td className="px-4 py-3 max-w-[200px] truncate text-muted-foreground" title={probe.model_answer}>{probe.model_answer}</td>
                                  <td className="px-4 py-3 font-mono text-xs text-right">{probe.judge_score.toFixed(2)}</td>
                                  <td className="px-4 py-3 text-center">
                                    {probe.judge_score >= 0.5 ? 
                                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Yes</Badge> : 
                                      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">No</Badge>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </CardContent>
            )}
          </Card>
        </div>
      )}

    </div>
  );
}

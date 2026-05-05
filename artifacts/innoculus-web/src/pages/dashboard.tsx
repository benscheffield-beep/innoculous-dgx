import { useGetJobStats, getGetJobStatsQueryKey, useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { ArrowRight, Activity, CheckCircle2, FileBox } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function StatCard({ title, value, icon: Icon, description }: { title: string, value: string | number, icon: any, description?: string }) {
  return (
    <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-primary" />
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold font-mono tracking-tight">{value}</div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'complete': return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Complete</Badge>;
    case 'complete_with_warnings': return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Intermediate</Badge>;
    case 'failed': return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">Failed</Badge>;
    case 'queued': return <Badge variant="outline" className="bg-muted text-muted-foreground border-white/10">Queued</Badge>;
    default: return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 animate-pulse">Running</Badge>;
  }
}

export default function Dashboard() {
  // Scope headline metrics to unified innoculations only; legacy single-kind
  // jobs are intentionally excluded from the dashboard's at-a-glance view.
  const statsParams = { kind: "innoculation" as const };
  const { data: stats, isLoading: statsLoading } = useGetJobStats(statsParams, {
    query: { queryKey: getGetJobStatsQueryKey(statsParams), refetchInterval: 5000 }
  });

  // Hide legacy single-kind jobs from at-a-glance views — only the unified
  // `innoculation` runs are surfaced. Direct URLs still work for old jobs.
  const listParams = { page: 1, page_size: 5, kind: "innoculation" as const };
  const { data: jobsResponse, isLoading: jobsLoading } = useListJobs(listParams, {
    query: { queryKey: getListJobsQueryKey(listParams), refetchInterval: 5000 }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Telemetrics</h1>
      </div>

      {statsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 rounded-xl bg-card/50" />)}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Total Innoculations"
            value={stats.total}
            icon={Activity}
            description={`${stats.recent_24h} in last 24h`}
          />
          <StatCard
            title="Pass Rate"
            value={stats.total > 0 ? `${Math.round(((stats.by_verdict?.pass || 0) / (stats.by_verdict?.pass + stats.by_verdict?.fail + stats.by_verdict?.warn || 1)) * 100)}%` : '-'}
            icon={CheckCircle2}
            description={`${stats.by_verdict?.pass || 0} passed`}
          />
          <StatCard
            title="Innoculation Relics"
            value={stats.by_kind?.innoculation || 0}
            icon={FileBox}
            description="Unified Spectral + Speculative"
          />
        </div>
      ) : null}

      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Tracing</CardTitle>
          </div>
          <Link href="/jobs" className="text-sm text-primary hover:underline flex items-center gap-1">
            View All <ArrowRight className="w-4 h-4" />
          </Link>
        </CardHeader>
        <CardContent>
          {jobsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full bg-card" />)}
            </div>
          ) : jobsResponse?.jobs.length ? (
            <div className="divide-y divide-white/5">
              {jobsResponse.jobs.map(job => (
                <Link key={job.id} href={`/jobs/${job.id}`} className="flex items-center justify-between py-4 hover:bg-white/5 px-2 -mx-2 rounded-md transition-colors group cursor-pointer">
                  <div className="flex items-center gap-4">
                    <StatusBadge status={job.status} />
                    <div>
                      <div className="font-mono text-sm font-medium text-foreground">{job.id.split('-')[0]}</div>
                      <div className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wide">innoculation</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-right">
                    <div className="text-xs text-muted-foreground font-mono">
                      {new Date(job.created_at).toLocaleTimeString()}
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              No innoculants found in the innoculum.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

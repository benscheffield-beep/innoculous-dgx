import { useGetJobStats, getGetJobStatsQueryKey, useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { ArrowRight, BarChart3, Activity, AlertCircle, CheckCircle2, Clock, XCircle } from "lucide-react";
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
    case 'complete_with_warnings': return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Warn</Badge>;
    case 'failed': return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">Failed</Badge>;
    case 'queued': return <Badge variant="outline" className="bg-muted text-muted-foreground border-white/10">Queued</Badge>;
    default: return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 animate-pulse">Running</Badge>;
  }
}

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetJobStats({
    query: { queryKey: getGetJobStatsQueryKey(), refetchInterval: 5000 }
  });

  const { data: jobsResponse, isLoading: jobsLoading } = useListJobs({ page: 1, page_size: 5 }, {
    query: { queryKey: getListJobsQueryKey({ page: 1, page_size: 5 }), refetchInterval: 5000 }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="text-muted-foreground mt-2 font-mono text-sm">Pipeline telemetry and system throughput.</p>
      </div>

      {statsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 rounded-xl bg-card/50" />)}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard 
            title="Total Jobs" 
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
            title="Numerical Jobs" 
            value={stats.by_kind?.numerical || 0} 
            icon={BarChart3} 
          />
          <StatCard 
            title="Cutoff Probes" 
            value={stats.by_kind?.cutoff_trace || 0} 
            icon={Clock} 
          />
        </div>
      ) : null}

      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest trace jobs entering the pipeline.</CardDescription>
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
                      <div className="text-xs text-muted-foreground mt-1 capitalize">{job.kind.replace('_', ' ')}</div>
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
              No jobs found in the pipeline.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

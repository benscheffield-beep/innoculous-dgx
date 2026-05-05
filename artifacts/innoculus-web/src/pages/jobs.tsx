import { useState } from "react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ArrowRight, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'complete': return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Complete</Badge>;
    case 'complete_with_warnings': return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Intermediate</Badge>;
    case 'failed': return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">Failed</Badge>;
    case 'queued': return <Badge variant="outline" className="bg-muted text-muted-foreground border-white/10">Queued</Badge>;
    default: return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 animate-pulse">Running</Badge>;
  }
}

export default function Jobs() {
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const { data, isLoading } = useListJobs({ page, page_size: pageSize }, {
    query: { queryKey: getListJobsQueryKey({ page, page_size: pageSize }), refetchInterval: 10000 }
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">All Innoculations</h1>
          <p className="text-muted-foreground mt-2 font-mono text-sm">Historical innoculum execution records.</p>
        </div>
      </div>

      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y divide-white/5">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-6 w-20 rounded" />
                    <div>
                      <Skeleton className="h-4 w-32 mb-2" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : data?.jobs.length ? (
            <div className="divide-y divide-white/5">
              {data.jobs.map(job => (
                <Link key={job.id} href={`/jobs/${job.id}`} className="flex items-center justify-between p-4 hover:bg-white/5 transition-colors group cursor-pointer" data-testid={`row-job-${job.id}`}>
                  <div className="flex items-center gap-4">
                    <div className="w-24">
                      <StatusBadge status={job.status} />
                    </div>
                    <div>
                      <div className="font-mono text-sm font-medium text-primary group-hover:underline">
                        {job.id}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-xs text-muted-foreground bg-white/5 px-2 py-0.5 rounded font-mono uppercase">
                          {job.kind.replace('_', ' ')}
                        </span>
                        {job.retry_count > 0 && (
                          <span className="text-xs text-yellow-500/80 flex items-center gap-1">
                            <Activity className="w-3 h-3" /> Retry #{job.retry_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex flex-col items-end">
                    <div className="text-sm text-foreground">
                      {new Date(job.created_at).toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono mt-1">
                      {new Date(job.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="p-12 text-center text-muted-foreground">
              No jobs found.
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.total > pageSize && (
        <div className="flex items-center justify-between bg-card/30 p-2 rounded-lg border border-white/5">
          <div className="text-sm text-muted-foreground pl-2 font-mono">
            Showing {((page - 1) * pageSize) + 1} - {Math.min(page * pageSize, data.total)} of {data.total}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="bg-background border-white/10"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || isLoading}
            >
              <ArrowLeft className="w-4 h-4 mr-1" /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="bg-background border-white/10"
              onClick={() => setPage(p => p + 1)}
              disabled={page * pageSize >= data.total || isLoading}
            >
              Next <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

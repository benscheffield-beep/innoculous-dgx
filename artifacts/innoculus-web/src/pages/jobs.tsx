import { useState } from "react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ArrowRight, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

type Verdict = 'complete' | 'complete_with_warnings' | 'failed' | 'queued' | 'running';

const VERDICT_COLUMNS: { key: Verdict; label: string; badgeClass: string; headerClass: string }[] = [
  { key: 'complete', label: 'Complete', badgeClass: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', headerClass: 'text-emerald-500' },
  { key: 'complete_with_warnings', label: 'Intermediate', badgeClass: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20', headerClass: 'text-yellow-500' },
  { key: 'running', label: 'Running', badgeClass: 'bg-primary/10 text-primary border-primary/20', headerClass: 'text-primary' },
  { key: 'queued', label: 'Queued', badgeClass: 'bg-muted text-muted-foreground border-white/10', headerClass: 'text-muted-foreground' },
  { key: 'failed', label: 'Failed', badgeClass: 'bg-destructive/10 text-destructive border-destructive/20', headerClass: 'text-destructive' },
];

function bucketOf(status: string): Verdict {
  switch (status) {
    case 'complete':
    case 'complete_with_warnings':
    case 'failed':
    case 'queued':
      return status;
    default:
      return 'running';
  }
}

export default function Jobs() {
  const [page, setPage] = useState(1);
  const pageSize = 30;

  // Hide legacy single-kind jobs from the list. Old direct URLs still resolve.
  const listParams = { page, page_size: pageSize, kind: "innoculation" as const };
  const { data, isLoading } = useListJobs(listParams, {
    query: { queryKey: getListJobsQueryKey(listParams), refetchInterval: 10000 }
  });

  const grouped: Record<Verdict, NonNullable<typeof data>['jobs']> = {
    complete: [],
    complete_with_warnings: [],
    running: [],
    queued: [],
    failed: [],
  };
  if (data?.jobs) {
    for (const j of data.jobs) grouped[bucketOf(j.status)].push(j);
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">All Innoculations</h1>
          <p className="text-muted-foreground mt-2 font-mono text-sm">Innoculant histories</p>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {VERDICT_COLUMNS.map(col => (
            <Card key={col.key} className="bg-card/50 border-white/5 backdrop-blur-sm">
              <CardContent className="p-3 space-y-2">
                <Skeleton className="h-4 w-20 mb-3" />
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : data?.jobs.length ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {VERDICT_COLUMNS.map(col => (
            <Card key={col.key} className="bg-card/50 border-white/5 backdrop-blur-sm flex flex-col">
              <CardContent className="p-3 flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/5">
                  <Badge variant="outline" className={col.badgeClass}>{col.label}</Badge>
                  <span className="text-xs font-mono text-muted-foreground">{grouped[col.key].length}</span>
                </div>
                <div className="space-y-2 flex-1">
                  {grouped[col.key].length === 0 ? (
                    <div className="text-xs text-muted-foreground/60 font-mono italic px-1 py-2">— none —</div>
                  ) : (
                    grouped[col.key].map(job => {
                      const d = new Date(job.created_at);
                      return (
                        <Link
                          key={job.id}
                          href={`/jobs/${job.id}`}
                          className="block p-2.5 rounded-md bg-black/30 border border-white/5 hover:bg-white/5 hover:border-white/10 transition-colors cursor-pointer"
                          data-testid={`row-job-${job.id}`}
                        >
                          <div className="text-sm text-foreground font-medium">
                            {d.toLocaleDateString()}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">
                            {d.toLocaleTimeString()}
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[10px] text-muted-foreground bg-white/5 px-1.5 py-0.5 rounded font-mono uppercase tracking-wide">
                              innoculation
                            </span>
                            {job.retry_count > 0 && (
                              <span className="text-[10px] text-yellow-500/80 flex items-center gap-1">
                                <Activity className="w-3 h-3" /> #{job.retry_count}
                              </span>
                            )}
                          </div>
                        </Link>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
          <CardContent className="p-12 text-center text-muted-foreground">
            No innoculations found.
          </CardContent>
        </Card>
      )}

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

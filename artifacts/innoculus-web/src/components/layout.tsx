import type React from "react";
import { Link, useLocation } from "wouter";
import { useMode } from "@/lib/mode-context";
import { useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { LayoutDashboard, List, Play, Settings, BookOpen } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { InnoculusEmblem } from "@/components/innoculus-emblem";

function HealthIndicator() {
  const { data, isError } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchInterval: 10000,
    }
  });

  const isHealthy = data?.status === "ok" && !isError;

  return (
    <div className="flex items-center gap-2" data-testid="status-health">
      <div className={`w-2 h-2 rounded-full ${isHealthy ? 'bg-primary shadow-[0_0_8px_hsla(0,0%,92%,0.8)]' : 'bg-destructive shadow-[0_0_8px_hsla(11,80%,50%,0.8)]'}`} />
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-mono">
        {isHealthy ? 'SYS OK' : 'SYS ERR'}
      </span>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { mode, setMode } = useMode();

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row w-full bg-background text-foreground font-sans">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-border bg-card/50 flex flex-col">
        <div className="p-6 border-b border-border flex items-center justify-between md:justify-start gap-3">
          <Link href="/" className="flex items-center gap-2 text-primary hover:opacity-80 transition-opacity" data-testid="link-home">
            <InnoculusEmblem className="w-5 h-7" />
            <span className="font-bold tracking-tight text-lg">Innoculus</span>
          </Link>
          <div className="md:hidden">
            <HealthIndicator />
          </div>
        </div>

        <nav className="flex-1 p-4 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-visible">
          <Link href="/dashboard" className={`flex items-center gap-3 px-4 py-3 rounded-md transition-colors ${location === "/dashboard" ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`} data-testid="link-nav-dashboard">
            <LayoutDashboard className="w-4 h-4" />
            <span className="font-medium text-sm">Dashboard</span>
          </Link>
          <Link href="/submit" className={`flex items-center gap-3 px-4 py-3 rounded-md transition-colors ${location === "/submit" ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`} data-testid="link-nav-submit">
            <Play className="w-4 h-4" />
            <span className="font-medium text-sm">Initiate Innoculants</span>
          </Link>
          <Link href="/jobs" className={`flex items-center gap-3 px-4 py-3 rounded-md transition-colors ${location.startsWith("/jobs") ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`} data-testid="link-nav-jobs">
            <List className="w-4 h-4" />
            <span className="font-medium text-sm">All Innoculations</span>
          </Link>
          <Link href="/tutorial" className={`flex items-center gap-3 px-4 py-3 rounded-md transition-colors ${location === "/tutorial" ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`} data-testid="link-nav-tutorial">
            <BookOpen className="w-4 h-4" />
            <span className="font-medium text-sm">Tutorial</span>
          </Link>
        </nav>

        <div className="p-6 border-t border-border mt-auto flex flex-col gap-6">
          <div className="hidden md:block">
            <HealthIndicator />
          </div>
          
          <div className="flex items-center justify-between p-3 rounded-md bg-black/20 border border-white/5">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-muted-foreground" />
              <Label htmlFor="mode-toggle" className="text-sm font-medium cursor-pointer">Operator Mode</Label>
            </div>
            <Switch 
              id="mode-toggle"
              checked={mode === "developer"} 
              onCheckedChange={(c) => setMode(c ? "developer" : "user")}
              data-testid="toggle-dev-mode"
            />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <div className="absolute inset-0 pointer-events-none opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, hsla(var(--primary)/0.3) 1px, transparent 0)', backgroundSize: '32px 32px' }} />
        <div className="flex-1 overflow-y-auto p-4 md:p-8 z-10">
          <div className="max-w-6xl mx-auto w-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

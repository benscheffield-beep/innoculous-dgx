import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModeProvider } from "@/lib/mode-context";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import Splash from "@/pages/splash";
import Dashboard from "@/pages/dashboard";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import Submit from "@/pages/submit";
import Tutorial from "@/pages/tutorial";

const queryClient = new QueryClient();

function ShellRoute({ children }: { children: React.ReactNode }) {
  return <Layout>{children}</Layout>;
}

function Router() {
  return (
    <Switch>
      {/* Splash is a fullscreen entry portal — NO sidebar layout */}
      <Route path="/" component={Splash} />
      {/* All other routes share the dashboard shell */}
      <Route path="/dashboard">
        <ShellRoute><Dashboard /></ShellRoute>
      </Route>
      <Route path="/submit">
        <ShellRoute><Submit /></ShellRoute>
      </Route>
      <Route path="/jobs">
        <ShellRoute><Jobs /></ShellRoute>
      </Route>
      <Route path="/jobs/:id">
        <ShellRoute><JobDetail /></ShellRoute>
      </Route>
      <Route path="/tutorial">
        <ShellRoute><Tutorial /></ShellRoute>
      </Route>
      <Route>
        <ShellRoute><NotFound /></ShellRoute>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ModeProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </ModeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

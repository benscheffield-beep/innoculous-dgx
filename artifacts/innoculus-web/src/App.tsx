import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModeProvider } from "@/lib/mode-context";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import Submit from "@/pages/submit";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/submit" component={Submit} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
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

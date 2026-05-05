import { useLocation } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useCreateJob,
  getListJobsQueryKey,
  getGetJobStatsQueryKey,
  CreateJobRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";

const probeSchema = z.object({
  question: z.string().min(1, "Question is required"),
  answer: z.string().min(1, "Expected answer is required"),
  date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Must be YYYY-MM or YYYY-MM-DD"),
});

const innoculationSchema = z.object({
  model: z.string().min(1, "Target model is required"),
  judge_model: z.string().min(1, "Judge model is required"),
  judge_temperature: z.coerce.number().min(0).max(2),
  probes: z.array(probeSchema).min(1, "At least one probe is required"),
  lambda: z.coerce.number().positive("Latency λ must be > 0"),
  delta: z.coerce.number().nonnegative("Latency δ must be ≥ 0"),
  tnow: z.coerce.number().nonnegative("Tnow must be ≥ 0"),
});

type InnoculationFormValues = z.infer<typeof innoculationSchema>;

// Spectral defaults applied to every innoculation submission. These match the
// pre-simplification form defaults exactly so the spectral phase behaves
// identically to before the form was trimmed.
//
// Q is intentionally fixed (not derived from probe count): the editor's dual-
// index enumeration is exponential in `Q.length` (~67^d at M=32), so coupling
// the lattice dimension to the user-controlled probe count would blow up the
// spectral pipeline as soon as a user added a few probes.
const SPECTRAL_DEFAULTS = {
  kernel: { type: "gaussian" as const, sigma: 1.0 },
  Q: [[1, 0]] as number[][],
  truncation: { M: 32, r: 16 },
  precision: { b: 53, tol: 1e-6 },
};

export default function Submit() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createJob = useCreateJob();

  const form = useForm<InnoculationFormValues>({
    resolver: zodResolver(innoculationSchema),
    defaultValues: {
      model: "gpt-4o",
      judge_model: "gpt-4o-mini",
      judge_temperature: 0.0,
      probes: [{ question: "", answer: "", date: "" }],
      lambda: 1.0,
      delta: 0,
      tnow: 1.0,
    },
  });

  const { fields: probeFields, append: appendProbe, remove: removeProbe } = useFieldArray({
    control: form.control,
    name: "probes",
  });

  const onSubmit = (data: InnoculationFormValues) => {
    const req: CreateJobRequest = {
      kind: "innoculation",
      numerical: {
        kernel: SPECTRAL_DEFAULTS.kernel,
        Q: SPECTRAL_DEFAULTS.Q,
        truncation: SPECTRAL_DEFAULTS.truncation,
        latency: { lambda: data.lambda, delta: data.delta, Tnow: data.tnow },
        precision: SPECTRAL_DEFAULTS.precision,
      },
      cutoff_trace: {
        model: data.model,
        judge_model: data.judge_model,
        judge_temperature: data.judge_temperature,
        probes: data.probes,
      },
    };

    createJob.mutate({ data: req }, {
      onSuccess: (job) => {
        toast({ title: "Innoculation initiated", description: `ID: ${job.id}` });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobStatsQueryKey() });
        setLocation(`/jobs/${job.id}`);
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ title: "Failed to initiate innoculation", description: message, variant: "destructive" });
      },
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Initiate Innoculation</h1>
      </div>

      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardContent className="p-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">

              {/* Models */}
              <section className="space-y-4" data-testid="section-models">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-lg font-semibold">Models</h2>
                  <span className="text-xs text-muted-foreground font-mono uppercase tracking-wide">target &amp; judge</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <FormField control={form.control} name="model" render={({ field }) => (
                    <FormItem><FormLabel>Target Model</FormLabel><FormControl><Input {...field} data-testid="input-cutoff-model" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="judge_model" render={({ field }) => (
                    <FormItem><FormLabel>Judge Model</FormLabel><FormControl><Input {...field} data-testid="input-cutoff-judge-model" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="judge_temperature" render={({ field }) => (
                    <FormItem><FormLabel>Judge Temperature</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-cutoff-judge-temp" /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              </section>

              {/* Latency */}
              <section className="space-y-4" data-testid="section-latency">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-lg font-semibold">Latency Profile</h2>
                  <span className="text-xs text-muted-foreground font-mono uppercase tracking-wide">spectral input</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <FormField control={form.control} name="lambda" render={({ field }) => (
                    <FormItem><FormLabel>Latency Lambda (λ)</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-lambda" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="delta" render={({ field }) => (
                    <FormItem><FormLabel>Latency Delta (δ)</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-delta" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="tnow" render={({ field }) => (
                    <FormItem><FormLabel>Tnow</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-tnow" /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              </section>

              {/* Probes */}
              <section className="space-y-4" data-testid="section-probes">
                <div className="flex items-center justify-between">
                  <div className="flex items-baseline gap-3">
                    <h2 className="text-lg font-semibold">Probes</h2>
                    <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wide">question · expected answer · date</Label>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => appendProbe({ question: "", answer: "", date: "" })} data-testid="button-add-probe">
                    <Plus className="w-4 h-4 mr-1" /> Add Probe
                  </Button>
                </div>

                {form.formState.errors.probes?.root && (
                  <Alert variant="destructive" className="py-2 bg-destructive/10 border-destructive/20 text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{form.formState.errors.probes.root.message}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-4">
                  {probeFields.map((field, index) => (
                    <div key={field.id} className="flex items-start gap-4 p-4 border border-white/5 rounded-md bg-black/20">
                      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4">
                        <FormField control={form.control} name={`probes.${index}.question`} render={({ field: f }) => (
                          <FormItem><FormLabel>Question</FormLabel><FormControl><Input {...f} data-testid={`input-probe-question-${index}`} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name={`probes.${index}.answer`} render={({ field: f }) => (
                          <FormItem><FormLabel>Expected Answer</FormLabel><FormControl><Input {...f} data-testid={`input-probe-answer-${index}`} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name={`probes.${index}.date`} render={({ field: f }) => (
                          <FormItem><FormLabel>Date (YYYY-MM)</FormLabel><FormControl><Input {...f} placeholder="2023-05" data-testid={`input-probe-date-${index}`} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="mt-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => removeProbe(index)} data-testid={`button-remove-probe-${index}`}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </section>

              <Button
                type="submit"
                disabled={createJob.isPending}
                className="w-full"
                data-testid="button-submit-job"
              >
                {createJob.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Initiate Innoculation
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}

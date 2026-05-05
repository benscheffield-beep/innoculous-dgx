import { useState } from "react";
import { useLocation } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMode } from "@/lib/mode-context";
import { 
  useCreateJob, 
  getListJobsQueryKey, 
  getGetJobStatsQueryKey,
  CreateJobRequest
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AlertCircle, Loader2, Plus, Trash2, Settings } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";

const numericalSchema = z.object({
  kernel_type: z.enum(["gaussian", "mellin"]),
  sigma: z.coerce.number().optional(),
  alpha: z.coerce.number().optional(),
  q_matrix: z.string().refine((val) => {
    try {
      const parsed = JSON.parse(val);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      const rowLen = parsed[0].length;
      if (!Array.isArray(parsed[0]) || rowLen === 0) return false;
      for (const row of parsed) {
        if (!Array.isArray(row) || row.length !== rowLen) return false;
        if (!row.every(n => typeof n === 'number')) return false;
      }
      return true;
    } catch {
      return false;
    }
  }, { message: "Must be a valid 2D JSON array of numbers with consistent row lengths" }),
  trunc_m: z.coerce.number().int().min(1),
  trunc_r: z.coerce.number().int().min(1),
  lambda: z.coerce.number(),
  delta: z.coerce.number(),
  tnow: z.coerce.number(),
  prec_b: z.coerce.number().int().min(1),
  prec_tol: z.coerce.number().positive(),
  prec_safety: z.coerce.number().optional(),
  spectral_radius_max: z.coerce.number().optional(),
  cond_limit: z.coerce.number().optional(),
  dual_error_tol: z.coerce.number().optional(),
  spectral_tail_tol: z.coerce.number().optional(),
  warburg_residual_tol: z.coerce.number().optional(),
});

const probeSchema = z.object({
  question: z.string().min(1, "Question is required"),
  answer: z.string().min(1, "Answer is required"),
  date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Must be YYYY-MM or YYYY-MM-DD")
});

const cutoffSchema = z.object({
  model: z.string().min(1, "Model is required"),
  judge_model: z.string().min(1, "Judge model is required"),
  judge_temperature: z.coerce.number().min(0).max(2),
  probes: z.array(probeSchema).min(1, "At least one probe is required"),
  judge_disagreement_max: z.coerce.number().optional(),
  min_probes_per_month: z.coerce.number().int().optional(),
  min_recheck_count: z.coerce.number().int().optional()
});

export default function Submit() {
  const { mode } = useMode();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"numerical" | "cutoff_trace">("numerical");

  const createJob = useCreateJob();

  const numForm = useForm<z.infer<typeof numericalSchema>>({
    resolver: zodResolver(numericalSchema),
    defaultValues: {
      kernel_type: "gaussian",
      sigma: 1.0,
      alpha: 1.0,
      q_matrix: "[[1.0, 0.0]]",
      trunc_m: 32,
      trunc_r: 16,
      lambda: 1.0,
      delta: 0,
      tnow: 1.0,
      prec_b: 53,
      prec_tol: 0.000001,
      spectral_radius_max: undefined,
      cond_limit: undefined,
      dual_error_tol: undefined,
      spectral_tail_tol: undefined,
      warburg_residual_tol: undefined,
    }
  });

  const cutForm = useForm<z.infer<typeof cutoffSchema>>({
    resolver: zodResolver(cutoffSchema),
    defaultValues: {
      model: "gpt-4o",
      judge_model: "gpt-4o-mini",
      judge_temperature: 0.0,
      probes: [{ question: "", answer: "", date: "" }],
      judge_disagreement_max: undefined,
      min_probes_per_month: undefined,
      min_recheck_count: undefined,
    }
  });

  const { fields: probeFields, append: appendProbe, remove: removeProbe } = useFieldArray({
    control: cutForm.control,
    name: "probes"
  });

  const handleNumericalSubmit = (data: z.infer<typeof numericalSchema>) => {
    const req: CreateJobRequest = {
      kind: "numerical",
      kernel: {
        type: data.kernel_type,
        ...(data.kernel_type === "gaussian" ? { sigma: data.sigma } : {}),
        ...(data.kernel_type === "mellin" ? { alpha: data.alpha } : {}),
      },
      Q: JSON.parse(data.q_matrix),
      truncation: { M: data.trunc_m, r: data.trunc_r },
      latency: { lambda: data.lambda, delta: data.delta, Tnow: data.tnow },
      precision: { b: data.prec_b, tol: data.prec_tol, ...(data.prec_safety ? { safety_margin: data.prec_safety } : {}) },
      policy_config: {}
    };

    if (data.spectral_radius_max !== undefined) req.policy_config!.spectral_radius_max = data.spectral_radius_max;
    if (data.cond_limit !== undefined) req.policy_config!.cond_limit = data.cond_limit;
    if (data.dual_error_tol !== undefined) req.policy_config!.dual_error_tol = data.dual_error_tol;
    if (data.spectral_tail_tol !== undefined) req.policy_config!.spectral_tail_tol = data.spectral_tail_tol;
    if (data.warburg_residual_tol !== undefined) req.policy_config!.warburg_residual_tol = data.warburg_residual_tol;

    submitRequest(req);
  };

  const handleCutoffSubmit = (data: z.infer<typeof cutoffSchema>) => {
    const req: CreateJobRequest = {
      kind: "cutoff_trace",
      model: data.model,
      judge_model: data.judge_model,
      judge_temperature: data.judge_temperature,
      probes: data.probes,
      policy_config: {}
    };

    if (data.judge_disagreement_max !== undefined) req.policy_config!.judge_disagreement_max = data.judge_disagreement_max;
    if (data.min_probes_per_month !== undefined) req.policy_config!.min_probes_per_month = data.min_probes_per_month;
    if (data.min_recheck_count !== undefined) req.policy_config!.min_recheck_count = data.min_recheck_count;

    submitRequest(req);
  };

  const submitRequest = (req: CreateJobRequest) => {
    createJob.mutate({ data: req }, {
      onSuccess: (job) => {
        toast({ title: "Job created successfully", description: `ID: ${job.id}` });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobStatsQueryKey() });
        setLocation(`/jobs/${job.id}`);
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ title: "Failed to create job", description: message, variant: "destructive" });
      }
    });
  };

  const isDev = mode === "developer";

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Initiate Innoculants</h1>
        <p className="text-muted-foreground mt-2 font-mono text-sm">Enqueue a new pipeline workload.</p>
      </div>

      <div className="bg-primary/10 border border-primary/20 p-3 rounded-md flex items-center gap-3">
        <Settings className="w-5 h-5 text-primary" />
        <div className="text-sm">
          <span className="font-semibold text-primary capitalize">{mode} Mode</span> is active. 
          {isDev ? " Showing all advanced tuning parameters." : " Showing simplified interface. Toggle mode in the sidebar."}
        </div>
      </div>

      <Card className="bg-card/50 border-white/5 backdrop-blur-sm">
        <CardContent className="p-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList className="mb-6 grid grid-cols-2 bg-black/20">
              <TabsTrigger value="numerical" data-testid="tab-numerical">Numerical</TabsTrigger>
              <TabsTrigger value="cutoff_trace" data-testid="tab-cutoff-trace">Cutoff Trace</TabsTrigger>
            </TabsList>

            <TabsContent value="numerical">
              <Form {...numForm}>
                <form onSubmit={numForm.handleSubmit(handleNumericalSubmit)} className="space-y-6">
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormField
                      control={numForm.control}
                      name="kernel_type"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Kernel Type</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="input-kernel-type">
                                <SelectValue placeholder="Select kernel" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="gaussian">Gaussian</SelectItem>
                              <SelectItem value="mellin">Mellin</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {numForm.watch("kernel_type") === "gaussian" ? (
                      <FormField
                        control={numForm.control}
                        name="sigma"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Sigma</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.1" {...field} data-testid="input-sigma" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    ) : (
                      <FormField
                        control={numForm.control}
                        name="alpha"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Alpha</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.1" {...field} data-testid="input-alpha" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>

                  <FormField
                    control={numForm.control}
                    name="q_matrix"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Q Matrix (JSON array of arrays)</FormLabel>
                        <FormControl>
                          {isDev ? (
                            <Textarea {...field} className="font-mono text-sm min-h-[100px]" data-testid="textarea-q-matrix" />
                          ) : (
                            <Input {...field} className="font-mono" data-testid="textarea-q-matrix" />
                          )}
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {isDev && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <FormField control={numForm.control} name="trunc_m" render={({ field }) => (
                          <FormItem><FormLabel>Truncation M</FormLabel><FormControl><Input type="number" {...field} data-testid="input-trunc-m" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="trunc_r" render={({ field }) => (
                          <FormItem><FormLabel>Truncation r</FormLabel><FormControl><Input type="number" {...field} data-testid="input-trunc-r" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="lambda" render={({ field }) => (
                          <FormItem><FormLabel>Latency Lambda</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-lambda" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="delta" render={({ field }) => (
                          <FormItem><FormLabel>Latency Delta</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-delta" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="tnow" render={({ field }) => (
                          <FormItem><FormLabel>Latency Tnow</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-tnow" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="prec_b" render={({ field }) => (
                          <FormItem><FormLabel>Precision b</FormLabel><FormControl><Input type="number" {...field} data-testid="input-prec-b" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="prec_tol" render={({ field }) => (
                          <FormItem><FormLabel>Precision Tol</FormLabel><FormControl><Input type="number" step="0.000001" {...field} data-testid="input-prec-tol" /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={numForm.control} name="prec_safety" render={({ field }) => (
                          <FormItem><FormLabel>Safety Margin</FormLabel><FormControl><Input type="number" step="0.1" {...field} value={field.value ?? ""} data-testid="input-prec-safety" /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>

                      <Accordion type="single" collapsible className="w-full border border-white/5 rounded-md bg-black/10">
                        <AccordionItem value="policy" className="border-b-0">
                          <AccordionTrigger className="px-4 py-3 hover:bg-white/5">Policy Thresholds</AccordionTrigger>
                          <AccordionContent className="px-4 pb-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                              <FormField control={numForm.control} name="spectral_radius_max" render={({ field }) => (
                                <FormItem><FormLabel>Spectral Radius Max</FormLabel><FormControl><Input placeholder="0.999" type="number" step="0.001" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                              )} />
                              <FormField control={numForm.control} name="cond_limit" render={({ field }) => (
                                <FormItem><FormLabel>Cond Limit</FormLabel><FormControl><Input placeholder="1000000" type="number" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                              )} />
                              <FormField control={numForm.control} name="dual_error_tol" render={({ field }) => (
                                <FormItem><FormLabel>Dual Error Tol</FormLabel><FormControl><Input placeholder="0.000001" type="number" step="0.000001" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                              )} />
                              <FormField control={numForm.control} name="spectral_tail_tol" render={({ field }) => (
                                <FormItem><FormLabel>Spectral Tail Tol</FormLabel><FormControl><Input placeholder="0.000001" type="number" step="0.000001" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                              )} />
                              <FormField control={numForm.control} name="warburg_residual_tol" render={({ field }) => (
                                <FormItem><FormLabel>Warburg Residual Tol</FormLabel><FormControl><Input placeholder="0.05" type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                              )} />
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    </>
                  )}

                  <Button type="submit" disabled={createJob.isPending} className="w-full" data-testid="button-submit-job">
                    {createJob.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Submit Numerical Job
                  </Button>
                </form>
              </Form>
            </TabsContent>

            <TabsContent value="cutoff_trace">
              <Form {...cutForm}>
                <form onSubmit={cutForm.handleSubmit(handleCutoffSubmit)} className="space-y-6">
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormField control={cutForm.control} name="model" render={({ field }) => (
                      <FormItem><FormLabel>Target Model</FormLabel><FormControl><Input {...field} data-testid="input-cutoff-model" /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={cutForm.control} name="judge_model" render={({ field }) => (
                      <FormItem><FormLabel>Judge Model</FormLabel><FormControl><Input {...field} data-testid="input-cutoff-judge-model" /></FormControl><FormMessage /></FormItem>
                    )} />
                    {isDev && (
                      <FormField control={cutForm.control} name="judge_temperature" render={({ field }) => (
                        <FormItem><FormLabel>Judge Temperature</FormLabel><FormControl><Input type="number" step="0.1" {...field} data-testid="input-cutoff-judge-temp" /></FormControl><FormMessage /></FormItem>
                      )} />
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <Label className="text-base">Probes</Label>
                      <Button type="button" variant="outline" size="sm" onClick={() => appendProbe({ question: "", answer: "", date: "" })} data-testid="button-add-probe">
                        <Plus className="w-4 h-4 mr-1" /> Add Probe
                      </Button>
                    </div>

                    {cutForm.formState.errors.probes?.root && (
                      <Alert variant="destructive" className="mb-4 py-2 bg-destructive/10 border-destructive/20 text-destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{cutForm.formState.errors.probes.root.message}</AlertDescription>
                      </Alert>
                    )}

                    <div className="space-y-4">
                      {probeFields.map((field, index) => (
                        <div key={field.id} className="flex items-start gap-4 p-4 border border-white/5 rounded-md bg-black/10">
                          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4">
                            <FormField control={cutForm.control} name={`probes.${index}.question`} render={({ field: f }) => (
                              <FormItem><FormLabel>Question</FormLabel><FormControl><Input {...f} data-testid={`input-probe-question-${index}`} /></FormControl><FormMessage /></FormItem>
                            )} />
                            <FormField control={cutForm.control} name={`probes.${index}.answer`} render={({ field: f }) => (
                              <FormItem><FormLabel>Expected Answer</FormLabel><FormControl><Input {...f} data-testid={`input-probe-answer-${index}`} /></FormControl><FormMessage /></FormItem>
                            )} />
                            <FormField control={cutForm.control} name={`probes.${index}.date`} render={({ field: f }) => (
                              <FormItem><FormLabel>Date (YYYY-MM)</FormLabel><FormControl><Input {...f} placeholder="2023-05" data-testid={`input-probe-date-${index}`} /></FormControl><FormMessage /></FormItem>
                            )} />
                          </div>
                          <Button type="button" variant="ghost" size="icon" className="mt-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => removeProbe(index)} data-testid={`button-remove-probe-${index}`}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {isDev && (
                    <Accordion type="single" collapsible className="w-full border border-white/5 rounded-md bg-black/10">
                      <AccordionItem value="policy" className="border-b-0">
                        <AccordionTrigger className="px-4 py-3 hover:bg-white/5">Policy Thresholds</AccordionTrigger>
                        <AccordionContent className="px-4 pb-4">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
                            <FormField control={cutForm.control} name="judge_disagreement_max" render={({ field }) => (
                              <FormItem><FormLabel>Max Disagreement</FormLabel><FormControl><Input placeholder="0.34" type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                            )} />
                            <FormField control={cutForm.control} name="min_probes_per_month" render={({ field }) => (
                              <FormItem><FormLabel>Min Probes/Month</FormLabel><FormControl><Input placeholder="2" type="number" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                            )} />
                            <FormField control={cutForm.control} name="min_recheck_count" render={({ field }) => (
                              <FormItem><FormLabel>Min Recheck Count</FormLabel><FormControl><Input placeholder="3" type="number" {...field} value={field.value ?? ""} /></FormControl><FormMessage /></FormItem>
                            )} />
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}

                  <Button type="submit" disabled={createJob.isPending} className="w-full" data-testid="button-submit-job">
                    {createJob.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Submit Trace Job
                  </Button>
                </form>
              </Form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

import { useRef, useState, useEffect } from "react";
import { useChatWithDaemon } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Msg = { role: "user" | "assistant"; content: string };

interface DaemonChatProps {
  jobId: string;
}

/**
 * In-component chat surface that talks to POST /jobs/:id/daemon/messages.
 * Per the design decision, history is held only in component state — nothing
 * is persisted server-side and refreshing the page resets the conversation.
 */
export function DaemonChat({ jobId }: DaemonChatProps) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const chat = useChatWithDaemon();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chat.isPending]);

  const send = () => {
    const text = input.trim();
    if (!text || chat.isPending) return;
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    chat.mutate(
      { id: jobId, data: { messages: next } },
      {
        onSuccess: (resp) => {
          setMessages((prev) => [...prev, { role: "assistant", content: resp.content }]);
        },
        onError: (err: unknown) => {
          // Roll back the optimistically-added user turn so they can retry.
          setMessages((prev) => prev.slice(0, -1));
          setInput(text);
          const message = err instanceof Error ? err.message : "Unknown error";
          toast({ title: "Daemon unavailable", description: message, variant: "destructive" });
        },
      },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <Card className="bg-card/50 border-white/5 backdrop-blur-sm" data-testid="card-daemon-chat">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Daemon
        </CardTitle>
        <CardDescription>
          Conditioned on this relic. Conversation is ephemeral — it lives only in this tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          ref={scrollRef}
          className="h-80 overflow-y-auto rounded-md border border-white/5 bg-black/20 p-4 space-y-3"
          data-testid="daemon-chat-log"
        >
          {messages.length === 0 && !chat.isPending ? (
            <div className="text-sm text-muted-foreground italic font-mono">
              Ask the Daemon something about this relic — its cutoff, its spectral diagnostics,
              or its verdicts.
            </div>
          ) : null}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              data-testid={`daemon-msg-${m.role}-${i}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                  m.role === "user"
                    ? "bg-primary/20 border border-primary/30 text-foreground"
                    : "bg-white/5 border border-white/10 text-foreground"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {chat.isPending && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-white/5 border border-white/10 text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Daemon is thinking…
              </div>
            </div>
          )}
        </div>

        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message the Daemon… (Shift+Enter for newline)"
            className="min-h-[60px] resize-none bg-black/20 border-white/10"
            disabled={chat.isPending}
            data-testid="input-daemon-message"
          />
          <Button
            onClick={send}
            disabled={!input.trim() || chat.isPending}
            data-testid="button-daemon-send"
          >
            {chat.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

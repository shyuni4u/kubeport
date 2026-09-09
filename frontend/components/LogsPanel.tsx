"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LogEntry = { id: number; time: number; pod: string; text: string; kind?: "log" | "error" };

type Props = {
  releaseId: string;
  instances: { name: string }[];
  // Instance pre-selected by the page (from `?instance=`), already validated
  // against `instances`. Defaults to "all".
  initialInstance?: string;
};

type Status = "connecting" | "connected" | "disconnected";

const LINE_CAP = 2000;

export function LogsPanel({ releaseId, instances, initialInstance = "all" }: Props) {
  const [instance, setInstance] = useState(initialInstance);
  const [autoscroll, setAutoscroll] = useState(true);
  // Bumped by the reconnect action, and folded into Stream's key so the
  // remount closes the dead EventSource and puts the status dot back to
  // "connecting" by construction, with no setState inside an effect (#46).
  const [attempt, setAttempt] = useState(0);

  // The buffer lives here, above that key: a reconnect must not throw away the
  // lines the reader was looking at, and those are usually the last ones
  // before the drop.
  const [lines, setLines] = useState<LogEntry[]>([]);
  // Monotonic id for stable React keys. Sliced lines (LINE_CAP) keep their
  // original id, so reconciliation only re-renders the new row.
  const seqRef = useRef(0);

  const append = useCallback((entry: Omit<LogEntry, "id">) => {
    seqRef.current += 1;
    const next: LogEntry = { id: seqRef.current, ...entry };
    setLines((prev) => {
      const trimmed = prev.length >= LINE_CAP ? prev.slice(-LINE_CAP + 1) : prev;
      return [...trimmed, next];
    });
  }, []);

  // A different release or instance is a different source, so its lines go.
  // Adjusting state during render on a changed input is React's documented
  // alternative to a setState effect: it re-renders before anything commits.
  const source = `${releaseId}:${instance}`;
  const [lastSource, setLastSource] = useState(source);
  if (source !== lastSource) {
    setLastSource(source);
    setLines([]);
  }

  return (
    <div className="flex flex-col gap-2">
      <Toolbar
        instance={instance}
        onInstanceChange={setInstance}
        instances={instances}
        autoscroll={autoscroll}
        onAutoscrollChange={setAutoscroll}
      >
        <Stream
          key={`${source}:${attempt}`}
          releaseId={releaseId}
          instance={instance}
          autoscroll={autoscroll}
          lines={lines}
          onAppend={append}
          onClear={() => setLines([])}
          onReconnect={() => setAttempt((n) => n + 1)}
        />
      </Toolbar>
    </div>
  );
}

type ToolbarProps = {
  instance: string;
  onInstanceChange: (v: string) => void;
  instances: { name: string }[];
  autoscroll: boolean;
  onAutoscrollChange: (v: boolean) => void;
  children: React.ReactNode;
};

// Toolbar lives in the parent so toggling Auto-scroll / Instance does
// not unmount the stream (Stream uses key= to remount on releaseId or
// instance change). The "Clear" action lives inside Stream.
function Toolbar({
  instance,
  onInstanceChange,
  instances,
  autoscroll,
  onAutoscrollChange,
  children,
}: ToolbarProps) {
  const t = useTranslations("logs");
  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <Select value={instance} onValueChange={(v) => onInstanceChange(v ?? "all")}>
          <SelectTrigger className="w-52">
            {/*
              The label is passed in rather than left to Base UI to infer from
              the matching SelectItem: it cannot resolve one before the popup
              content mounts, so the closed trigger rendered the raw value "all"
              (#46). A pod name happened to survive because the value *is* the
              label.
            */}
            <SelectValue>
              {instance === "all" ? t("allInstances") : instance}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allInstances")}</SelectItem>
            {instances.map((i) => (
              <SelectItem key={i.name} value={i.name}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="ml-auto inline-flex items-center gap-1">
          <Switch checked={autoscroll} onCheckedChange={onAutoscrollChange} />
          {t("autoscroll")}
        </label>
      </div>
      {children}
    </>
  );
}

type StreamProps = {
  releaseId: string;
  instance: string;
  autoscroll: boolean;
  lines: LogEntry[];
  onAppend: (entry: Omit<LogEntry, "id">) => void;
  onClear: () => void;
  onReconnect: () => void;
};

function Stream({
  releaseId,
  instance,
  autoscroll,
  lines,
  onAppend,
  onClear,
  onReconnect,
}: StreamProps) {
  const t = useTranslations("logs");
  const [status, setStatus] = useState<Status>("connecting");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(
      `/api/v1/releases/${releaseId}/logs?instance=${encodeURIComponent(instance)}`,
    );
    const append = onAppend;
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { time: number; pod: string; text: string };
        append({ ...data, kind: "log" });
      } catch {
        /* malformed line — drop */
      }
    });
    // Backend emits named "error" events with {error: string}. EventSource
    // .onerror catches connection errors only, not server-sent named events.
    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { error: string };
        append({ time: Date.now(), pod: "kubeport", text: data.error, kind: "error" });
      } catch {
        /* connection-level error — handled by onerror below */
      }
    });
    es.onopen = () => setStatus("connected");
    es.onerror = () => setStatus("disconnected");
    return () => {
      es.close();
    };
  }, [releaseId, instance, onAppend]);

  useEffect(() => {
    if (!autoscroll) return;
    const el = boxRef.current;
    if (el && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [lines, autoscroll]);

  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <ConnectionDot status={status} />
        {status === "disconnected" && (
          <Button size="sm" variant="outline" onClick={onReconnect}>
            {t("reconnect")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={onClear}
        >
          {t("clear")}
        </Button>
      </div>
      <div
        ref={boxRef}
        className="h-[60vh] overflow-auto rounded bg-slate-950 p-3 font-mono text-[12px] leading-relaxed text-slate-100"
      >
        {lines.length === 0 && (
          <p className="text-slate-400">
            {status === "disconnected" ? t("emptyDisconnected") : t("emptyWaiting")}
          </p>
        )}
        {lines.map((l) => (
          <div
            key={l.id}
            className={`whitespace-pre ${l.kind === "error" ? "text-red-300" : ""}`}
          >
            <span className="text-slate-500">
              [{new Date(l.time).toLocaleTimeString()}]
            </span>{" "}
            <span className="text-cyan-300">[{l.pod}]</span> {l.text}
          </div>
        ))}
      </div>
    </>
  );
}

function ConnectionDot({ status }: { status: Status }) {
  const t = useTranslations("logs.status");
  const color =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-amber-500"
        : "bg-red-500";
  const label = t(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

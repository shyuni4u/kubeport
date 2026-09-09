"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LogEntry = {
  id: number;
  time: number;
  pod: string;
  text: string;
  kind?: "log" | "error";
  // Set on error rows only: the Problem's `title` picks the sentence and
  // `request_id` is what support looks the real reason up by. The backend
  // stopped sending the reason itself (#108).
  errorTitle?: string;
  requestId?: string;
};

// Error kinds the log stream can produce and we have a sentence for. Anything
// else falls back rather than rendering a raw kind at the user.
const KNOWN_STREAM_ERRORS = new Set(["k8s-error", "unauthenticated", "rbac-denied"]);

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

  return (
    <div className="flex flex-col gap-2">
      <Toolbar
        instance={instance}
        onInstanceChange={setInstance}
        instances={instances}
        autoscroll={autoscroll}
        onAutoscrollChange={setAutoscroll}
        streamKey={`${releaseId}:${instance}`}
      >
        <Stream
          key={`${releaseId}:${instance}`}
          releaseId={releaseId}
          instance={instance}
          autoscroll={autoscroll}
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
  streamKey: string;
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
            <SelectValue />
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
};

function Stream({ releaseId, instance, autoscroll }: StreamProps) {
  const t = useTranslations("logs");
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const boxRef = useRef<HTMLDivElement>(null);
  // Monotonic id for stable React keys. Sliced lines (LINE_CAP) keep
  // their original id, so reconciliation only re-renders the new row.
  const seqRef = useRef(0);

  useEffect(() => {
    const es = new EventSource(
      `/api/v1/releases/${releaseId}/logs?instance=${encodeURIComponent(instance)}`,
    );
    const append = (entry: Omit<LogEntry, "id">) => {
      seqRef.current += 1;
      const next: LogEntry = { id: seqRef.current, ...entry };
      setLines((prev) => {
        const trimmed = prev.length >= LINE_CAP ? prev.slice(-LINE_CAP + 1) : prev;
        return [...trimmed, next];
      });
    };
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { time: number; pod: string; text: string };
        append({ ...data, kind: "log" });
      } catch {
        /* malformed line — drop */
      }
    });
    // Backend emits named "error" events carrying a Problem — the same schema
    // as any other error response since #82. EventSource .onerror catches
    // connection errors only, not server-sent named events.
    //
    // Only `title` and `request_id` are rendered. `detail` used to be
    // client-go's raw text, which named the apiserver's address, the namespace
    // and the pod, and this pane showed it to whoever was looking — demo
    // visitors included (#108). The backend now withholds it, and rendering it
    // here anyway would put us back where we started the next time a new kind
    // arrives.
    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { title?: string; request_id?: string };
        append({
          time: Date.now(),
          pod: "kubeport",
          // Text is resolved at render time, not here: this effect must not
          // depend on `t`, or switching locale would tear down the stream.
          text: "",
          kind: "error",
          errorTitle: data.title,
          requestId: data.request_id,
        });
      } catch {
        /* connection-level error — handled by onerror below */
      }
    });
    es.onopen = () => setStatus("connected");
    es.onerror = () => setStatus("disconnected");
    return () => {
      es.close();
    };
  }, [releaseId, instance]);

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
        <button
          type="button"
          onClick={() => setLines([])}
          className="ml-auto rounded border px-2 py-0.5 hover:bg-slate-50"
        >
          {t("clear")}
        </button>
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
            <span className="text-cyan-300">[{l.pod}]</span>{" "}
            {l.kind === "error" ? streamErrorText(t, l) : l.text}
          </div>
        ))}
      </div>
    </>
  );
}

// streamErrorText turns an error frame into the sentence the user reads.
//
// The backend deliberately sends no reason (#108), so all we have is the kind
// and the request id — which is the point: the id is what an admin looks the
// real reason up by, so it belongs on screen rather than buried in devtools.
function streamErrorText(t: ReturnType<typeof useTranslations>, l: LogEntry): string {
  const key = l.errorTitle && KNOWN_STREAM_ERRORS.has(l.errorTitle) ? l.errorTitle : "unknown";
  const message = t(`error.${key}`);
  return l.requestId ? t("error.withId", { message, requestId: l.requestId }) : message;
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebounce } from "use-debounce";

import { findKindSchema, type OpenAPISchemaDoc, type SchemaNode } from "@/lib/openapi";
import {
  resourceKinds,
  validateTemplateYaml,
  type SchemaLookup,
  type TemplateYamlValidation,
} from "@/lib/yaml-validation";

export const VALIDATION_DEBOUNCE_MS = 300;

// The key UI mode remembers its schema cluster under, so both modes check
// against the same cluster.
const CLUSTER_KEY = "kbp:editor-cluster";

// Only a GroupVersion goes into the URL. The BFF validates paths as well
// (#51); this keeps text mid-edit — `apiVersion: ../` — from being requested
// at all.
const GROUP_VERSION = /^(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/)?v\d+(?:(?:alpha|beta)\d+)?$/;

// A resources.yaml with more distinct kinds than this is not a template; the
// rest simply go unchecked against the schema.
const MAX_KINDS = 20;

/**
 * Problems in a YAML-mode template, recomputed a moment after typing stops.
 *
 * Schema type checks (c) need the cluster's OpenAPI documents, fetched the same
 * way UI mode fetches them. Until they arrive — or if they never do — the rest
 * of the checks still run; a missing schema only means fewer warnings.
 *
 * The save handlers must not gate on this result alone: it can be a keystroke
 * behind. They re-run `validateTemplateYaml` on the text they send.
 */
export function useTemplateYamlValidation(resourcesYaml: string, uiSpecYaml: string): TemplateYamlValidation {
  const [resources] = useDebounce(resourcesYaml, VALIDATION_DEBOUNCE_MS);
  const [uiSpec] = useDebounce(uiSpecYaml, VALIDATION_DEBOUNCE_MS);
  const lookup = useSchemaLookup(resources);
  return useMemo(() => validateTemplateYaml(resources, uiSpec, lookup), [resources, uiSpec, lookup]);
}

function useSchemaLookup(resourcesYaml: string): SchemaLookup {
  const [cluster, setCluster] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<Record<string, SchemaNode>>({});
  const requested = useRef(new Set<string>());
  const docs = useRef(new Map<string, Promise<OpenAPISchemaDoc | null>>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/clusters");
        if (!res.ok) return;
        const d = (await res.json()) as { clusters?: Array<{ name: string }> };
        const list = d.clusters ?? [];
        let remembered: string | null = null;
        try {
          remembered = window.sessionStorage.getItem(CLUSTER_KEY);
        } catch {
          // Storage blocked: fall back to the first cluster.
        }
        const pick = remembered && list.some((c) => c.name === remembered) ? remembered : list[0]?.name;
        if (!cancelled && pick) setCluster(pick);
      } catch {
        // No cluster list, no schema checks. Everything else still runs.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const kindsKey = useMemo(() => JSON.stringify(resourceKinds(resourcesYaml).slice(0, MAX_KINDS)), [resourcesYaml]);

  useEffect(() => {
    if (!cluster) return;
    const kinds = JSON.parse(kindsKey) as Array<{ apiVersion: string; kind: string }>;
    for (const { apiVersion, kind } of kinds) {
      const key = `${apiVersion}/${kind}`;
      if (requested.current.has(key) || !GROUP_VERSION.test(apiVersion)) continue;
      requested.current.add(key);
      // One document per GroupVersion: a Deployment and a StatefulSet share it.
      let doc = docs.current.get(apiVersion);
      if (!doc) {
        doc = fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi/${apiVersion}`)
          .then((r) => (r.ok ? (r.json() as Promise<OpenAPISchemaDoc>) : null))
          .catch(() => null);
        docs.current.set(apiVersion, doc);
      }
      void doc.then((d) => {
        if (!d) return;
        const [group, version] = apiVersion.includes("/") ? apiVersion.split("/") : ["", apiVersion];
        const schema = findKindSchema(d, group, version, kind);
        if (schema) setSchemas((prev) => ({ ...prev, [key]: schema }));
      });
    }
  }, [cluster, kindsKey]);

  return useCallback((apiVersion: string, kind: string) => schemas[`${apiVersion}/${kind}`], [schemas]);
}

{{/*
Expand the name of the chart.
*/}}
{{- define "kubeport.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "kubeport.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "kubeport.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "kubeport.labels" -}}
helm.sh/chart: {{ include "kubeport.chart" . }}
{{ include "kubeport.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels (without version — stable across upgrades).
*/}}
{{- define "kubeport.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubeport.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Component-scoped names. Used for Deployments / Services / etc.
*/}}
{{- define "kubeport.backend.fullname" -}}
{{- printf "%s-backend" (include "kubeport.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kubeport.frontend.fullname" -}}
{{- printf "%s-frontend" (include "kubeport.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kubeport.postgres.fullname" -}}
{{- printf "%s-postgres" (include "kubeport.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kubeport.migration.fullname" -}}
{{- printf "%s-migrate" (include "kubeport.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Component-scoped selector labels (adds app.kubernetes.io/component).
*/}}
{{- define "kubeport.backend.selectorLabels" -}}
{{ include "kubeport.selectorLabels" . }}
app.kubernetes.io/component: backend
{{- end -}}

{{- define "kubeport.frontend.selectorLabels" -}}
{{ include "kubeport.selectorLabels" . }}
app.kubernetes.io/component: frontend
{{- end -}}

{{- define "kubeport.postgres.selectorLabels" -}}
{{ include "kubeport.selectorLabels" . }}
app.kubernetes.io/component: postgres
{{- end -}}

{{/*
Component-scoped labels (selectorLabels + version + chart).
*/}}
{{- define "kubeport.backend.labels" -}}
{{ include "kubeport.labels" . }}
app.kubernetes.io/component: backend
{{- end -}}

{{- define "kubeport.frontend.labels" -}}
{{ include "kubeport.labels" . }}
app.kubernetes.io/component: frontend
{{- end -}}

{{- define "kubeport.postgres.labels" -}}
{{ include "kubeport.labels" . }}
app.kubernetes.io/component: postgres
{{- end -}}

{{/*
Image reference helpers.
*/}}
{{- define "kubeport.backend.image" -}}
{{- $tag := .Values.images.backend.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.images.backend.repository $tag -}}
{{- end -}}

{{- define "kubeport.frontend.image" -}}
{{- $tag := .Values.images.frontend.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.images.frontend.repository $tag -}}
{{- end -}}

{{/*
Secret name for shared auth + DB env. Either chart-managed or externally provided.
*/}}
{{- define "kubeport.auth.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{ .Values.auth.existingSecret }}
{{- else -}}
{{ printf "%s-auth" (include "kubeport.fullname" .) }}
{{- end -}}
{{- end -}}

{{/*
DATABASE_URL: in-cluster pg URL when embedded=true, otherwise externalUrl.
Only used at chart-render time to populate the auth Secret. When auth.create=false,
the externally managed Secret must provide DATABASE_URL itself.
*/}}
{{- define "kubeport.databaseUrl" -}}
{{- if .Values.postgres.embedded -}}
{{- $svc := include "kubeport.postgres.fullname" . -}}
{{- printf "postgres://%s:%s@%s:%v/%s?sslmode=disable" .Values.postgres.user .Values.postgres.password $svc .Values.postgres.service.port .Values.postgres.database -}}
{{- else -}}
{{- .Values.postgres.externalUrl -}}
{{- end -}}
{{- end -}}

{{/*
OIDC redirect URI — derived from host if not explicitly set.
*/}}
{{- define "kubeport.oidc.redirectUri" -}}
{{- if .Values.oidc.redirectUri -}}
{{ .Values.oidc.redirectUri }}
{{- else -}}
{{- $scheme := "https" -}}
{{- if not .Values.tls.enabled -}}{{- $scheme = "http" -}}{{- end -}}
{{- printf "%s://%s/api/auth/callback" $scheme .Values.host -}}
{{- end -}}
{{- end -}}

{{- define "kubeport.dex.fullname" -}}
{{- printf "%s-dex" (include "kubeport.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kubeport.dex.issuer" -}}
{{- printf "https://%s" (required "dex.host is required when dex.enabled" .Values.dex.host) -}}
{{- end -}}

{{/* JSON array for KBP_OIDC_ISSUERS: primary + (optional) dex */}}
{{- define "kubeport.oidcIssuersJSON" -}}
{{- $list := list (dict "issuer" .Values.oidc.issuer "client_id" .Values.oidc.audience) -}}
{{- if .Values.dex.enabled -}}
{{- $list = append $list (dict "issuer" (include "kubeport.dex.issuer" .) "client_id" .Values.dex.clientId) -}}
{{- end -}}
{{- $list | toJson -}}
{{- end -}}

{{/* KBP_DEV_ADMIN_EMAILS with demo admin appended when demo is enabled */}}
{{- define "kubeport.devAdminEmails" -}}
{{- $emails := .Values.auth.devAdminEmails -}}
{{- if .Values.demo.enabled -}}
{{- if eq $emails "" -}}
{{- $emails = .Values.demo.adminEmail -}}
{{- else -}}
{{- $emails = printf "%s,%s" $emails .Values.demo.adminEmail -}}
{{- end -}}
{{- end -}}
{{- $emails -}}
{{- end -}}

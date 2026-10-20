{{/*
Chart name (truncated to 63 chars per the k8s name limit).
*/}}
{{- define "herd.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name: <release>-<chart> unless the release name already
contains the chart name (helm convention).
*/}}
{{- define "herd.fullname" -}}
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
Chart label value.
*/}}
{{- define "herd.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Standard labels for every object the chart renders.
*/}}
{{- define "herd.labels" -}}
helm.sh/chart: {{ include "herd.chart" . }}
{{ include "herd.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Labels that select the head-end pod. Must be immutable after install.
*/}}
{{- define "herd.selectorLabels" -}}
app.kubernetes.io/name: {{ include "herd.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
ServiceAccount the head-end (and its kubeswap calls) runs as.
*/}}
{{- define "herd.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "herd.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
ConfigMap holding config.yaml: the chart's own, or an existing one.
*/}}
{{- define "herd.configMapName" -}}
{{- if .Values.config.existing -}}
{{- .Values.config.existing -}}
{{- else -}}
{{- include "herd.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Head-end image reference.

When image.tag is set it is used as-is. When it is unset, the tag is
derived from the chart's app version: unified-vulkan-<appVersion>. The
chart's default values.yaml carries the floating unified-vulkan tag for
dev use; the publish workflow overrides the app version to the release
number (vNNN -> NNN) and leaves the tag unset, so a published release
chart defaults to the versioned docker release tag built from that
release's commit, without the version being codified into the tag
string.
*/}}
{{- define "herd.image" -}}
{{- $tag := .Values.image.tag -}}
{{- if not $tag -}}
{{- $tag = printf "unified-vulkan-%s" .Chart.AppVersion -}}
{{- end -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

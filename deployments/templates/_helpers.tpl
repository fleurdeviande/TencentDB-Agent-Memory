{{/* PostgreSQL resource name; core/knowledge env reference it literally, keep them in sync. */}}
{{- define "agent-memory.postgres.name" -}}
{{- .Values.postgres.name -}}
{{- end }}

{{- define "agent-memory.postgres.labels" -}}
app.kubernetes.io/name: postgres
app.kubernetes.io/instance: {{ include "agent-memory.postgres.name" . }}
app.kubernetes.io/part-of: {{ .Chart.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "agent-memory.postgres.selectorLabels" -}}
app: {{ include "agent-memory.postgres.name" . }}
release: {{ include "agent-memory.postgres.name" . }}
{{- end }}

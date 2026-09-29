# agent-memory on NUE (namespace `devops`)

The pw fork deployed the org way: GitLab CI (`gitlab-ci-commons` `/main-argo.yml`) builds the root
`Dockerfile`, packages `deployments/` and promotes through `Pushwoosh/deployments-state` to ArgoCD.

## What gets deployed

| component | kind | image / role | port | state |
|---|---|---|---|---|
| `agent-memory-core` | Deployment (shared-chart-app alias `core`) | `agent-memory` `core` | 8420 | none: `STORE_MODE=postgres` (rowfs + pgfs + postgres state backend), `/data` is an emptyDir |
| `agent-memory-knowledge` | Deployment (alias `knowledge`) | `agent-memory` `knowledge` | 8424 | PVC `agent-memory-knowledge` (rbd, RWO, 20Gi): Code-Graph checkouts + indexes only |
| `agent-memory-postgres` | StatefulSet (wrapper `templates/`) | `pgvector/pgvector:pg17` | 5432 | PVC `data-agent-memory-postgres-0` (rbd, 20Gi): databases `tdai` (MemoryCore) and `tdai_knowledge` |

Ingress (class nginx, TLS `pushwoosh-com-acme-tls`):

- `https://memory.svc-nue.pushwoosh.com` → core
- `https://memory-knowledge.svc-nue.pushwoosh.com` → knowledge

LLM: GLM-5.3-Flash `http://r4-ai-01.r4h.nue:30001/v1` (keyless, `EMPTY`). Embeddings:
`https://ollama.corp.pushwoosh.com/v1`, `embeddinggemma:latest`, 768 dims. The gateway config is
`global.appConfig.raw` in `deployments/values.yaml` (from `deploy/pw/tdai-gateway.pw.yaml`, host `0.0.0.0`).

One replica each (`values.prod.yaml`). Knowledge has required pod self-affinity so a rolling update lands
on the node that holds its RWO volume; draining that node therefore needs the old pod gone first.

## Secrets (OpenBao, before the first deploy)

KV-v2 mount `team-secrets`, path `team-secrets/devops/agent-memory`, store `openbao-backend`:

| key | used by | note |
|---|---|---|
| `postgres_password` | postgres (`POSTGRES_PASSWORD`), core + knowledge (`PGPASSWORD`) | applied by initdb on the **first** boot only; rotating it later needs `ALTER ROLE tdai PASSWORD …` in the database too |
| `tdai_gateway_api_key` | core `TDAI_GATEWAY_API_KEY` | shared management key; with `TDAI_GATEWAY_SHARED_KEY_MODE=off` it no longer opens the L0–L3 data routes |
| `knowledge_service_key` | knowledge `KNOWLEDGE_SERVICE_KEY` | Bearer for every non-read-only `/v3` endpoint |
| `knowledge_secret_key` | knowledge `KNOWLEDGE_SECRET_KEY` | AES key for stored git credentials, ≥ 32 bytes (`openssl rand -base64 32`); losing it makes stored credentials unreadable |

The apps get the password as `PGPASSWORD` (node-postgres uses it when the URL has none), so the
connection URLs in values carry no secret.

## deployments-state (one MR, before the first tag)

`bootstrap/clusters/nue/devops/agent-memory.yaml`:

```yaml
---
# agent-memory — multi-source: chart from the OCI mirror, values read directly from the
# application's own git repository, both pinned to the same release tag.
# global.appConfig.raw (gateway config) lives in deployments/values.yaml, so $values carries it.
# The three parameters stay mandatory: packaged values omit global.image.* and global.environment.
# targetRevision, the $values revision and global.image.tag are one version, bumped together.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: agent-memory
  namespace: devops
  labels:
    cluster: nue
    ns: devops
spec:
  project: services
  sources:
    - repoURL: perl-harbor.svc-nue.pushwoosh.com/pw-charts
      chart: agent-memory
      targetRevision: &tag v0.1.0
      helm:
        releaseName: agent-memory
        valueFiles:
          - $values/deployments/values.yaml
          - $values/deployments/values.prod.yaml
        parameters:
          - name: global.environment
            value: prod
          - name: global.image.repository
            value: registry-auth.corp.pushwoosh.com/devops/agent-memory
          - name: global.image.tag
            value: *tag
    - repoURL: https://gitlab.corp.pushwoosh.com/DevOps/agent-memory.git
      targetRevision: *tag
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: devops
  syncPolicy:
    automated:
      prune: false
      selfHeal: false
```

`ci/promote_allowlist.yaml`:

```yaml
DevOps/agent-memory:
  prod: bootstrap/clusters/nue/devops/agent-memory.yaml
```

`v0.1.0` stands for the first tag. Argo syncs the file as soon as it is merged, so merge it once that
tag's `Helm Package | Production` has published the chart (earlier = a ComparisonError until it exists).
The promote job refuses a project without the file; if it ran before the merge, retry it — with the tag
already in the file it only waits for convergence. Later tags are bumped by the promote job itself.

## Release

1. OpenBao keys exist.
2. Push a SemVer tag `vX.Y.Z` on `DevOps/agent-memory` → Docker Build + Helm Package, then `Promote | NUE`
   (first release: merge the deployments-state MR in between, see above).
3. Check: `kubectl -n devops get pods -l 'app in (agent-memory-core,agent-memory-knowledge,agent-memory-postgres)'`,
   `curl -fsS https://memory.svc-nue.pushwoosh.com/health`, same for `memory-knowledge`.

Rollback: revert the promote commit in deployments-state (promoting an older tag is refused as
superseded). Postgres data survives: `prune: false`, and StatefulSet PVCs are never deleted by helm.

## First user key

Personal `sk-mem-…` keys are created with the shared key (same call as `deploy/pw/stack.sh admin`):

```bash
KEY="sk-mem-$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
curl -fsS -X POST https://memory.svc-nue.pushwoosh.com/v3/internal/meta/user/init-admin \
  -H "Authorization: Bearer $TDAI_GATEWAY_API_KEY" -H "x-tdai-service-id: default" \
  -H "Content-Type: application/json" -d "{\"username\":\"<login>\",\"user_key\":\"$KEY\"}"
echo "$KEY"   # hand it to the user once
```

## Connecting pw-mcp

Per teammate, after building `pw/mcp` (see `pw/mcp/README.md`):

```bash
export TDAI_URL=https://memory.svc-nue.pushwoosh.com
export KNOWLEDGE_URL=https://memory-knowledge.svc-nue.pushwoosh.com
export TDAI_USER_KEY=sk-mem-...                 # personal key from the step above
export KNOWLEDGE_API_TOKEN=<knowledge_service_key>   # MemoryKnowledge takes only its service key
node dist/cli.js install
```

URLs go without `/v3`. With one active team the team is derived from the key; otherwise set `TDAI_TEAM_ID`.

## Local checks

```bash
docker build -t agent-memory:dev .
docker run --rm -p 8420:8420 -e STORE_MODE=postgres -e POSTGRES_URL=postgres://tdai@host.docker.internal:55432/tdai \
  -e PGPASSWORD=tdai-dev ... agent-memory:dev core      # or `knowledge`
```

Rendering the chart needs `shared-chart-app` v1.7.0 from Harbor (`helm dependency build deployments`,
NUE network only); `deployments/charts/` and `Chart.lock` are gitignored.

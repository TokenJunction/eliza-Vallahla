# Kubernetes deployment templates

These templates are inactive scaffolding, not a production-qualified release.
The base Deployments have zero replicas. The production overlay keeps the
worker and backend at zero replicas, but removes the API replica count and
includes an HPA. Applying the production overlay can start API Pods.
Do not apply it until the activation gates below are satisfied.
Image references use registry.invalid.
No Secrets, image builds, cluster resources, DNS changes, or certificates are provisioned by this commit.

## Layout

- base: Namespace, shared and API configuration, API/worker/backend Deployments, and API/backend ClusterIP Services.
- overlays/production: paper-mode role patches and zero-replica settings.
- overlays/production/ingress.yaml: excluded template until controller class, TLS and DNS are verified.

The worker has no inbound listener and intentionally has no Service.

## Review locally

Run `kubectl kustomize deploy/k8s/base` and `kubectl kustomize deploy/k8s/overlays/production`.
Rendering is not runtime verification. Server-side dry-run requires an authorized target cluster and may require the namespace to exist. No rendering or cluster validation is claimed by this commit.

## Required external configuration

- valhalla-api-secrets: REDIS_URL and VALHALLA_DISPATCH_TOKEN.
- valhalla-worker-redis: REDIS_URL.
- valhalla-eliza-secrets: at least one non-empty OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.
- Production Redis URLs must use rediss://. Producer and worker must target the same intended database and queue namespace. Isolate staging from production.
- Provision credentials securely; do not commit Secret values, private keys or tokens.
- Additional integrations require their own reviewed configuration. Supabase URL/anon key and Upstash REST URL/token must be configured as complete pairs if used.

## Activation gates

1. Review and validate the final queue fix in PR #41.
2. Build component-specific images and add tested digest substitutions in the overlay. API/worker images require repository-root files and dependencies at /app; API also requires site-build. Backend uses valhalla-elizaos/Dockerfile and its default startup validation.
3. Verify UID/GID 1000, filesystem permissions, actual resource sizing, signal propagation and shutdown. Backend writable paths and durable storage remain unqualified; its writable container layer and /tmp are not persistent storage.
4. Implement and verify NetworkPolicies. No network isolation is established by the current manifests.
5. Qualify health checks. API probes establish HTTP responsiveness only. Backend probes establish TCP reachability only. Worker has no application readiness probe. None establishes end-to-end queue or agent readiness.
6. Review namespace Pod Security policy versions against the target Kubernetes minor version; latest follows cluster upgrades.
7. Replace ingressClassName with the installed class, provision valhalla-api-tls, enforce HTTPS at the controller, and approve DNS for api.valhalla-app.xyz before adding ingress.yaml to production resources. Do not change the root GitHub Pages domain. Review auth, CORS preflight and rate limiting.
8. Apply the production overlay only after these gates. The overlay removes
   the API replica count and includes an HPA; worker and backend replicas
   remain zero. API and worker Pod templates enable their queue roles.
   Confirm API bootstrap behavior, worker/backend activation, and end-to-end
   queue processing before treating the deployment as operational.
   Paper mode does not guarantee offline or cost-free model usage.

No automatic apply workflow is included. Applying templates or scaling workloads is a separate deployment action requiring review.

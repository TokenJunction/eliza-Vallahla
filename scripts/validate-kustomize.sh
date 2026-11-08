#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for tool in kustomize kubeconform python3; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
python3 -c 'import yaml' || { echo 'Install PyYAML==6.0.2 before running this script.' >&2; exit 1; }
mkdir -p validation-results
for overlay in base overlays/production; do
  test -s "deploy/k8s/$overlay/kustomization.yaml"
  name="${overlay##*/}"
  kustomize build "deploy/k8s/$overlay" > "validation-results/$name.yaml"
  test -s "validation-results/$name.yaml"
done
kubeconform -strict -summary -verbose -kubernetes-version 1.32.0 validation-results/base.yaml validation-results/production.yaml 2>&1 | tee validation-results/schema-validation.log
python3 - <<'PY' | tee validation-results/safety-validation.log
from pathlib import Path
import yaml

def require(condition, message):
    if not condition:
        raise SystemExit(message)

blockers = []
expected = {'valhalla-api', 'valhalla-worker', 'valhalla-eliza'}
for overlay in ('base', 'production'):
    docs = [d for d in yaml.safe_load_all(Path(f'validation-results/{overlay}.yaml').read_text()) if d]
    deployments = [d for d in docs if d.get('kind') == 'Deployment']
    require(len(deployments) == 3, f'{overlay}: expected exactly three Deployments')
    by_name = {d['metadata']['name']: d for d in deployments}
    require(set(by_name) == expected, f'{overlay}: unexpected Deployment names')
    for name, deployment in by_name.items():
        require(deployment['metadata'].get('namespace') == 'valhalla', f'{overlay}/{name}: wrong namespace')
        spec = deployment['spec']
        if overlay == 'production' and name == 'valhalla-api':
            require('replicas' not in spec, 'production API: replicas must be omitted for HPA ownership')
        else:
            require(spec.get('replicas') == 0, f'{overlay}/{name}: expected zero replicas')
        pod_spec = spec['template']['spec']
        for container in pod_spec.get('initContainers', []) + pod_spec.get('containers', []):
            image = container.get('image', '')
            if not image or any(marker in image.lower() for marker in ('registry.invalid', 'replace-before-activation', 'replace_with', 'your_registry', 'example-org')):
                blockers.append(f'{overlay}/{name}/{container["name"]}: unresolved image reference')
    hpas = [d for d in docs if d.get('kind') == 'HorizontalPodAutoscaler']
    require(len(hpas) == (1 if overlay == 'production' else 0), f'{overlay}: unexpected HPA count')
    if hpas:
        hpa = hpas[0]
        require(hpa['metadata']['name'] == 'valhalla-api' and hpa['metadata'].get('namespace') == 'valhalla', 'production: unexpected HPA identity')
        require(hpa['spec']['scaleTargetRef'] == {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'name': 'valhalla-api'}, 'production: incorrect HPA target')
        require(hpa['spec'].get('minReplicas') == 2 and hpa['spec'].get('maxReplicas') == 6, 'production: HPA bounds changed; review safety contract')
report = ['Activation blockers detected (non-fatal for inactive scaffolding):', *blockers] if blockers else ['No known image placeholders detected; this does not establish deployment readiness.']
Path('validation-results/activation-blockers.txt').write_text('\n'.join(report) + '\n')
print('Rendered replica/HPA safety contracts passed. Production overlay is activation-capable, not inactive.')
print('\n'.join(report))
print('No cluster admission, runtime, credential, or end-to-end validation was performed.')
PY
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '### Kubernetes validation'
    echo 'Rendering, Kubernetes 1.32.0 schemas, and replica/HPA contracts passed. This is not deployment approval.'
    echo
    cat validation-results/activation-blockers.txt
    echo
    echo 'No cluster admission or runtime validation was performed.'
  } >> "$GITHUB_STEP_SUMMARY"
fi

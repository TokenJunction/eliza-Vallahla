export type ReadinessItem = {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
};

export type ServiceHealth = {
  ok: boolean;
  detail: string;
};

export function componentReadiness(service: ServiceHealth): ReadinessItem[] {
  return [
    {
      id: "workspace",
      label: "Workspace shell",
      ready: true,
      detail: "Valhalla Workspace component is loaded.",
    },
    {
      id: "guide",
      label: "Guide",
      ready: true,
      detail: "Setup guide component is loaded.",
    },
    {
      id: "omni",
      label: "Omni command",
      ready: true,
      detail:
        "Command bar is loaded. A task service is separate from this check.",
    },
    {
      id: "services",
      label: "Background services",
      ready: service.ok,
      detail: service.detail,
    },
  ];
}

export async function defaultServiceHealth(): Promise<ServiceHealth> {
  return {
    ok: false,
    detail: "Background services were not reached. Not online.",
  };
}

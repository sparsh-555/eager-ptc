import type { AgentService } from "../agent-service.js";

export interface WorkerLease {
  agentId: string;
  release: () => void;
}

const defaultPoolSize = (): number => {
  const configured = Number.parseInt(process.env.EPTC_POOL_SIZE ?? "6", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 6;
};

export class WorkerPool {
  private readonly idle: string[] = [];
  private readonly waiters: Array<(lease: WorkerLease) => void> = [];
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly service: AgentService,
    private readonly size = defaultPoolSize(),
  ) {}

  async lease(): Promise<WorkerLease> {
    await this.initialize();
    const agentId = this.idle.shift();
    if (agentId) return this.makeLease(agentId);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async initialize(): Promise<void> {
    this.initialization ??= this.createWorkers();
    await this.initialization;
  }

  private async createWorkers(): Promise<void> {
    const existing = new Map(this.service.listAgents().map((agent) => [agent.name, agent]));
    for (let index = 1; index <= this.size; index += 1) {
      const name = "eptc-worker-" + index;
      const agent = existing.get(name) ?? (await this.service.createAgent({
        name,
        description: "Worker used by Eptc plans.",
        instructions: "Complete the assigned subtask and return the result.",
      }));
      this.idle.push(agent.id);
    }
  }

  private makeLease(agentId: string): WorkerLease {
    let released = false;
    return {
      agentId,
      release: () => {
        if (released) return;
        released = true;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(this.makeLease(agentId));
        } else {
          this.idle.push(agentId);
        }
      },
    };
  }
}

export type TaskRunStatus = 'success' | 'failed' | 'skipped';

export interface TaskRunRecord {
  taskId: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result?: unknown;
  error?: string;
}

export interface TaskStatus {
  id: string;
  label: string;
  running: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  nextRunAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastStatus?: TaskRunStatus;
  lastError?: string;
  lastResult?: unknown;
}

export interface TaskDefinition {
  id: string;
  label: string;
  initialDelayMs?: number;
  intervalMs?: number;
  run: () => Promise<unknown> | unknown;
}

interface RegisteredTask extends TaskDefinition {
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  nextRunAt?: string;
  lastRun?: TaskRunRecord;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TaskScheduler {
  private readonly tasks = new Map<string, RegisteredTask>();
  private started = false;

  constructor(private readonly onRunComplete?: (record: TaskRunRecord) => void) {}

  register(definition: TaskDefinition): void {
    if (this.tasks.has(definition.id)) {
      throw new Error(`Task already registered: ${definition.id}`);
    }
    this.tasks.set(definition.id, {
      ...definition,
      running: false,
    });

    if (this.started && definition.intervalMs !== undefined) {
      this.scheduleNext(definition.id, definition.initialDelayMs ?? definition.intervalMs);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks.values()) {
      if (task.intervalMs !== undefined) {
        this.scheduleNext(task.id, task.initialDelayMs ?? task.intervalMs);
      }
    }
  }

  stop(): void {
    this.started = false;
    for (const task of this.tasks.values()) {
      if (task.timer) clearTimeout(task.timer);
      task.timer = undefined;
      task.nextRunAt = undefined;
    }
  }

  listTasks(): TaskStatus[] {
    return [...this.tasks.values()].map((task) => this.toStatus(task));
  }

  getTask(id: string): TaskStatus | null {
    const task = this.tasks.get(id);
    return task ? this.toStatus(task) : null;
  }

  async runNow(id: string): Promise<TaskRunRecord> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return this.runTask(task);
  }

  private scheduleNext(id: string, delayMs: number): void {
    const task = this.tasks.get(id);
    if (!task || !this.started || task.intervalMs === undefined) return;

    if (task.timer) clearTimeout(task.timer);
    const safeDelay = Math.max(0, delayMs);
    task.nextRunAt = new Date(Date.now() + safeDelay).toISOString();
    task.timer = setTimeout(() => {
      task.timer = undefined;
      task.nextRunAt = undefined;
      void this.runTask(task).finally(() => {
        if (this.started && task.intervalMs !== undefined) {
          this.scheduleNext(task.id, task.intervalMs);
        }
      });
    }, safeDelay);
  }

  private async runTask(task: RegisteredTask): Promise<TaskRunRecord> {
    if (task.running) {
      const skippedAt = nowIso();
      return {
        taskId: task.id,
        status: 'skipped',
        startedAt: skippedAt,
        finishedAt: skippedAt,
        durationMs: 0,
        error: 'Task already running',
      };
    }

    task.running = true;
    const startedAtMs = Date.now();
    const startedAt = nowIso();
    try {
      const result = await task.run();
      const finishedAt = nowIso();
      const record: TaskRunRecord = {
        taskId: task.id,
        status: 'success',
        startedAt,
        finishedAt,
        durationMs: Date.now() - startedAtMs,
        result,
      };
      task.lastRun = record;
      this.onRunComplete?.(record);
      return record;
    } catch (err) {
      const finishedAt = nowIso();
      const record: TaskRunRecord = {
        taskId: task.id,
        status: 'failed',
        startedAt,
        finishedAt,
        durationMs: Date.now() - startedAtMs,
        error: errorMessage(err),
      };
      task.lastRun = record;
      this.onRunComplete?.(record);
      return record;
    } finally {
      task.running = false;
    }
  }

  private toStatus(task: RegisteredTask): TaskStatus {
    return {
      id: task.id,
      label: task.label,
      running: task.running,
      intervalMs: task.intervalMs,
      initialDelayMs: task.initialDelayMs,
      nextRunAt: task.nextRunAt,
      lastStartedAt: task.lastRun?.startedAt,
      lastFinishedAt: task.lastRun?.finishedAt,
      lastDurationMs: task.lastRun?.durationMs,
      lastStatus: task.lastRun?.status,
      lastError: task.lastRun?.error,
      lastResult: task.lastRun?.result,
    };
  }
}

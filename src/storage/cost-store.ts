import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export class CostStore {
  private insertStmt: Database.Statement;
  private projectCostStmt: Database.Statement;
  private totalCostStmt: Database.Statement;
  private byProviderStmt: Database.Statement;
  private byModelStmt: Database.Statement;
  private byProjectStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      'INSERT INTO cost_records (id, project_id, provider_id, model_id, prompt_tokens, completion_tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    this.projectCostStmt = db.prepare(
      'SELECT COALESCE(SUM(cost), 0) AS total FROM cost_records WHERE project_id = ?',
    );

    this.totalCostStmt = db.prepare(
      'SELECT COALESCE(SUM(cost), 0) AS total FROM cost_records',
    );

    this.byProviderStmt = db.prepare(
      'SELECT provider_id AS provider, SUM(cost) AS cost FROM cost_records GROUP BY provider_id',
    );

    this.byModelStmt = db.prepare(
      'SELECT provider_id AS provider, model_id AS model, SUM(cost) AS cost FROM cost_records GROUP BY provider_id, model_id',
    );

    this.byProjectStmt = db.prepare(
      'SELECT project_id AS projectId, SUM(cost) AS cost FROM cost_records GROUP BY project_id',
    );
  }

  record(entry: {
    projectId: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  }): void {
    const id = randomUUID();
    this.insertStmt.run(
      id,
      entry.projectId,
      entry.provider,
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      entry.cost,
      new Date().toISOString(),
    );
  }

  getProjectCost(projectId: string): number {
    const row = this.projectCostStmt.get(projectId) as { total: number };
    return row.total;
  }

  getTotalCost(): number {
    const row = this.totalCostStmt.get() as { total: number };
    return row.total;
  }

  getCostBreakdown(): {
    byProvider: { provider: string; cost: number }[];
    byModel: { provider: string; model: string; cost: number }[];
    byProject: { projectId: string; cost: number }[];
  } {
    const byProvider = this.byProviderStmt.all() as { provider: string; cost: number }[];
    const byModel = this.byModelStmt.all() as { provider: string; model: string; cost: number }[];
    const byProject = this.byProjectStmt.all() as { projectId: string; cost: number }[];

    return { byProvider, byModel, byProject };
  }
}

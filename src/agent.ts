import type { DurableObjectState, Env } from '@cloudflare/workers-types';
import { Router } from './Router';
import { StateStore } from './StateStore';
import { JobService } from '../services/JobService';
import { LLMService } from '../services/LLMService';
import { ToolService } from '../services/ToolService';
import { FileService } from '../services/FileService';
import { Quota } from './Quota';

export default class AutonomousAgent {
  private store: StateStore;
  private quota = new Quota();
  private llm: LLMService;
  private tools: ToolService;
  private files: FileService;
  private jobs: JobService;
  private router: Router;

  constructor(private state: DurableObjectState, private env: Env) {
    this.store = new StateStore(state);
    this.llm = new LLMService(env);
    this.tools = new ToolService(env, this.store);
    this.files = new FileService(env);
    this.jobs = new JobService(env, this.store, this.llm, this.tools, this.quota, state);
    this.router = new Router(this);
  }

  /* ---- Cloudflare entry point ---- */
  async fetch(request: Request): Promise<Response> {
    return this.router.handle(request);
  }

  /* ---- thin passthroughs to keep WebSocket contract identical ---- */
  async webSocketMessage(ws: WebSocket, data: string): Promise<void> {
    return this.jobs.handleUserMessage(ws, data);
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.jobs.removeSocket(ws);
  }
  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    this.jobs.removeSocket(ws);
  }
}

export { AutonomousAgent };

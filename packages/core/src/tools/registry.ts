import type { ToolDefinition } from '../provider/types.js';
import type { AnyToolSpec } from './types.js';
import { toolDefinition } from './types.js';

/** The set of tools offered to the model on a given turn. */
export class ToolRegistry {
  private readonly byName = new Map<string, AnyToolSpec>();

  constructor(specs: readonly AnyToolSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: AnyToolSpec): void {
    if (this.byName.has(spec.name)) {
      throw new Error(`Tool "${spec.name}" is already registered`);
    }
    this.byName.set(spec.name, spec);
  }

  get(name: string): AnyToolSpec | undefined {
    return this.byName.get(name);
  }

  list(): AnyToolSpec[] {
    return [...this.byName.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map(toolDefinition);
  }
}

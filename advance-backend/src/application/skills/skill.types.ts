export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly toolIds: readonly string[];
}

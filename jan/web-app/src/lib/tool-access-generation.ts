type Lifecycle<T> = { item: T; scopeKey: string }

type LifecycleCandidate = { commit: () => number }

/** Tracks committed access-section lifecycles so stale requests cannot update a later scope or mount. */
export class CommittedToolAccessGeneration<T> {
  private generation = 0
  private lifecycle: Lifecycle<T> | null = null

  get current(): number { return this.generation }

  candidate(item: T, scopeKey: string): LifecycleCandidate {
    return { commit: () => this.commit(item, scopeKey) }
  }

  commit(item: T, scopeKey: string): number {
    if (!this.lifecycle || this.lifecycle.item !== item || this.lifecycle.scopeKey !== scopeKey) {
      this.generation += 1
      this.lifecycle = { item, scopeKey }
    }
    return this.generation
  }

  invalidateForEvent(): number {
    this.generation += 1
    return this.generation
  }
}

export class CostTracker {
  private spent = 0

  constructor(private readonly budget: number) {}

  canAfford(estimatedCost: number): boolean {
    return this.spent + estimatedCost <= this.budget
  }

  recordSpend(amount: number): void {
    this.spent += amount
  }

  getRemaining(): number {
    return this.budget - this.spent
  }

  getSpent(): number {
    return this.spent
  }

  getSummary(): { spent: number; budget: number; remaining: number } {
    return {
      spent: this.spent,
      budget: this.budget,
      remaining: this.budget - this.spent,
    }
  }
}

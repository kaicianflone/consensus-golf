export class CostTracker {
  private spent = 0

  constructor(private readonly budget: number) {
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(`GPU budget must be a positive number, got: ${budget}`)
    }
  }

  canAfford(estimatedCost: number): boolean {
    return this.spent + estimatedCost <= this.budget
  }

  recordSpend(amount: number): void {
    if (amount < 0) throw new Error(`Cannot record negative spend: ${amount}`)
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

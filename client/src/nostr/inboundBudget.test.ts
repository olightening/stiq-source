import {InboundBudget, WINDOW_MS, BUDGET_MS} from './inboundBudget';

describe('InboundBudget', () => {
  it('starts a fresh window with the full budget available', () => {
    const budget = new InboundBudget();
    expect(budget.remaining(1_000)).toBe(BUDGET_MS);
  });

  it('deducts charged time from what remains within the same window', () => {
    const budget = new InboundBudget();
    budget.remaining(1_000); // opens the window at t=1000
    budget.charge(4);
    expect(budget.remaining(1_000)).toBe(BUDGET_MS - 4);
  });

  it('never lets remaining() go negative, even once more than the full budget is charged', () => {
    const budget = new InboundBudget();
    budget.remaining(1_000);
    budget.charge(BUDGET_MS * 5); // far more than one window ever allows
    expect(budget.remaining(1_000)).toBe(0);
  });

  it('does not roll over before WINDOW_MS has elapsed', () => {
    const budget = new InboundBudget();
    budget.remaining(1_000);
    budget.charge(BUDGET_MS); // exhaust this window
    expect(budget.remaining(1_000 + WINDOW_MS - 1)).toBe(0); // still inside the same window
  });

  it('rolls over to a fresh, fully-refilled window once WINDOW_MS has elapsed', () => {
    const budget = new InboundBudget();
    budget.remaining(1_000);
    budget.charge(BUDGET_MS); // exhaust this window
    expect(budget.remaining(1_000)).toBe(0);
    expect(budget.remaining(1_000 + WINDOW_MS)).toBe(BUDGET_MS); // new window, full budget again
  });

  it('accumulates multiple charges within one window before refusing further spend', () => {
    const budget = new InboundBudget();
    budget.remaining(0);
    budget.charge(3);
    budget.charge(3);
    expect(budget.remaining(0)).toBe(BUDGET_MS - 6);
    budget.charge(BUDGET_MS); // pushes cumulative spend past the budget
    expect(budget.remaining(0)).toBe(0); // clamped, never negative
  });

  it('keeps separate instances fully isolated from each other', () => {
    const a = new InboundBudget();
    const b = new InboundBudget();
    a.remaining(1_000);
    a.charge(BUDGET_MS);
    expect(a.remaining(1_000)).toBe(0);
    expect(b.remaining(1_000)).toBe(BUDGET_MS); // untouched by `a`'s spend
  });
});

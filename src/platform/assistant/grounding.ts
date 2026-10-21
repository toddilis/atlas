// Grounding checks shared by every model surface (briefing, assistant). Pure functions
// with no imports, so the console can bundle them like the pricing calculator. The rule:
// a model's output may carry only numbers that already exist in the deterministic input
// it was shown — it narrates figures, it never produces them.

/** Digit runs, zero-normalized, so "7" cannot hide in "70" and "007" equals "7". */
export const digitTokens = (text: string) => new Set((text.match(/\d+/g) ?? []).map(t => t.replace(/^0+(?=\d)/, '')));

/** Throws when `candidate` contains a digit run that `allowedSource` does not. */
export function assertNumbersGrounded(allowedSource: string, candidate: string, label: string): void {
  const allowed = digitTokens(allowedSource);
  for (const token of digitTokens(candidate)) {
    if (!allowed.has(token)) throw new Error(`${label} rejected: it introduces the number ${token}, which is not in the records it was shown`);
  }
}

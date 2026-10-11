// Text from outside FlyBudget (a bank, a browser's User-Agent) made safe to store and show.

/** Untrusted text: control characters become spaces, runs of spaces collapse, length capped */
export function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

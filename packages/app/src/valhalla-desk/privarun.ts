export const PRIVACY_LIMIT =
  "This pattern filter does not make text fully private. Other sensitive text can pass through. Nothing is uploaded.";

export function filterSensitiveText(input: string): {
  output: string;
  redactions: number;
} {
  const email = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const tokens =
    input.match(/\b(?:sk|pk|api|token|bearer)[_-][A-Za-z0-9]{8,}\b/gi) ?? [];
  const output = input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[removed]")
    .replace(
      /\b(?:sk|pk|api|token|bearer)[_-][A-Za-z0-9]{8,}\b/gi,
      "[removed]",
    );
  return { output, redactions: email.length + tokens.length };
}

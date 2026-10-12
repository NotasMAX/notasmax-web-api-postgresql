export type ResultState = "pending" | "assessed" | "absent";

export function resultScore(state: ResultState, correctAnswers: number | null, totalQuestions: number): number | null {
  if (state === "pending") return null;
  if (state === "absent") return 0;
  if (correctAnswers === null || !Number.isInteger(correctAnswers) || correctAnswers < 0
    || correctAnswers > totalQuestions || !Number.isInteger(totalQuestions) || totalQuestions <= 0) {
    throw new RangeError("Invalid assessed result inputs.");
  }
  return correctAnswers / totalQuestions * 10;
}

export function weightedContribution(score: number | null, weightPercent: number): number | null {
  if (score === null) return null;
  if (!Number.isFinite(score) || !Number.isFinite(weightPercent) || weightPercent < 0 || weightPercent > 100) {
    throw new RangeError("Invalid weighted-result inputs.");
  }
  return score * weightPercent / 100;
}

export function provisionalAverage(weightedPoints: readonly number[], pending: boolean, allocatedWeightPercent: number): {
  value: number | null; provisional: boolean;
} {
  if (allocatedWeightPercent < 0 || allocatedWeightPercent > 100) throw new RangeError("Invalid allocated weight.");
  return {
    value: weightedPoints.length ? weightedPoints.reduce((sum, points) => sum + points, 0) : null,
    provisional: pending || allocatedWeightPercent < 100
  };
}

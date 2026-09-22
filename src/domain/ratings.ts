/** Legacy rating maths (`afterSave Review`): running total, count, average rounded to 1 decimal. */
export function addRating(
  totals: { ratingTotal: number; reviews: number },
  rating: number,
): { ratingTotal: number; reviews: number; rating: number } {
  const ratingTotal = totals.ratingTotal + rating;
  const reviews = totals.reviews + 1;
  return { ratingTotal, reviews, rating: parseFloat((ratingTotal / reviews).toFixed(1)) };
}

/** Legacy rating maths (`afterSave Review`): running total, count, average rounded to 1 decimal. */
export function addRating(
  totals: { ratingTotal: number; reviews: number },
  rating: number,
): { ratingTotal: number; reviews: number; rating: number } {
  const ratingTotal = totals.ratingTotal + rating;
  const reviews = totals.reviews + 1;
  return { ratingTotal, reviews, rating: parseFloat((ratingTotal / reviews).toFixed(1)) };
}

/**
 * The totals recounted from every review a restaurant or driver still has — `recountRatings`
 * (D-24). The same rounding as `addRating`; no reviews is a 0 rating, the value new accounts
 * and restaurants start with (inventory §3.4).
 */
export function recountRating(ratings: number[]): {
  ratingTotal: number;
  reviews: number;
  rating: number;
} {
  const valid = ratings.filter((value) => typeof value === 'number' && Number.isFinite(value));
  const ratingTotal = valid.reduce((sum, value) => sum + value, 0);
  const reviews = valid.length;
  return {
    ratingTotal,
    reviews,
    rating: reviews ? parseFloat((ratingTotal / reviews).toFixed(1)) : 0,
  };
}

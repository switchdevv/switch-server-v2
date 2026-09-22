/** One `city.fees[appType]` entry, as stored on City rows. */
export interface FeeTable {
  initial: number;
  minKms: number;
  perExtraKm: number;
  initialExtra?: number;
  minKmsExtra?: number | null;
}

export interface TripDuration {
  preparationTime: number;
  timePerKm: number;
}

/** Legacy parses the Distance Matrix *display text* ("12.3 km" → 12.3). Q-6: "950 m" → 950. */
export function distanceFromText(text: unknown): number {
  return parseFloat(text as string);
}

export function tripMinutes(distance: number, trip: TripDuration): number {
  return Math.ceil(trip.preparationTime + distance * trip.timePerKm);
}

/**
 * Delivery fee, exactly as legacy `calculateOrder`: round the distance up to the next half km,
 * then apply the one- or two-tier table. `parseInt` truncation is kept (it truncates toward zero
 * and goes through string conversion, like legacy).
 */
export function deliveryFee(distance: number, fees: FeeTable): number {
  let usedDistance = distance;
  const kmDiff = usedDistance - parseInt(String(usedDistance));
  if (kmDiff !== 0 && kmDiff <= 0.5) usedDistance = parseInt(String(usedDistance)) + 0.5;
  else if (kmDiff > 0.5) usedDistance = parseInt(String(usedDistance)) + 1;

  let delivery = fees.initial;
  if (fees.minKmsExtra !== null && fees.minKmsExtra !== undefined) {
    if (usedDistance > fees.minKms && usedDistance <= fees.minKmsExtra) {
      delivery = fees.initialExtra as number;
    } else if (usedDistance > fees.minKmsExtra) {
      const diff = usedDistance - fees.minKmsExtra;
      delivery = (fees.initialExtra as number) + parseInt(String(diff * fees.perExtraKm));
    }
  } else if (usedDistance > fees.minKms) {
    const diff = usedDistance - fees.minKms;
    delivery += parseInt(String(diff * fees.perExtraKm));
  }
  return delivery;
}

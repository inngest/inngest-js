/**
 * GET /api/booking?bookingId=...&origin=...&destination=...&date=...
 *
 * Durable endpoint that executes the booking workflow.
 * Uses inngest.endpoint() with step.run() for automatic retries and memoization.
 */

import { step } from "inngest";
import { inngest } from "@/inngest/client";
import { emitProgress } from "@/inngest/event-store";
import { NextRequest } from "next/server";

// Track retry attempts per booking
const retryTracker = new Map<string, Set<string>>();

/**
 * Helper to emit sub-step progress
 */
function emitSubStep(bookingId: string, stepId: string, message: string) {
  emitProgress(bookingId, {
    type: "step-progress",
    stepId,
    message,
  });
}

/**
 * Simulate work with delay
 */
const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check if this step should fail (first attempt only)
 */
function shouldFail(bookingId: string, stepId: string): boolean {
  if (!retryTracker.has(bookingId)) {
    retryTracker.set(bookingId, new Set());
  }
  const attempted = retryTracker.get(bookingId)!;
  if (attempted.has(stepId)) {
    return false; // Already retried, succeed this time
  }
  attempted.add(stepId);
  return true; // First attempt, fail it
}

export const GET = inngest.endpoint(async (req: NextRequest) => {
  const url = new URL(req.url);
  const bookingId = url.searchParams.get("bookingId");
  const origin = url.searchParams.get("origin") || "NYC";
  const destination = url.searchParams.get("destination") || "LAX";
  const date =
    url.searchParams.get("date") || new Date().toISOString().split("T")[0];

  if (!bookingId) {
    return new Response(JSON.stringify({ error: "bookingId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[Booking ${bookingId}] Starting durable booking workflow...`);

  // ============================================================
  // STEP 1: Search Availability
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "search-availability",
    message: "Starting flight search...",
  });

  const availability = await step.run("search-availability", async () => {
    emitSubStep(
      bookingId,
      "search-availability",
      `Querying airline APIs for ${origin} → ${destination}...`
    );
    await delay(600);

    emitSubStep(
      bookingId,
      "search-availability",
      "Comparing prices across 12 carriers..."
    );
    await delay(800);

    emitSubStep(
      bookingId,
      "search-availability",
      "Filtering by schedule preferences..."
    );
    await delay(500);

    emitSubStep(
      bookingId,
      "search-availability",
      `Found 8 available flights for ${date}`
    );
    await delay(300);

    return {
      available: true,
      flights: [
        { flightNumber: "AA123", price: 299, airline: "American Airlines" },
        { flightNumber: "UA456", price: 349, airline: "United Airlines" },
        { flightNumber: "DL789", price: 279, airline: "Delta" },
      ],
    };
  });

  emitProgress(bookingId, {
    type: "step-complete",
    stepId: "search-availability",
    message: `Found ${availability.flights.length} flights, best price $${availability.flights[2].price}`,
    result: availability,
  });

  // ============================================================
  // STEP 2: Reserve Flight
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "reserve-flight",
    message: "Reserving selected flight...",
  });

  const reservation = await step.run("reserve-flight", async () => {
    const selectedFlight = availability.flights[0];

    emitSubStep(
      bookingId,
      "reserve-flight",
      `Selected ${selectedFlight.airline} ${selectedFlight.flightNumber}`
    );
    await delay(400);

    emitSubStep(bookingId, "reserve-flight", "Checking seat availability...");
    await delay(600);

    emitSubStep(bookingId, "reserve-flight", "Locking seat 14A (window)...");
    await delay(500);

    // Simulate a failure on first attempt - throws error to trigger Inngest retry
    if (shouldFail(bookingId, "reserve-flight")) {
      emitProgress(bookingId, {
        type: "step-error",
        stepId: "reserve-flight",
        message: "Seat lock timeout - Inngest will retry...",
        error: "SEAT_LOCK_TIMEOUT",
        retryCount: 1,
      });
      await delay(500);
      throw new Error(
        "Seat lock timeout: unable to acquire seat lock, please retry"
      );
    }

    emitSubStep(bookingId, "reserve-flight", "Generating PNR record...");
    await delay(400);

    emitSubStep(
      bookingId,
      "reserve-flight",
      "Hold confirmed (expires in 15 min)"
    );
    await delay(300);

    return {
      reservationId: `RES-${Date.now()}`,
      pnr: `${String.fromCharCode(
        65 + Math.floor(Math.random() * 26)
      )}${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
      flightNumber: selectedFlight.flightNumber,
      airline: selectedFlight.airline,
      seat: "14A",
      price: selectedFlight.price,
      status: "reserved",
    };
  });

  emitProgress(bookingId, {
    type: "step-complete",
    stepId: "reserve-flight",
    message: `Reserved ${reservation.airline} ${reservation.flightNumber}, Seat ${reservation.seat}`,
    result: reservation,
  });

  // ============================================================
  // STEP 3: Process Payment
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "process-payment",
    message: "Processing payment...",
  });

  const payment = await step.run("process-payment", async () => {
    emitSubStep(bookingId, "process-payment", "Validating payment method...");
    await delay(500);

    emitSubStep(
      bookingId,
      "process-payment",
      "Connecting to payment gateway..."
    );
    await delay(600);

    emitSubStep(
      bookingId,
      "process-payment",
      `Authorizing charge of $${reservation.price}.00...`
    );
    await delay(800);

    emitSubStep(
      bookingId,
      "process-payment",
      "Verifying with fraud detection..."
    );
    await delay(500);

    emitSubStep(bookingId, "process-payment", "Transaction approved!");
    await delay(300);

    return {
      paymentId: `PAY-${Date.now()}`,
      transactionId: `TXN-${Math.random()
        .toString(36)
        .substring(2, 10)
        .toUpperCase()}`,
      amount: reservation.price,
      currency: "USD",
      status: "completed",
      last4: "4242",
    };
  });

  emitProgress(bookingId, {
    type: "step-complete",
    stepId: "process-payment",
    message: `Charged $${payment.amount}.00 to card ending ${payment.last4}`,
    result: payment,
  });

  // ============================================================
  // STEP 4: Confirm Booking
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "confirm-booking",
    message: "Finalizing booking...",
  });

  const confirmation = await step.run("confirm-booking", async () => {
    emitSubStep(
      bookingId,
      "confirm-booking",
      "Converting hold to confirmed booking..."
    );
    await delay(500);

    emitSubStep(bookingId, "confirm-booking", "Generating e-ticket...");
    await delay(600);

    emitSubStep(
      bookingId,
      "confirm-booking",
      "Adding to frequent flyer account..."
    );
    await delay(400);

    emitSubStep(bookingId, "confirm-booking", "Sending confirmation email...");
    await delay(500);

    emitSubStep(bookingId, "confirm-booking", "Booking confirmed!");
    await delay(200);

    return {
      confirmationNumber: `${reservation.airline
        .substring(0, 2)
        .toUpperCase()}${Date.now().toString().slice(-6)}`,
      eTicketNumber: `${Math.random().toString().slice(2, 15)}`,
      status: "confirmed",
    };
  });

  emitProgress(bookingId, {
    type: "step-complete",
    stepId: "confirm-booking",
    message: `Confirmation #${confirmation.confirmationNumber}`,
    result: confirmation,
  });

  // ============================================================
  // COMPLETE
  // ============================================================
  emitProgress(bookingId, {
    type: "complete",
    message: "Booking complete!",
    result: {
      bookingId,
      pnr: reservation.pnr,
      confirmationNumber: confirmation.confirmationNumber,
      eTicket: confirmation.eTicketNumber,
      flight: `${reservation.airline} ${reservation.flightNumber}`,
      seat: reservation.seat,
      total: `$${payment.amount}.00`,
    },
  });

  console.log(`[Booking ${bookingId}] Booking complete`);

  return new Response(
    JSON.stringify({
      success: true,
      bookingId,
      trip: { origin, destination, date },
      reservation,
      payment,
      confirmation,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
});

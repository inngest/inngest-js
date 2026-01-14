/**
 * Durable Endpoint for booking with SSE progress streaming
 *
 * Uses createExperimentalEndpointWrapper() to make the HTTP handler durable.
 * Streams real-time progress updates via Server-Sent Events.
 */

import { Inngest, step } from "inngest";
import { createExperimentalEndpointWrapper } from "inngest/edge";

const inngest = new Inngest({ id: "trip-booker-backend" });

export const wrap = createExperimentalEndpointWrapper({
  client: inngest,
});

// Type for progress events
export type ProgressEvent = {
  type:
    | "step-start"
    | "step-progress"
    | "step-complete"
    | "step-error"
    | "step-retry"
    | "complete";
  stepId?: string;
  message?: string;
  result?: unknown;
  error?: string;
  retryCount?: number;
  timestamp: string;
};

// Store for active booking progress streams (bookingId -> callback)
const progressStreams = new Map<string, (event: ProgressEvent) => void>();

// Track retry attempts per booking
const retryTracker = new Map<string, Set<string>>();

/**
 * Register a progress callback for a booking
 */
export function onProgress(
  bookingId: string,
  callback: (event: ProgressEvent) => void
) {
  progressStreams.set(bookingId, callback);
  return () => {
    progressStreams.delete(bookingId);
    retryTracker.delete(bookingId);
  };
}

/**
 * Emit a progress event for a booking
 */
function emitProgress(bookingId: string, event: ProgressEvent) {
  const callback = progressStreams.get(bookingId);
  if (callback) callback(event);
}

/**
 * Helper to emit sub-step progress
 */
function emitSubStep(bookingId: string, stepId: string, message: string) {
  emitProgress(bookingId, {
    type: "step-progress",
    stepId,
    message,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Simulate work with delay
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * GET /api/booking?bookingId=...&origin=...&destination=...&date=...
 *
 * The durable endpoint that executes the booking workflow.
 * Client provides bookingId to correlate with SSE events.
 */
export const bookingHandler = wrap(async (req: Request): Promise<Response> => {
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
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
  });

  // ============================================================
  // STEP 2: Reserve Flight
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "reserve-flight",
    message: "Reserving selected flight...",
    timestamp: new Date().toISOString(),
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
        timestamp: new Date().toISOString(),
      });
      await delay(500);
      // Throw error to trigger Inngest's built-in retry mechanism
      throw new Error("Seat lock timeout: unable to acquire seat lock, please retry");
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
    timestamp: new Date().toISOString(),
  });

  // ============================================================
  // STEP 3: Process Payment
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "process-payment",
    message: "Processing payment...",
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
  });

  // ============================================================
  // STEP 4: Confirm Booking
  // ============================================================
  emitProgress(bookingId, {
    type: "step-start",
    stepId: "confirm-booking",
    message: "Finalizing booking...",
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
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

/**
 * GET /api/booking/events?bookingId=...
 *
 * SSE endpoint that streams progress events for a specific booking.
 * Client connects to this before/when calling the durable endpoint.
 */
export async function bookingEventsHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const bookingId = url.searchParams.get("bookingId");

  if (!bookingId) {
    return new Response(JSON.stringify({ error: "bookingId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection event
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "connected", bookingId })}\n\n`
        )
      );

      // Register progress callback for this booking
      const unsubscribe = onProgress(bookingId, (event) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );

        // Close stream on completion or error
        if (event.type === "complete" || event.type === "step-error") {
          setTimeout(() => {
            unsubscribe();
          }, 100);
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

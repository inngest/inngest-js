"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// Generate a UUID for booking correlation
function generateBookingId(): string {
  return `BK-${crypto.randomUUID().slice(0, 8)}`;
}

// Step definitions with labels and icons
const STEPS = [
  { id: "search-availability", label: "Search Flights", icon: "✈️" },
  { id: "reserve-flight", label: "Reserve Flight", icon: "🎫" },
  { id: "process-payment", label: "Process Payment", icon: "💳" },
  { id: "confirm-booking", label: "Confirm Booking", icon: "✅" },
];

// Source code to display (showing complex multi-API orchestration)
const SOURCE_CODE = `export const GET = inngest.endpoint(async (req: NextRequest) => {
  const { bookingId, origin, destination, date } = parseRequest(req);

  // Step 1: Search across multiple airline APIs
  const flights = await step.run("search-availability", async () => {
    const [united, delta, american] = await Promise.all([
      unitedAPI.searchFlights(origin, destination, date),
      deltaAPI.searchFlights(origin, destination, date),
      americanAPI.searchFlights(origin, destination, date),
    ]);
    const allFlights = [...united, ...delta, ...american];
    return allFlights.filter((f) => f.available).sort((a, b) => a.price - b.price);
  });

  // Step 2: Reserve seat with airline's inventory system
  const reservation = await step.run("reserve-flight", async () => {
    const best = flights[0];
    const hold = await best.airline.createHold({
      flightId: best.id,
      seatClass: "economy",
      expiresIn: "15m",
    });
    const seat = await best.airline.assignSeat(hold.id, { preference: "window" });
    return { ...hold, seat: seat.number, airline: best.airline.name };
  });

  // Step 3: Process payment through gateway
  const payment = await step.run("process-payment", async () => {
    const fraud = await fraudService.checkTransaction(bookingId, reservation.price);
    if (fraud.score > 0.8) throw new Error("Transaction flagged");
    const charge = await stripe.charges.create({
      amount: reservation.price * 100,
      currency: "usd",
      source: bookingId,
    });
    return { transactionId: charge.id, amount: reservation.price };
  });

  // Step 4: Finalize booking across systems
  const confirmation = await step.run("confirm-booking", async () => {
    const ticket = await reservation.airline.issueTicket(reservation.holdId);
    await loyaltyService.creditMiles(bookingId, reservation.distance);
    await emailService.send({ to: bookingId, template: "confirmation", data: ticket });
    return { pnr: ticket.pnr, eTicket: ticket.number };
  });

  return Response.json({ success: true, bookingId, confirmation });
});`;

// Line ranges for each step in the source code
const STEP_LINE_RANGES: Record<string, { start: number; end: number }> = {
  "search-availability": { start: 4, end: 12 },
  "reserve-flight": { start: 14, end: 23 },
  "process-payment": { start: 25, end: 35 },
  "confirm-booking": { start: 37, end: 44 },
};

// TypeScript syntax highlighter
function highlightSyntax(code: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const keywords = new Set([
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "async",
    "await",
    "new",
    "export",
    "import",
    "from",
    "true",
    "false",
    "null",
    "undefined",
    "typeof",
    "instanceof",
    "class",
    "extends",
    "implements",
    "interface",
    "type",
    "enum",
    "public",
    "private",
    "protected",
    "static",
    "readonly",
  ]);

  const types = new Set([
    "Request",
    "Response",
    "Promise",
    "URL",
    "Date",
    "console",
    // Domain services & APIs
    "step",
    "unitedAPI",
    "deltaAPI",
    "americanAPI",
    "stripe",
    "fraudService",
    "loyaltyService",
    "emailService",
  ]);

  while (i < code.length) {
    // Comments
    if (code.slice(i, i + 2) === "//") {
      let end = code.indexOf("\n", i);
      if (end === -1) end = code.length;
      tokens.push(
        <span key={key++} className="text-gray-400 italic">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Template literals
    if (code[i] === "`") {
      let end = i + 1;
      while (end < code.length && code[end] !== "`") {
        if (code[end] === "\\") end++;
        end++;
      }
      end++;
      tokens.push(
        <span key={key++} className="text-green-600">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Strings
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      let end = i + 1;
      while (end < code.length && code[end] !== quote) {
        if (code[end] === "\\") end++;
        end++;
      }
      end++;
      tokens.push(
        <span key={key++} className="text-green-600">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Numbers
    if (/\d/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1]))) {
      let end = i;
      while (end < code.length && /[\d.]/.test(code[end])) end++;
      tokens.push(
        <span key={key++} className="text-orange-500">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Words (keywords, types, identifiers)
    if (/[a-zA-Z_$]/.test(code[i])) {
      let end = i;
      while (end < code.length && /[\w$]/.test(code[end])) end++;
      const word = code.slice(i, end);

      if (keywords.has(word)) {
        tokens.push(
          <span key={key++} className="text-purple-600 font-medium">
            {word}
          </span>
        );
      } else if (types.has(word)) {
        tokens.push(
          <span key={key++} className="text-blue-600">
            {word}
          </span>
        );
      } else if (code[end] === "(") {
        // Function call
        tokens.push(
          <span key={key++} className="text-amber-600">
            {word}
          </span>
        );
      } else {
        tokens.push(
          <span key={key++} className="text-gray-800">
            {word}
          </span>
        );
      }
      i = end;
      continue;
    }

    // Operators and punctuation
    if (/[{}()\[\];:,.<>!=+\-*/%&|^~?]/.test(code[i])) {
      tokens.push(
        <span key={key++} className="text-gray-600">
          {code[i]}
        </span>
      );
      i++;
      continue;
    }

    // Whitespace and other
    tokens.push(<span key={key++}>{code[i]}</span>);
    i++;
  }

  return tokens;
}

type StepStatus = "pending" | "running" | "completed" | "error" | "retrying";

type LogEntry = {
  timestamp: string;
  stepId: string;
  type: "start" | "complete" | "error" | "info" | "progress" | "retry";
  message: string;
};

// Popular airports for autocomplete
const AIRPORTS = [
  { code: "NYC", name: "New York", airports: "JFK, LGA, EWR" },
  { code: "LAX", name: "Los Angeles", airports: "LAX" },
  { code: "SFO", name: "San Francisco", airports: "SFO" },
  { code: "ORD", name: "Chicago", airports: "ORD, MDW" },
  { code: "MIA", name: "Miami", airports: "MIA" },
  { code: "DFW", name: "Dallas", airports: "DFW" },
  { code: "SEA", name: "Seattle", airports: "SEA" },
  { code: "BOS", name: "Boston", airports: "BOS" },
];

export default function Home() {
  const [isBooking, setIsBooking] = useState(false);
  const [currentBookingId, setCurrentBookingId] = useState<string | null>(null);
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>(
    () => Object.fromEntries(STEPS.map((s) => [s.id, "pending"]))
  );
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [currentSubStep, setCurrentSubStep] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Reset state for new booking
  const resetState = () => {
    setStepStatuses(Object.fromEntries(STEPS.map((s) => [s.id, "pending"])));
    setActiveStep(null);
    setCurrentSubStep(null);
    setLogs([]);
    setResult(null);
    setError(null);
    setCurrentBookingId(null);
  };

  // Scroll code viewer to active step
  useEffect(() => {
    if (activeStep && codeRef.current) {
      const range = STEP_LINE_RANGES[activeStep];
      if (range) {
        const lineHeight = 20;
        const scrollTo = (range.start - 3) * lineHeight;
        codeRef.current.scrollTo({ top: scrollTo, behavior: "smooth" });
      }
    }
  }, [activeStep]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback(
    (stepId: string, type: LogEntry["type"], message: string) => {
      const timestamp = new Date().toLocaleTimeString();
      setLogs((prev) => [...prev, { timestamp, stepId, type, message }]);
    },
    []
  );

  // Process events from polling response
  const processEvents = useCallback(
    (events: any[]) => {
      for (const data of events) {
        if (data.type === "step-start") {
          setActiveStep(data.stepId);
          setCurrentSubStep(null);
          setStepStatuses((prev) => ({ ...prev, [data.stepId]: "running" }));
          addLog(
            data.stepId,
            "start",
            data.message || `${data.stepId}: started`
          );
        } else if (data.type === "step-progress") {
          setCurrentSubStep(data.message);
          addLog(
            data.stepId,
            "progress",
            data.message || `${data.stepId}: processing...`
          );
        } else if (data.type === "step-retry") {
          addLog(
            data.stepId,
            "retry",
            `⚠️ ${data.message || "Retrying..."} (attempt ${data.retryCount})`
          );
        } else if (data.type === "step-complete") {
          setStepStatuses((prev) => ({ ...prev, [data.stepId]: "completed" }));
          setCurrentSubStep(null);
          addLog(
            data.stepId,
            "complete",
            data.message || `${data.stepId}: completed`
          );
        } else if (data.type === "step-error") {
          if (data.retryCount) {
            setStepStatuses((prev) => ({
              ...prev,
              [data.stepId]: "retrying",
            }));
            addLog(
              data.stepId,
              "retry",
              `⚠️ ${data.message || data.error} (attempt ${data.retryCount}, Inngest retrying...)`
            );
          } else {
            setStepStatuses((prev) => ({ ...prev, [data.stepId]: "error" }));
            setError(data.error);
            addLog(
              data.stepId,
              "error",
              `${data.stepId}: ERROR - ${data.error}`
            );
            setIsBooking(false);
          }
        } else if (data.type === "complete") {
          setResult(data.result);
          setActiveStep(null);
          setCurrentSubStep(null);
          setIsBooking(false);
          addLog("done", "complete", data.message || "Booking complete!");
        }
      }
    },
    [addLog]
  );

  const handleBooking = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    resetState();
    setIsBooking(true);

    const formData = new FormData(e.currentTarget);
    const origin = formData.get("origin") as string;
    const destination = formData.get("destination") as string;
    const date = formData.get("date") as string;

    // 1. Generate booking ID
    const bookingId = generateBookingId();
    setCurrentBookingId(bookingId);
    addLog("init", "info", `Generated booking ID: ${bookingId}`);

    // 2. Start the durable endpoint (non-blocking)
    addLog("init", "info", `Starting durable endpoint...`);
    fetch(
      `/api/booking?bookingId=${encodeURIComponent(bookingId)}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&date=${encodeURIComponent(date)}`
    )
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) {
          setError(data.error || "Booking failed");
        }
      })
      .catch((err) => {
        setError(err.message);
        setIsBooking(false);
      });

    // 3. Poll for progress events
    let cursor = 0;
    let polling = true;

    const poll = async () => {
      while (polling) {
        try {
          const res = await fetch(
            `/api/booking/events?bookingId=${encodeURIComponent(bookingId)}&cursor=${cursor}`
          );
          const data = await res.json();

          if (data.events && data.events.length > 0) {
            processEvents(data.events);
          }
          cursor = data.cursor;

          if (data.status === "complete" || data.status === "error") {
            polling = false;
            break;
          }
        } catch {
          // Ignore polling errors, will retry
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    poll();
  };

  // Render status indicator
  const getStatusIndicator = (stepId: string) => {
    const status = stepStatuses[stepId];
    const isActive = activeStep === stepId;

    if (status === "completed") {
      return (
        <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
      );
    }
    if (status === "error") {
      return (
        <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </div>
      );
    }
    if (status === "retrying") {
      return (
        <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-white animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </div>
      );
    }
    if (isActive) {
      return (
        <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center">
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
        <div className="w-3 h-3 rounded-full bg-gray-400" />
      </div>
    );
  };

  // Render code with line highlighting
  const renderCode = () => {
    const lines = SOURCE_CODE.split("\n");

    // Determine line status based on step statuses
    const getLineStatus = (
      lineNum: number
    ): "completed" | "running" | "error" | "retrying" | null => {
      for (const [stepId, range] of Object.entries(STEP_LINE_RANGES)) {
        if (lineNum >= range.start && lineNum <= range.end) {
          const status = stepStatuses[stepId];
          if (status === "error") return "error";
          if (status === "retrying") return "retrying";
          if (status === "completed") return "completed";
          if (status === "running") return "running";
        }
      }
      return null;
    };

    return lines.map((line, index) => {
      const lineNum = index + 1;
      const lineStatus = getLineStatus(lineNum);

      let className = "flex ";
      let borderClass = "";

      if (lineStatus === "error") {
        className += "bg-red-100";
        borderClass = "border-l-2 border-red-500";
      } else if (lineStatus === "retrying") {
        className += "bg-orange-100";
        borderClass = "border-l-2 border-orange-500 animate-pulse";
      } else if (lineStatus === "running") {
        className += "bg-blue-50";
        borderClass = "border-l-2 border-blue-500";
      } else if (lineStatus === "completed") {
        className += "bg-green-50";
        borderClass = "border-l-2 border-green-500";
      }

      return (
        <div key={lineNum} className={`${className} ${borderClass}`}>
          <span className="w-10 text-right pr-3 text-gray-400 select-none text-xs">
            {lineNum}
          </span>
          <span className="flex-1 whitespace-pre">{highlightSyntax(line)}</span>
        </div>
      );
    });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header - Travel Website Style */}
      <header className="bg-gradient-to-r from-blue-600 to-blue-800 text-white">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center">
                <span className="text-2xl">✈️</span>
              </div>
              <div>
                <h1 className="text-xl font-bold">SkyBook</h1>
                <p className="text-blue-200 text-xs">
                  Powered by Durable Endpoints
                </p>
              </div>
            </div>
            {currentBookingId && (
              <div className="bg-white/10 rounded-lg px-4 py-2">
                <span className="text-blue-200 text-sm">
                  Booking Reference:{" "}
                </span>
                <span className="font-mono font-bold">{currentBookingId}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content - Split layout */}
      <div className="flex h-[calc(100vh-72px)]">
        {/* Left Panel - Booking UI */}
        <div className="w-1/2 overflow-auto bg-white border-r border-gray-200">
          {/* Search Form */}
          <div className="bg-gradient-to-b from-blue-600 to-blue-700 px-6 py-8">
            <form onSubmit={handleBooking} className="max-w-lg mx-auto">
              <div className="bg-white rounded-xl shadow-xl p-6">
                <h2 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
                  <span>🔍</span> Search Flights
                </h2>

                <div className="space-y-4">
                  {/* Origin & Destination */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">
                        From
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                            />
                          </svg>
                        </span>
                        <select
                          name="origin"
                          disabled={isBooking}
                          className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed appearance-none bg-white"
                        >
                          {AIRPORTS.map((apt) => (
                            <option key={apt.code} value={apt.code}>
                              {apt.code} - {apt.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">
                        To
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                            />
                          </svg>
                        </span>
                        <select
                          name="destination"
                          defaultValue="LAX"
                          disabled={isBooking}
                          className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed appearance-none bg-white"
                        >
                          {AIRPORTS.map((apt) => (
                            <option key={apt.code} value={apt.code}>
                              {apt.code} - {apt.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Date */}
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Departure Date
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </span>
                      <input
                        type="date"
                        name="date"
                        defaultValue={new Date().toISOString().split("T")[0]}
                        required
                        disabled={isBooking}
                        className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                      />
                    </div>
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={isBooking}
                    className="w-full bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 disabled:from-gray-400 disabled:to-gray-500 text-white py-4 rounded-lg font-bold text-lg transition-all shadow-lg hover:shadow-xl disabled:shadow-none disabled:cursor-not-allowed"
                  >
                    {isBooking ? (
                      <span className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Processing...
                      </span>
                    ) : (
                      "Search & Book"
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Progress Section */}
          <div className="p-6">
            <div className="max-w-lg mx-auto">
              <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                <span>📋</span> Booking Progress
              </h3>

              <div className="space-y-1">
                {STEPS.map((step, index) => {
                  const isActive = activeStep === step.id;
                  const isCompleted = stepStatuses[step.id] === "completed";
                  const isRetrying = stepStatuses[step.id] === "retrying";
                  const isError = stepStatuses[step.id] === "error";
                  const showSubStep = isActive && currentSubStep;

                  return (
                    <div key={step.id}>
                      <div
                        className={`flex items-center gap-4 p-4 rounded-xl transition-all ${
                          isError
                            ? "bg-red-50 border border-red-200"
                            : isRetrying
                              ? "bg-orange-50 border border-orange-200 animate-pulse"
                              : isActive
                                ? "bg-blue-50 border border-blue-200"
                                : isCompleted
                                  ? "bg-green-50"
                                  : "bg-gray-50"
                        }`}
                      >
                        {/* Status Indicator */}
                        {getStatusIndicator(step.id)}

                        {/* Step Info */}
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{step.icon}</span>
                            <span
                              className={`font-medium ${
                                isError
                                  ? "text-red-700"
                                  : isRetrying
                                    ? "text-orange-700"
                                    : isActive
                                      ? "text-blue-700"
                                      : isCompleted
                                        ? "text-green-700"
                                        : "text-gray-600"
                              }`}
                            >
                              {step.label}
                              {isRetrying && " (retrying...)"}
                            </span>
                          </div>
                          {showSubStep && (
                            <p className="text-sm text-blue-600 mt-1 ml-7 animate-pulse">
                              {currentSubStep}
                            </p>
                          )}
                          {isRetrying && (
                            <p className="text-sm text-orange-600 mt-1 ml-7">
                              Inngest is automatically retrying this step...
                            </p>
                          )}
                        </div>

                        {/* Connection Line */}
                        {index < STEPS.length - 1 && (
                          <div className="absolute left-10 mt-16 w-0.5 h-4 " />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Result Card */}
              {result && (
                <div className="mt-6 bg-gradient-to-r from-green-500 to-green-600 rounded-xl p-6 text-white shadow-lg">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
                      <span className="text-2xl">🎉</span>
                    </div>
                    <div>
                      <h3 className="text-xl font-bold">Booking Confirmed!</h3>
                      <p className="text-green-100">Your trip is all set</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 bg-white/10 rounded-lg p-4">
                    <div>
                      <p className="text-green-200 text-sm">Confirmation</p>
                      <p className="font-bold text-lg">
                        {result.confirmationNumber}
                      </p>
                    </div>
                    <div>
                      <p className="text-green-200 text-sm">PNR</p>
                      <p className="font-bold text-lg font-mono">
                        {result.pnr}
                      </p>
                    </div>
                    <div>
                      <p className="text-green-200 text-sm">Flight</p>
                      <p className="font-bold">{result.flight}</p>
                    </div>
                    <div>
                      <p className="text-green-200 text-sm">Seat</p>
                      <p className="font-bold">{result.seat}</p>
                    </div>
                    <div>
                      <p className="text-green-200 text-sm">E-Ticket</p>
                      <p className="font-mono text-sm">{result.eTicket}</p>
                    </div>
                    <div>
                      <p className="text-green-200 text-sm">Total</p>
                      <p className="font-bold text-lg">{result.total}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Error Card */}
              {error && !result && (
                <div className="mt-6 bg-red-50 border border-red-200 rounded-xl p-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
                      <span className="text-xl">❌</span>
                    </div>
                    <div>
                      <h3 className="font-bold text-red-800">Booking Error</h3>
                      <p className="text-red-600">{error}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel - Code Viewer */}
        <div className="w-1/2 flex flex-col bg-white">
          {/* Code Header */}
          <div className="bg-gray-100 border-b border-gray-200 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-400"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
                <div className="w-3 h-3 rounded-full bg-green-400"></div>
              </div>
              <span className="text-gray-38 text-sm font-medium">
                <code>GET /api/booking</code>
              </span>
            </div>
            <span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded font-medium">
              Durable Endpoint
            </span>
          </div>

          {/* Code Content */}
          <pre
            ref={codeRef}
            className="flex-1 overflow-auto bg-gray-50 p-4 font-mono text-sm leading-5 text-gray-800"
          >
            <code>{renderCode()}</code>
          </pre>

          {/* Execution Log */}
          <div className="h-48 bg-white border-t border-gray-200 flex flex-col">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                Execution Log
              </span>
              {logs.length > 0 && (
                <button
                  onClick={resetState}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto p-3 font-mono text-xs bg-gray-50">
              {logs.length === 0 ? (
                <div className="text-gray-400 p-2">
                  Waiting for booking request...
                </div>
              ) : (
                <>
                  {logs.map((log, i) => (
                    <div
                      key={i}
                      className={`py-0.5 ${
                        log.type === "error"
                          ? "text-red-600"
                          : log.type === "complete"
                            ? "text-green-600"
                            : log.type === "info"
                              ? "text-blue-600"
                              : log.type === "retry"
                                ? "text-orange-500"
                                : log.type === "progress"
                                  ? "text-gray-500"
                                  : "text-gray-700"
                      }`}
                    >
                      <span className="text-gray-400">[{log.timestamp}]</span>{" "}
                      {log.message}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

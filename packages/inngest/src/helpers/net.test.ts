import { vi } from "vitest";
import createFetchMock from "vitest-fetch-mock";
import { fetchWithAuthFallback } from "./net.ts";

const fetchMock = createFetchMock(vi);

describe("fetchWithAuthFallback", () => {
  beforeEach(() => {
    fetchMock.resetMocks();
  });

  it("should make a fetch request with the provided auth token", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ data: "12345" }));

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com", {
      headers: {
        Authorization: "Bearer testToken",
      },
    });
    expect(response.status).toEqual(200);
  });

  it("should retry with the fallback token if the first request fails with 401", async () => {
    fetchMock.mockResponses(
      [JSON.stringify({}), { status: 401 }],
      [JSON.stringify({ data: "12345" }), { status: 200 }],
    );

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      authTokenFallback: "fallbackToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.com", {
      headers: {
        Authorization: "Bearer testToken",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com", {
      headers: {
        Authorization: "Bearer fallbackToken",
      },
    });
    expect(response.status).toEqual(200);
  });

  it("should not retry with the fallback token if the first request fails with a non-401/403 status", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({}), { status: 500 });

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      authTokenFallback: "fallbackToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toEqual(500);
  });
});
